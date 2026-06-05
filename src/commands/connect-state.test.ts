import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../state.js";

describe("connect local state preservation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("../state.js");
    vi.doUnmock("../auth.js");
    vi.doUnmock("../transport/relay/client.js");
    vi.doUnmock("../transport/relay/daemon.js");
  });

  it("keeps a healthy relay connection if an ADB upgrade fails", async () => {
    const existing: Connection = {
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
    const removeConnection = vi.fn();

    vi.doMock("../state.js", () => ({
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
      getConnection: vi.fn(() => existing),
      getRelayState: vi.fn(() => existing.relay),
      removeConnection,
      saveConnection: vi.fn(),
    }));
    vi.doMock("../auth.js", () => ({
      getAuthorizationHeaders: () => ({ Authorization: "Bearer test" }),
      getResolvedDevice: () => undefined,
    }));
    vi.doMock("../transport/relay/client.js", () => ({
      RelayClient: class {
        async getStatus() {
          return { active: true };
        }
        async disconnect() {}
      },
    }));

    const { connectDevice } = await import("./connect.js");
    await expect(
      connectDevice({
        adbOnly: true,
        api: {
          getBaseUrl: () => "https://api.handheld.sh",
          getDevice: async () => ({
            activeSession: {
              adbEnabled: false,
              h5Enabled: true,
              sessionId: "session_1",
              status: "active",
            },
          }),
          recoverSessionAdb: async () => {
            throw new Error("ADB unavailable");
          },
        } as never,
        deviceId: "profile_1",
        json: true,
      }),
    ).rejects.toThrow("ADB unavailable");

    expect(removeConnection).not.toHaveBeenCalled();
  });

  it("retries provider device errors during session start", async () => {
    vi.useFakeTimers();
    const { ApiError } = await import("../api-client.js");
    const saveConnection = vi.fn();
    const startDevice = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, "DEVICE_ERROR", "维护中"))
      .mockResolvedValueOnce({
        adb: null,
        deviceId: "profile_1",
        h5: {
          baseUrl: "https://h5.test",
          relayUrl: "wss://relay.test/cli",
          token: "token",
          viewerUrl: "/live/token",
        },
        ok: true,
        sessionId: "session_2",
      });

    vi.doMock("../state.js", () => ({
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
      getConnection: vi.fn(() => undefined),
      getRelayState: vi.fn(),
      removeConnection: vi.fn(),
      saveConnection,
    }));
    vi.doMock("../auth.js", () => ({
      getAuthorizationHeaders: () => ({ Authorization: "Bearer test" }),
      getResolvedDevice: () => undefined,
    }));
    vi.doMock("../transport/relay/client.js", () => ({
      RelayClient: class {
        constructor() {}
        async connect() {}
        async disconnect() {}
        async getStatus() {
          return { active: true };
        }
      },
    }));
    vi.doMock("../transport/relay/daemon.js", () => ({
      spawnRelayDaemon: vi.fn(async () => ({
        pid: 123,
        socketPath: "/tmp/handheld.sock",
      })),
    }));

    const { connectDevice } = await import("./connect.js");
    const connected = connectDevice({
      api: {
        getBaseUrl: () => "https://api.handheld.sh",
        getDevice: async () => ({
          activeSession: null,
          device: { deviceId: "profile_1", status: "ready" },
        }),
        getDeviceRelayInfo: async () => ({
          h5: { viewerUrl: "/live/token" },
          relayUrl: "wss://relay.test/cli",
          sessionId: "session_2",
        }),
        startDevice,
      } as never,
      deviceId: "profile_1",
      json: true,
      webrtcOnly: true,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(connected).resolves.toMatchObject({
      deviceId: "profile_1",
      sessionId: "session_2",
    });

    expect(startDevice).toHaveBeenCalledTimes(2);
    expect(saveConnection).toHaveBeenCalled();
  });

  it("falls back to relay-only start when ADB start fails", async () => {
    const { ApiError } = await import("../api-client.js");
    const saveConnection = vi.fn();
    const recoverSessionAdb = vi.fn(async () => {
      throw new Error("ADB unavailable");
    });
    const startDevice = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, "DEVICE_ERROR", "维护中"))
      .mockResolvedValueOnce({
        adb: null,
        deviceId: "profile_1",
        h5: {
          baseUrl: "https://h5.test",
          relayUrl: "wss://relay.test/cli",
          token: "token",
          viewerUrl: "/live/token",
        },
        ok: true,
        sessionId: "session_2",
      });

    vi.doMock("../state.js", () => ({
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
      getConnection: vi.fn(() => undefined),
      getRelayState: vi.fn(),
      removeConnection: vi.fn(),
      saveConnection,
    }));
    vi.doMock("../auth.js", () => ({
      getAuthorizationHeaders: () => ({ Authorization: "Bearer test" }),
      getResolvedDevice: () => undefined,
    }));
    vi.doMock("../transport/relay/client.js", () => ({
      RelayClient: class {
        async connect() {}
        async disconnect() {}
        async getStatus() {
          return { active: true };
        }
      },
    }));
    vi.doMock("../transport/relay/daemon.js", () => ({
      spawnRelayDaemon: vi.fn(async () => ({
        pid: 123,
        socketPath: "/tmp/handheld.sock",
      })),
    }));

    const { connectDevice } = await import("./connect.js");
    await expect(
      connectDevice({
        api: {
          getBaseUrl: () => "https://api.handheld.sh",
          getDevice: async () => ({
            activeSession: null,
            device: { deviceId: "profile_1", status: "ready" },
          }),
          getDeviceRelayInfo: async () => ({
            h5: { viewerUrl: "/live/token" },
            relayUrl: "wss://relay.test/cli",
            sessionId: "session_2",
          }),
          recoverSessionAdb,
          startDevice,
        } as never,
        deviceId: "profile_1",
        json: true,
      }),
    ).resolves.toMatchObject({
      deviceId: "profile_1",
      relay: { connected: true },
      sessionId: "session_2",
    });

    expect(startDevice).toHaveBeenNthCalledWith(1, "profile_1", {
      enableAdb: true,
      enableH5: true,
    });
    expect(startDevice).toHaveBeenNthCalledWith(2, "profile_1", {
      enableAdb: false,
      enableH5: true,
    });
    expect(recoverSessionAdb).toHaveBeenCalledWith("session_2");
    expect(saveConnection).toHaveBeenCalled();
  });
});
