import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "./state.js";

describe("connection resolution and health", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalDevice: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalDevice = process.env.HANDHELD_DEVICE;
    home = mkdtempSync(join(tmpdir(), "handheld-health-test-"));
    process.env.HOME = home;
    delete process.env.HANDHELD_DEVICE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDevice === undefined) delete process.env.HANDHELD_DEVICE;
    else process.env.HANDHELD_DEVICE = originalDevice;
    rmSync(home, { recursive: true, force: true });
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

  it("preserves an explicit stale default instead of retargeting another connection", async () => {
    const state = await import("./state.js");
    const health = await import("./connection-health.js");
    state.setConfig({ defaultDevice: "missing-device" });
    state.saveConnection(connection({ deviceId: "device-a" }));

    const resolved = health.resolveConnection();

    expect(resolved).toMatchObject({
      error: {
        source: "default",
        targetDeviceId: "missing-device",
      },
      ok: false,
    });
  });

  it("reports malformed records without throwing on missing adb", async () => {
    const health = await import("./connection-health.js");
    const record = connection({
      adb: undefined as never,
      relay: { connected: false, relayUrl: "" },
    });

    expect(health.inspectConnectionHealth(record)).toMatchObject({
      reasons: expect.arrayContaining(["no usable relay or ADB transport"]),
      usable: false,
    });
  });

  it("prunes relay records whose saved daemon socket is gone and no ADB is available", async () => {
    const state = await import("./state.js");
    const health = await import("./connection-health.js");
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

    expect(health.pruneStaleConnections()).toEqual(["stale-relay"]);
    expect(state.getConnections()).toEqual([]);
  });

  it("prunes relay records whose saved daemon socket path is not a live socket", async () => {
    const state = await import("./state.js");
    const health = await import("./connection-health.js");
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

    expect(health.inspectConnectionHealth(state.getConnections()[0]!)).toMatchObject({
      reasons: expect.arrayContaining([
        "relay socket invalid",
        "no usable relay or ADB transport",
      ]),
      relayAvailable: false,
      usable: false,
    });
    expect(health.pruneStaleConnections()).toEqual(["dead-relay"]);
    expect(state.getConnections()).toEqual([]);
  });
});
