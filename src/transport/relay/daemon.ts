import { fork, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getAuthorizationHeaders } from "../../auth.js";
import { getSocketPath } from "../../state.js";
import { RelayClient } from "./client.js";

export interface RelayDaemonOpts {
  deviceId: string;
  relayUrl: string;
}

export interface RelayDaemonHandle {
  pid: number;
  socketPath: string;
}

interface ReadyMessage {
  socketPath: string;
  type: "ready";
}

interface ErrorMessage {
  message: string;
  type: "error";
}

type DaemonRequest = {
  action: string;
  args?: Record<string, unknown>;
  id: string;
};

type DaemonResponse = {
  data?: unknown;
  error?: string;
  id: string;
  ok: boolean;
};

export async function spawnRelayDaemon(
  opts: RelayDaemonOpts
): Promise<RelayDaemonHandle> {
  const currentFile = fileURLToPath(import.meta.url);
  const childEntry = currentFile.endsWith(".ts")
    ? currentFile
    : path.resolve(path.dirname(currentFile), "transport/relay/daemon.js");

  const child = fork(childEntry, [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      HANDHELD_RELAY_DAEMON_MODE: "1",
      HANDHELD_RELAY_DAEMON_OPTS: JSON.stringify(opts),
    },
  });

  if (!child.pid) {
    throw new Error("Failed to spawn relay daemon");
  }

  const ready = await waitForChildReady(child);
  child.disconnect();
  child.unref();

  return {
    pid: child.pid,
    socketPath: ready.socketPath,
  };
}

async function waitForChildReady(
  child: ChildProcess
): Promise<{ socketPath: string }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Relay daemon did not start within 15s"));
    }, 15_000);

    child.once("message", (message) => {
      clearTimeout(timeout);
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "ready" &&
        "socketPath" in message
      ) {
        resolve({
          socketPath: String((message as ReadyMessage).socketPath),
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
      reject(new Error("Unexpected relay daemon startup message"));
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Relay daemon exited before becoming ready (code ${code ?? "unknown"})`
        )
      );
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function requestRelayDaemon(
  socketPath: string,
  request: Omit<DaemonRequest, "id"> & { id?: string },
  opts: { timeoutMs?: number } = {}
): Promise<DaemonResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const id = request.id ?? crypto.randomUUID();
    const rl = readline.createInterface({
      crlfDelay: Infinity,
      input: socket,
    });

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      try {
        rl.close();
      } catch {}
      socket.destroy();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanup();
      callback();
    };
    const fail = (error: unknown) => {
      finish(() => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    };
    const failClosed = () => {
      fail(new Error("Relay daemon closed before responding"));
    };

    timeout = setTimeout(() => {
      fail(new Error("Relay daemon request timed out"));
    }, opts.timeoutMs ?? 60_000);

    socket.once("connect", () => {
      if (settled) return;
      try {
        socket.write(
          JSON.stringify({
            ...request,
            id,
          }) + "\n"
        );
      } catch (error) {
        fail(error);
      }
    });

    socket.once("error", fail);
    socket.once("end", failClosed);
    socket.once("close", failClosed);
    rl.once("error", fail);
    rl.once("close", failClosed);

    rl.once("line", (line) => {
      try {
        const response = JSON.parse(line) as DaemonResponse;
        finish(() => resolve(response));
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function startRelayDaemon(opts: RelayDaemonOpts): Promise<void> {
  const socketPath = getSocketPath(opts.deviceId);
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const relay = new RelayClient(opts.relayUrl, getAuthorizationHeaders());
  await relay.connect();

  const withReconnect = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      await relay.disconnect().catch(() => undefined);
      await relay.connect();
      return await run();
    }
  };

  const server = createServer((socket) => {
    const rl = readline.createInterface({
      crlfDelay: Infinity,
      input: socket,
    });

    rl.on("line", async (line) => {
      let request: DaemonRequest;
      try {
        request = JSON.parse(line) as DaemonRequest;
      } catch (error) {
        socket.write(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            id: "unknown",
            ok: false,
          } satisfies DaemonResponse) + "\n"
        );
        return;
      }

      try {
        let response: DaemonResponse;
        switch (request.action) {
          case "tap":
            {
              const result = await withReconnect(() => relay.tap(request.args as any));
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "swipe":
            {
              const result = await withReconnect(() => relay.swipe(request.args as any));
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "type":
            {
              const result = await withReconnect(() =>
                relay.type(String(request.args?.text ?? ""))
              );
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "key":
            {
              const result = await withReconnect(() =>
                relay.key((request.args?.key ?? request.args?.keyCode) as any)
              );
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "shell":
            {
              const result = await withReconnect(() =>
                relay.shell(String(request.args?.command ?? ""))
              );
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "snapshot_xml":
            {
              const result = await withReconnect(() => relay.snapshotXml());
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "screenshot": {
            const result = await withReconnect(() => relay.screenshot());
            response = {
              data: result.base64,
              id: request.id,
              ok: result.ok,
            };
            break;
          }
          case "clipboard":
            {
              const result = await withReconnect(() =>
                relay.clipboard(
                  (request.args?.action as "get" | "set") ?? "get",
                  request.args?.text as string | undefined
                )
              );
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "gps":
            {
              const result = await withReconnect(() =>
                relay.gps(
                  Number(request.args?.latitude),
                  Number(request.args?.longitude)
                )
              );
              response = { id: request.id, ok: result.ok, data: result.data, error: result.error };
            }
            break;
          case "status":
            response = {
              data: await withReconnect(() => relay.getStatus()),
              id: request.id,
              ok: true,
            };
            break;
          default:
            response = {
              error: `Unknown action: ${request.action}`,
              id: request.id,
              ok: false,
            };
        }

        socket.write(
          JSON.stringify({
            ...response,
            id: request.id,
          } satisfies DaemonResponse) + "\n"
        );
      } catch (error) {
        socket.write(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            id: request.id,
            ok: false,
          } satisfies DaemonResponse) + "\n"
        );
      }
    });
  });

  const cleanup = async () => {
    try {
      server.close();
    } catch {}
    try {
      await relay.disconnect();
    } catch {}
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  process.send?.({
    socketPath,
    type: "ready",
  } satisfies ReadyMessage);

  await new Promise(() => {});
}

if (
  process.env.HANDHELD_RELAY_DAEMON_MODE === "1" &&
  process.env.HANDHELD_RELAY_DAEMON_OPTS
) {
  const opts = JSON.parse(process.env.HANDHELD_RELAY_DAEMON_OPTS) as RelayDaemonOpts;
  startRelayDaemon(opts).catch((err) => {
    process.send?.({
      message: err instanceof Error ? err.message : String(err),
      type: "error",
    } satisfies ErrorMessage);
    console.error("[handheld-relay-daemon] fatal:", err);
    process.exit(1);
  });
}
