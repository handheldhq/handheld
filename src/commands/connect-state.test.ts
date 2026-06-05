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
    vi.doUnmock("../tiny-helper.js");
    vi.doUnmock("./tiny-bootstrap.js");
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
      HANDHELD_HOME: "/tmp/handheld-test",
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
      HANDHELD_HOME: "/tmp/handheld-test",
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
      HANDHELD_HOME: "/tmp/handheld-test",
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

  it("recycles an active session whose relay room is no longer active", async () => {
    const saveConnection = vi.fn();
    const stopDevice = vi.fn(async () => ({ ok: true }));
    const startDevice = vi.fn(async () => ({
      adb: null,
      deviceId: "profile_1",
      h5: {
        baseUrl: "https://h5.test",
        relayUrl: "wss://relay.test/fresh",
        token: "fresh",
        viewerUrl: "/live/fresh",
      },
      ok: true,
      sessionId: "session_2",
    }));
    const relayConnects: string[] = [];

    vi.doMock("../state.js", () => ({
      HANDHELD_HOME: "/tmp/handheld-test",
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
        constructor(private readonly relayUrl: string) {}
        async connect() {
          relayConnects.push(this.relayUrl);
          if (this.relayUrl.includes("stale")) {
            throw new Error("Relay session is not active");
          }
        }
        async disconnect() {}
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
            activeSession: {
              adbEnabled: false,
              h5: { viewerUrl: "/live/stale" },
              h5Enabled: true,
              padCode: "pad_1",
              sessionId: "session_1",
              status: "active",
            },
            device: { deviceId: "profile_1", status: "active" },
          }),
          getDeviceRelayInfo: vi
            .fn()
            .mockResolvedValueOnce({
              h5: { viewerUrl: "/live/stale" },
              relayUrl: "wss://relay.test/stale",
              sessionId: "session_1",
            })
            .mockResolvedValueOnce({
              h5: { viewerUrl: "/live/fresh" },
              relayUrl: "wss://relay.test/fresh",
              sessionId: "session_2",
            }),
          startDevice,
          stopDevice,
        } as never,
        deviceId: "profile_1",
        json: true,
        webrtcOnly: true,
      }),
    ).resolves.toMatchObject({
      deviceId: "profile_1",
      relay: { connected: true },
      sessionId: "session_2",
    });

    expect(relayConnects).toEqual([
      "wss://relay.test/stale",
      "wss://relay.test/fresh",
    ]);
    expect(stopDevice).toHaveBeenCalledWith("profile_1");
    expect(startDevice).toHaveBeenCalledWith("profile_1", {
      enableAdb: false,
      enableH5: true,
    });
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: expect.objectContaining({ relayUrl: "wss://relay.test/fresh" }),
        sessionId: "session_2",
      }),
    );
  });

  it("bootstraps Tiny when connecting relay-only cloud sessions", async () => {
    const saveConnection = vi.fn();
    const ensureDeviceTiny = vi.fn(async () => ({ token: "mu-tiny-localhost-v1" }));

    vi.doMock("../state.js", () => ({
      HANDHELD_HOME: "/tmp/handheld-test",
      setConfig: vi.fn(),
      getConfig: vi.fn(() => ({})),
      getConnection: vi.fn(() => undefined),
      getRelayState: vi.fn((conn) => conn.relay),
      removeConnection: vi.fn(),
      saveConnection,
    }));
    vi.doMock("../auth.js", () => ({
      getAuthorizationHeaders: () => ({ Authorization: "Bearer test" }),
      getResolvedDevice: () => undefined,
    }));
    vi.doMock("../transport/relay/client.js", () => ({
      RelayClient: class {
        constructor(readonly relayUrl: string) {}
        async connect() {}
        async disconnect() {}
        async getStatus() {
          return { active: true };
        }
        async shell() {
          return { ok: true, data: "{}" };
        }
      },
    }));
    vi.doMock("../transport/relay/daemon.js", () => ({
      spawnRelayDaemon: vi.fn(async () => ({
        pid: 123,
        socketPath: "/tmp/handheld.sock",
      })),
    }));
    vi.doMock("./tiny-bootstrap.js", () => ({
      ensureDeviceTiny,
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
            sessionId: "session_1",
          }),
          startDevice: async () => ({
            adb: null,
            deviceId: "profile_1",
            h5: {
              baseUrl: "https://h5.test",
              relayUrl: "wss://relay.test/cli",
              token: "token",
              viewerUrl: "/live/token",
            },
            ok: true,
            sessionId: "session_1",
          }),
        } as never,
        deviceId: "profile_1",
        json: true,
        webrtcOnly: true,
      })
    ).resolves.toMatchObject({
      deviceId: "profile_1",
      relay: { connected: true },
      sessionId: "session_1",
    });

    expect(ensureDeviceTiny).toHaveBeenCalledWith(
      expect.objectContaining({
        adb: null,
        connection: expect.objectContaining({
          deviceId: "profile_1",
          sessionId: "session_1",
        }),
        relay: expect.anything(),
      })
    );
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "profile_1",
        sessionId: "session_1",
      })
    );
  });

  it("saves relay and ADB state before Tiny warmup fails", async () => {
    const saveConnection = vi.fn();
    const setConfig = vi.fn();

    vi.doMock("../state.js", () => ({
      HANDHELD_HOME: "/tmp/handheld-test",
      setConfig,
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
      },
    }));
    vi.doMock("../transport/relay/daemon.js", () => ({
      spawnRelayDaemon: vi.fn(async () => ({
        pid: 123,
        socketPath: "/tmp/handheld.sock",
      })),
    }));
    vi.doMock("../transport/adb/daemon.js", () => ({
      spawnTunnelDaemon: vi.fn(async () => ({
        adbSerial: "127.0.0.1:59048",
        localPort: 59048,
        pid: 456,
      })),
    }));
    vi.doMock("../tiny-helper.js", () => ({
      startTinyHelper: vi.fn(async () => {
        throw new Error("Tiny helper did not become ready");
      }),
    }));

    const { connectDevice } = await import("./connect.js");
    await expect(
      connectDevice({
        api: {
          getBaseUrl: () => "https://api.handheld.sh",
          getDevice: async () => ({
            activeSession: {
              adbEnabled: true,
              h5: { viewerUrl: "/live/token" },
              h5Enabled: true,
              padCode: "pad_1",
              sessionId: "session_1",
              status: "active",
            },
            device: { deviceId: "profile_1", status: "active" },
          }),
          getDeviceRelayInfo: async () => ({
            h5: { viewerUrl: "/live/token" },
            relayUrl: "wss://relay.test/cli",
            sessionId: "session_1",
          }),
          recoverSessionAdb: async () => ({
            key: "secret",
            sshCommand: "ssh -p 22 root@example",
            tunnel: { host: "127.0.0.1", port: 22 },
          }),
        } as never,
        deviceId: "profile_1",
        json: true,
      }),
    ).resolves.toMatchObject({
      adb: { serial: "127.0.0.1:59048" },
      deviceId: "profile_1",
      relay: { connected: true },
      sessionId: "session_1",
      tiny: undefined,
    });

    expect(saveConnection).toHaveBeenCalledTimes(1);
    const saved = saveConnection.mock.calls[0]?.[0] as Connection;
    expect(saved).toMatchObject({
      adb: expect.objectContaining({ serial: "127.0.0.1:59048" }),
      deviceId: "profile_1",
      relay: expect.objectContaining({ connected: true }),
      sessionId: "session_1",
    });
    expect(saved).not.toHaveProperty("tiny");
    expect(setConfig).toHaveBeenCalledWith({ defaultDevice: "profile_1" });
  });
});
