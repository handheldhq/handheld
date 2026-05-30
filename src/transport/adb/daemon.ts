import type { ChildProcess } from "node:child_process";
import {
  execAdb,
  startDetachedTunnel,
  startTunnel,
  waitForAdbDevice,
  type TunnelParams,
} from "./tunnel.js";

export interface AdbDaemonOpts {
  deviceId: string;
  sshPassword: string;
  tunnel: TunnelParams;
}

export interface AdbDaemonHandle {
  adbSerial: string;
  localPort: number;
  pid: number;
}

interface ReadyMessage {
  adbSerial: string;
  localPort: number;
  type: "ready";
}

interface ErrorMessage {
  message: string;
  type: "error";
}

export async function startAdbDaemon(
  opts: AdbDaemonOpts
): Promise<AdbDaemonHandle> {
  const tunnel = await startTunnel(opts.deviceId, opts.tunnel, opts.sshPassword);

  try {
    execAdb(["connect", tunnel.adbSerial]);
    await waitForAdbDevice(tunnel.adbSerial);
  } catch (error) {
    try {
      execAdb(["disconnect", tunnel.adbSerial]);
    } catch {}
    tunnel.close();
    throw error;
  }

  process.send?.({
    adbSerial: tunnel.adbSerial,
    localPort: tunnel.localPort,
    type: "ready",
  } satisfies ReadyMessage);

  const shutdown = () => {
    try {
      execAdb(["disconnect", tunnel.adbSerial]);
    } catch {}
    tunnel.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("disconnect", () => {
    // Parent only uses IPC for startup confirmation.
  });

  await new Promise(() => {});

  return {
    adbSerial: tunnel.adbSerial,
    localPort: tunnel.localPort,
    pid: process.pid,
  };
}

export async function spawnTunnelDaemon(
  opts: AdbDaemonOpts
): Promise<AdbDaemonHandle> {
  if (process.platform !== "win32") {
    const tunnel = await startDetachedTunnel(
      opts.deviceId,
      opts.tunnel,
      opts.sshPassword
    );
    try {
      execAdb(["connect", tunnel.adbSerial]);
      await waitForAdbDevice(tunnel.adbSerial);
    } catch (error) {
      try {
        execAdb(["disconnect", tunnel.adbSerial]);
      } catch {}
      try {
        process.kill(tunnel.pid, "SIGTERM");
      } catch {}
      throw error;
    }

    return {
      adbSerial: tunnel.adbSerial,
      localPort: tunnel.localPort,
      pid: tunnel.pid,
    };
  }

  const { fork } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const child = fork(fileURLToPath(import.meta.url), [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      HANDHELD_ADB_DAEMON_MODE: "1",
      HANDHELD_ADB_DAEMON_OPTS: JSON.stringify(opts),
    },
  });

  if (!child.pid) {
    throw new Error("Failed to spawn ADB tunnel daemon");
  }

  const ready = await waitForChildReady(child);
  child.disconnect();
  child.unref();

  return {
    ...ready,
    pid: child.pid,
  };
}

async function waitForChildReady(
  child: ChildProcess
): Promise<Omit<AdbDaemonHandle, "pid">> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("ADB tunnel daemon did not start within 15s"));
    }, 15_000);

    child.once("message", (message) => {
      clearTimeout(timeout);
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready" &&
        "adbSerial" in message &&
        "localPort" in message
      ) {
        const payload = message as ReadyMessage;
        resolve({
          adbSerial: payload.adbSerial,
          localPort: payload.localPort,
        });
        return;
      }
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "error" &&
        "message" in message
      ) {
        reject(new Error(String((message as ErrorMessage).message)));
        return;
      }
      reject(new Error("Unexpected ADB daemon startup message"));
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `ADB tunnel daemon exited before becoming ready (code ${code ?? "unknown"})`
        )
      );
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

if (process.env.HANDHELD_ADB_DAEMON_MODE === "1" && process.env.HANDHELD_ADB_DAEMON_OPTS) {
  const opts = JSON.parse(process.env.HANDHELD_ADB_DAEMON_OPTS) as AdbDaemonOpts;
  startAdbDaemon(opts).catch((err) => {
    process.send?.({
      message: err instanceof Error ? err.message : String(err),
      type: "error",
    } satisfies ErrorMessage);
    console.error("[handheld-adb-daemon] fatal:", err);
    process.exit(1);
  });
}
