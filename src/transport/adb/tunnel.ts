import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { Client as SSHClient } from "ssh2";

export interface TunnelParams {
  sshUser: string;
  sshHost: string;
  sshPort: number;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface TunnelHandle {
  localPort: number;
  adbSerial: string;
  close: () => void;
}

export interface DetachedTunnelHandle {
  localPort: number;
  adbSerial: string;
  pid: number;
}

const SSH_USER_HOST = /ssh\s+\S+\s+(\S+)@(\S+)\s+-p\s+(\d+)/;
const SSH_FORWARD = /-L\s+(\d+):([^:]+):(\d+)/;

export function parseSshCommand(command: string): TunnelParams | null {
  const userHost = command.match(SSH_USER_HOST);
  const forward = command.match(SSH_FORWARD);
  if (!(userHost && forward)) return null;

  return {
    sshUser: userHost[1],
    sshHost: userHost[2],
    sshPort: Number.parseInt(userHost[3], 10),
    localPort: Number.parseInt(forward[1], 10),
    remoteHost: forward[2],
    remotePort: Number.parseInt(forward[3], 10),
  };
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Create an SSH tunnel using the ssh2 library (pure JS — works on all platforms).
 * The cloud API returns a password for SSH auth.
 */
export function startTunnel(
  deviceId: string,
  params: TunnelParams,
  sshPassword: string,
): Promise<TunnelHandle> {
  if (process.platform !== "win32") {
    return startOpenSshTunnel(deviceId, params, sshPassword).catch(() =>
      startSsh2Tunnel(deviceId, params, sshPassword)
    );
  }
  return startSsh2Tunnel(deviceId, params, sshPassword);
}

function startOpenSshTunnel(
  _deviceId: string,
  params: TunnelParams,
  sshPassword: string,
): Promise<TunnelHandle> {
  return new Promise(async (resolve, reject) => {
    const localPort = await findFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "handheld-ssh-"));
    const askpassPath = join(tempDir, "askpass.sh");
    const escaped = sshPassword.replace(/'/g, `'\"'\"'`);
    writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s' '${escaped}'\n`);
    chmodSync(askpassPath, 0o700);

    let stderr = "";
    const ssh = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=no",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "PasswordAuthentication=yes",
        "-o",
        "HostKeyAlgorithms=+ssh-rsa",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-p",
        String(params.sshPort),
        "-L",
        `127.0.0.1:${localPort}:${params.remoteHost}:${params.remotePort}`,
        `${params.sshUser}@${params.sshHost}`,
        "-N",
      ],
      {
        env: {
          ...process.env,
          DISPLAY: "127.0.0.1:0",
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: "force",
          SSH_AUTH_SOCK: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    const cleanup = () => {
      try {
        ssh.kill("SIGTERM");
      } catch {}
      try {
        rmSync(tempDir, { force: true, recursive: true });
      } catch {}
    };

    ssh.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
    });

    const timeout = Date.now() + 15_000;
    while (Date.now() < timeout) {
      if (ssh.exitCode !== null) {
        cleanup();
        reject(
          new Error(
            `OpenSSH tunnel failed: ${stderr.trim() || `exit ${ssh.exitCode}`}`
          )
        );
        return;
      }
      if (await probePort(localPort)) {
        resolve({
          localPort,
          adbSerial: `127.0.0.1:${localPort}`,
          close: () => {
            cleanup();
          },
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    cleanup();
    reject(new Error(`OpenSSH tunnel timed out after 15s: ${stderr.trim()}`));
  });
}

export async function startDetachedTunnel(
  _deviceId: string,
  params: TunnelParams,
  sshPassword: string,
): Promise<DetachedTunnelHandle> {
  const localPort = await findFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "handheld-ssh-"));
  const askpassPath = join(tempDir, "askpass.sh");
  const escaped = sshPassword.replace(/'/g, `'\"'\"'`);
  writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s' '${escaped}'\n`);
  chmodSync(askpassPath, 0o700);

  let stderr = "";
  const ssh = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "HostKeyAlgorithms=+ssh-rsa",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-p",
      String(params.sshPort),
      "-L",
      `127.0.0.1:${localPort}:${params.remoteHost}:${params.remotePort}`,
      `${params.sshUser}@${params.sshHost}`,
      "-N",
    ],
    {
      detached: true,
      env: {
        ...process.env,
        DISPLAY: "127.0.0.1:0",
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: "force",
        SSH_AUTH_SOCK: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );

  ssh.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });

  const cleanup = () => {
    try {
      process.kill(ssh.pid!, "SIGTERM");
    } catch {}
    try {
      rmSync(tempDir, { force: true, recursive: true });
    } catch {}
  };

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (ssh.exitCode !== null) {
      cleanup();
      throw new Error(
        `OpenSSH tunnel failed: ${stderr.trim() || `exit ${ssh.exitCode}`}`
      );
    }
    if (await probePort(localPort)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!(await probePort(localPort))) {
    cleanup();
    throw new Error(`OpenSSH tunnel timed out after 15s: ${stderr.trim()}`);
  }

  (ssh.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  try {
    rmSync(tempDir, { force: true, recursive: true });
  } catch {}
  ssh.unref();

  return {
    localPort,
    adbSerial: `127.0.0.1:${localPort}`,
    pid: ssh.pid!,
  };
}

function startSsh2Tunnel(
  _deviceId: string,
  params: TunnelParams,
  sshPassword: string,
): Promise<TunnelHandle> {
  return new Promise(async (resolve, reject) => {
    const localPort = await findFreePort();
    const ssh = new SSHClient();

    // Local TCP server that forwards connections through SSH tunnel
    const tcpServer = createServer((socket) => {
      ssh.forwardOut(
        "127.0.0.1",
        localPort,
        params.remoteHost,
        params.remotePort,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          socket.on("close", () => stream.destroy());
          stream.on("close", () => socket.destroy());
        },
      );
    });

    const cleanup = () => {
      tcpServer.close();
      ssh.end();
    };

    ssh.on("ready", () => {
      tcpServer.listen(localPort, "127.0.0.1", () => {
        resolve({
          localPort,
          adbSerial: `127.0.0.1:${localPort}`,
          close: cleanup,
        });
      });
    });

    ssh.on("error", (err) => {
      cleanup();
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SSH connection timed out after 15s"));
    }, 15_000);

    ssh.on("ready", () => clearTimeout(timeout));

    ssh.connect({
      host: params.sshHost,
      port: params.sshPort,
      username: params.sshUser,
      password: sshPassword,
      readyTimeout: 15_000,
      algorithms: {
        serverHostKey: [
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "ssh-rsa",
          "rsa-sha2-256",
          "rsa-sha2-512",
        ],
        kex: [
          "curve25519-sha256",
          "curve25519-sha256@libssh.org",
          "ecdh-sha2-nistp256",
          "diffie-hellman-group14-sha256",
          "diffie-hellman-group14-sha1",
        ],
      },
    });
  });
}

/**
 * Check if a port is accepting connections.
 */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 2000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Run an adb command and return stdout.
 */
export function execAdb(args: string[]): string {
  try {
    return execFileSync("adb", args, {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`adb ${args.join(" ")} failed: ${err.stderr ?? err.message}`);
  }
}

export function getAdbDeviceState(serial: string): string | null {
  const output = execAdb(["devices", "-l"]);
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices")) continue;
    const [deviceSerial, state] = trimmed.split(/\s+/, 3);
    if (deviceSerial === serial) return state ?? null;
  }
  return null;
}

export async function waitForAdbDevice(
  serial: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: string | null = null;
  while (Date.now() < deadline) {
    lastState = getAdbDeviceState(serial);
    if (lastState === "device") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `adb ${serial} did not reach device state (last state: ${lastState ?? "missing"})`,
  );
}
