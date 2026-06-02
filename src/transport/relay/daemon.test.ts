import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestRelayDaemon } from "./daemon.js";

describe("requestRelayDaemon", () => {
  let dir: string;
  let server: Server | null;
  let sockets: Set<Socket>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "handheld-relay-daemon-test-"));
    server = null;
    sockets = new Set();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      await closeServer(server);
    }
    rmSync(dir, { force: true, recursive: true });
  });

  async function closeServer(serverToClose: Server): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 100);
      serverToClose.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  function track(socket: Socket): Socket {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  async function listen(serverToStart: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      serverToStart.once("error", reject);
      serverToStart.listen(socketPath, () => resolve());
    });
  }

  it("rejects instead of emitting an unhandled error when the saved socket path is not a socket", async () => {
    const socketPath = join(dir, "dead.sock");
    writeFileSync(socketPath, "not a socket");

    await expect(
      requestRelayDaemon(
        socketPath,
        { action: "status" },
        { timeoutMs: 50 }
      )
    ).rejects.toThrow(/connect|socket|ENOTSOCK|ECONNREFUSED/i);
  });

  it("rejects promptly when the daemon closes before sending a response line", async () => {
    const socketPath = join(dir, "closing.sock");
    server = createServer((socket) => {
      track(socket).end();
    });
    await listen(server, socketPath);

    await expect(
      requestRelayDaemon(
        socketPath,
        { action: "status" },
        { timeoutMs: 1_000 }
      )
    ).rejects.toThrow(/closed before responding/i);
  });
});
