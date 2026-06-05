import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandheldApiClient } from "../api-client.js";
import type { Connection } from "../state.js";
import type { Transport } from "../transport/types.js";
import { ensureDeviceTiny, TINY_REMOTE_APK } from "./tiny-bootstrap.js";

function readyStatus(): string {
  return JSON.stringify({
    capabilities: {
      foregroundSignature: true,
      observe: true,
      responseChunks: true,
      setTextWhitespace: true,
    },
    ok: true,
    ready: true,
  });
}

describe("Tiny cloud bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads through the Gateway when relay-only Tiny is not installed", async () => {
    const shellCommands: string[] = [];
    const relay: Transport = {
      connected: true,
      name: "relay",
      async clipboard() {
        return { ok: true };
      },
      async connect() {},
      async disconnect() {},
      async gps() {
        return { ok: true };
      },
      async key() {
        return { ok: true };
      },
      async screenshot() {
        return { ok: true };
      },
      async shell(command: string) {
        shellCommands.push(command);
        if (command.includes("/v2/status") && shellCommands.length === 1) {
          return { ok: false, error: "Tiny not running" };
        }
        if (command.startsWith("pm list packages")) {
          return { ok: true, data: "" };
        }
        if (command.includes("pm install")) {
          return { ok: true, data: "OK" };
        }
        if (command.includes("am instrument")) {
          return { ok: true, data: "OK" };
        }
        if (command.includes("/v2/status")) {
          return { ok: true, data: readyStatus() };
        }
        return { ok: false, error: `unexpected shell: ${command}` };
      },
      async swipe() {
        return { ok: true };
      },
      async tap() {
        return { ok: true };
      },
      async type() {
        return { ok: true };
      },
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const createSessionUploadIntent = vi.fn(async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      key: "uploads/tiny.apk",
      maxUploadSizeBytes: 10_000_000,
      persisted: false,
      uploadUrl: "https://upload.test/tiny.apk",
    }));
    const commitSessionUpload = vi.fn(async () => ({
      fileId: null,
      key: "uploads/tiny.apk",
      ok: true,
      path: TINY_REMOTE_APK,
      persisted: false,
    }));
    const api = {
      commitSessionUpload,
      createSessionUploadIntent,
      resolveActiveSessionId: vi.fn(async () => "session_1"),
    } as unknown as HandheldApiClient;
    const connection: Connection = {
      adb: { serial: "", sshPid: 0, tunnelPort: 0 },
      connectedAt: new Date(0).toISOString(),
      deviceId: "profile_1",
      padCode: "",
      relay: { connected: true, relayUrl: "wss://relay.test" },
      sessionId: "session_1",
    };

    await expect(
      ensureDeviceTiny({
        adb: null,
        api: () => api,
        connection,
        relay,
      })
    ).resolves.toEqual({ token: "mu-tiny-localhost-v1" });

    expect(createSessionUploadIntent).toHaveBeenCalledWith("session_1", {
      filename: "tiny-snapshot-helper.apk",
      persist: undefined,
      size: expect.any(Number),
    });
    expect(fetchSpy).toHaveBeenCalledWith("https://upload.test/tiny.apk", {
      body: expect.any(Buffer),
      method: "PUT",
    });
    expect(commitSessionUpload).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({
        customizeFilePath: TINY_REMOTE_APK,
        key: "uploads/tiny.apk",
      })
    );
    expect(shellCommands.some((cmd) => cmd.includes("pm install -r -t") && cmd.includes(TINY_REMOTE_APK))).toBe(true);
    expect(shellCommands.some((cmd) => cmd.includes("am instrument"))).toBe(true);
  });
});
