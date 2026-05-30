import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../state.js";
import { resolveDisconnectTarget } from "./disconnect.js";

describe("disconnect target resolution", () => {
  it("uses an explicit serial regardless of how many are attached", () => {
    expect(resolveDisconnectTarget("emulator-5554", ["a", "b"])).toEqual({
      deviceId: "emulator-5554",
    });
  });

  it("auto-resolves the sole attached device when none is named", () => {
    expect(resolveDisconnectTarget(undefined, ["only-one"])).toEqual({
      deviceId: "only-one",
    });
  });

  it("requires an explicit serial when several are attached", () => {
    const result = resolveDisconnectTarget(undefined, ["a", "b"]);
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toContain("a, b");
  });

  it("reports nothing-connected when none are attached", () => {
    expect(resolveDisconnectTarget(undefined, [])).toEqual({
      error: "Not connected to any device.",
    });
  });
});

const connection: Connection = {
  adb: { serial: "", sshPid: 0, tunnelPort: 0 },
  connectedAt: "2026-05-27T00:00:00.000Z",
  deviceId: "profile_1",
  padCode: "pad_1",
  relay: {
    connected: true,
    relayUrl: "wss://relay.test/cli",
  },
  sessionId: "session_1",
};

describe("disconnect teardown", () => {
  // The pure-resolver tests above statically import ./disconnect.js, which
  // pre-loads it with the real ../state.js. Reset the module registry before
  // each teardown test so the post-doMock dynamic import re-evaluates against
  // the mocks rather than that cached unmocked instance.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../state.js");
    vi.doUnmock("../api-client.js");
    vi.doUnmock("../transport/adb/tunnel.js");
  });

  it("keeps local connection state when the remote session stop fails", async () => {
    const removeConnection = vi.fn();

    vi.doMock("../state.js", () => ({
      getConnection: vi.fn(() => connection),
      getConnections: vi.fn(() => [connection]),
      removeConnection,
    }));
    vi.doMock("../api-client.js", () => ({
      HandheldApiClient: class {
        async stopDevice() {
          throw new Error("Profile does not have an active session");
        }
      },
    }));
    vi.doMock("../transport/adb/tunnel.js", () => ({
      execAdb: vi.fn(),
    }));

    const { teardown } = await import("./disconnect.js");
    await expect(teardown("profile_1")).rejects.toThrow(
      "Profile does not have an active session"
    );

    expect(removeConnection).not.toHaveBeenCalled();
  });

  it("tears down a local connection without ever calling the Gateway", async () => {
    const removeConnection = vi.fn();
    const stopDevice = vi.fn(async () => {
      throw new Error("Gateway must not be called for a local connection");
    });
    const localConnection: Connection = {
      adb: { serial: "emulator-5554", sshPid: 0, tunnelPort: 54830 },
      connectedAt: "2026-05-30T00:00:00.000Z",
      deviceId: "emulator-5554",
      local: true,
      padCode: "",
      relay: { connected: false, relayUrl: "" },
      sessionId: "local",
    };

    vi.doMock("../state.js", () => ({
      getConnection: vi.fn(() => localConnection),
      getConnections: vi.fn(() => [localConnection]),
      removeConnection,
    }));
    vi.doMock("../api-client.js", () => ({
      HandheldApiClient: class {
        stopDevice = stopDevice;
      },
    }));
    const execAdb = vi.fn();
    vi.doMock("../transport/adb/tunnel.js", () => ({ execAdb }));

    const { teardown } = await import("./disconnect.js");
    await expect(teardown("emulator-5554")).resolves.toBeUndefined();

    expect(stopDevice).not.toHaveBeenCalled();
    expect(removeConnection).toHaveBeenCalledWith("emulator-5554");
    // It should drop the Tiny port-forward rather than `adb disconnect`.
    expect(execAdb).toHaveBeenCalledWith([
      "-s",
      "emulator-5554",
      "forward",
      "--remove",
      "tcp:54830",
    ]);
  });

  it("removes local connection state after the remote session stop succeeds", async () => {
    const removeConnection = vi.fn();

    vi.doMock("../state.js", () => ({
      getConnection: vi.fn(() => connection),
      getConnections: vi.fn(() => [connection]),
      removeConnection,
    }));
    vi.doMock("../api-client.js", () => ({
      HandheldApiClient: class {
        async stopDevice() {
          return { ok: true };
        }
      },
    }));
    vi.doMock("../transport/adb/tunnel.js", () => ({
      execAdb: vi.fn(),
    }));

    const { teardown } = await import("./disconnect.js");
    await expect(teardown("profile_1")).resolves.toBeUndefined();

    expect(removeConnection).toHaveBeenCalledWith("profile_1");
  });
});
