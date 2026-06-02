import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../state.js";

describe("status and doctor commands", () => {
  let home: string;
  let originalHome: string | undefined;
  let server: Server | null;
  let sockets: Set<Socket>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "handheld-status-command-test-"));
    process.env.HOME = home;
    server = null;
    sockets = new Set();
    vi.resetModules();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      await closeServer(server);
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function connection(overrides: Partial<Connection> = {}): Connection {
    return {
      adb: { serial: "", sshPid: 0, tunnelPort: 0 },
      connectedAt: new Date(0).toISOString(),
      deviceId: "device-a",
      padCode: "pad",
      relay: { connected: true, relayUrl: "wss://relay.test" },
      sessionId: "session-a",
      ...overrides,
    };
  }

  async function runStatusCommand(args: string[]): Promise<string> {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { registerStatusCommand } = await import("./status.js");
    const program = new Command().name("handheld").exitOverride();
    program.option("--json", "output as JSON");
    registerStatusCommand(program);
    await program.parseAsync(args, { from: "user" });
    return output.join("\n");
  }

  async function listen(serverToStart: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      serverToStart.once("error", reject);
      serverToStart.listen(socketPath, () => resolve());
    });
  }

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

  it("status --prune removes stale relay-only records and keeps usable local records", async () => {
    const state = await import("../state.js");
    state.saveConnection(
      connection({
        deviceId: "stale-relay",
        relay: {
          connected: true,
          relayUrl: "wss://relay.test",
          socketPath: join(home, "missing.sock"),
        },
      })
    );
    state.saveConnection(
      connection({
        adb: { serial: "emulator-5554", sshPid: 0, tunnelPort: 0 },
        deviceId: "emulator-5554",
        local: true,
        relay: { connected: false, relayUrl: "" },
        sessionId: "local",
      })
    );

    await runStatusCommand(["status", "--prune"]);

    expect(state.getConnections().map((conn) => conn.deviceId)).toEqual([
      "emulator-5554",
    ]);
  });

  it("status --prune removes relay records whose saved socket path is present but not live", async () => {
    const state = await import("../state.js");
    const socketPath = join(home, "dead.sock");
    writeFileSync(socketPath, "not a socket");
    state.saveConnection(
      connection({
        deviceId: "dead-relay",
        relay: {
          connected: true,
          relayUrl: "wss://relay.test",
          socketPath,
        },
      })
    );

    const output = await runStatusCommand(["status", "--prune", "--json"]);
    const report = JSON.parse(output);

    expect(report.pruned).toEqual(["dead-relay"]);
    expect(report.connections[0].health).toMatchObject({
      reasons: expect.arrayContaining(["relay socket invalid"]),
      relayAvailable: false,
      usable: false,
    });
    expect(state.getConnections()).toEqual([]);
  });

  it("status --prune removes relay-only records when a valid socket closes without daemon status", async () => {
    const state = await import("../state.js");
    const socketPath = join(home, "closing.sock");
    server = createServer((socket) => {
      track(socket).end();
    });
    await listen(server, socketPath);
    state.saveConnection(
      connection({
        deviceId: "closing-relay",
        relay: {
          connected: true,
          relayUrl: "wss://relay.test",
          socketPath,
        },
      })
    );

    const output = await runStatusCommand(["status", "--prune", "--json"]);
    const report = JSON.parse(output);

    expect(report.pruned).toEqual(["closing-relay"]);
    expect(report.connections[0].health).toMatchObject({
      reasons: expect.arrayContaining([
        "relay probe failed",
        "no usable relay or ADB transport",
      ]),
      relayAvailable: false,
      usable: false,
    });
    expect(state.getConnections()).toEqual([]);
  });

  it("doctor --json masks API keys and reports stale targets without leaking the full key", async () => {
    const fullKey = "muk_secret_value_123456";
    const state = await import("../state.js");
    state.setConfig({ apiKey: fullKey, defaultDevice: "stale-relay" });
    state.saveConnection(
      connection({
        deviceId: "stale-relay",
        relay: {
          connected: true,
          relayUrl: "wss://relay.test/live-secret-token",
          socketPath: join(home, "missing.sock"),
          viewerUrl: "https://viewer.test/live-secret-token",
        },
      })
    );

    const output = await runStatusCommand(["doctor", "--json"]);
    const report = JSON.parse(output);

    expect(output).not.toContain(fullKey);
    expect(output).not.toContain("live-secret-token");
    expect(report.config.apiKey).toBe("muk_secr...");
    expect(report.connections[0].relay).toMatchObject({
      relayUrl: "wss://relay.test/...",
      viewerUrl: "https://viewer.test/...",
    });
    expect(report.target).toMatchObject({
      ok: false,
      targetDeviceId: "stale-relay",
    });
    expect(report.target.error).toContain("relay socket missing");
  });
});
