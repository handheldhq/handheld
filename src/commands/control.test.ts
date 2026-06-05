import { describe, expect, it } from "vitest";
import type { Connection } from "../state.js";
import {
  connectionWithRefreshedRelay,
  failedBeforeReachingDevice,
  shouldFallbackToAdb,
} from "./control.js";

describe("relay -> adb fallback safety (no-resend-on-mutating, #5)", () => {
  const fail = (error?: string) => ({ ok: false as const, error });
  const ok = { ok: true as const };

  it("never falls back when the primary succeeded", () => {
    expect(shouldFallbackToAdb("tap", {}, ok)).toBe(false);
  });

  it("never falls back for a command that has no adb equivalent", () => {
    expect(shouldFallbackToAdb("gps", {}, fail("boom"))).toBe(false);
  });

  it("falls back idempotent reads on any failure", () => {
    // screenshot/shell are safe to re-run — no device state change.
    expect(shouldFallbackToAdb("screenshot", {}, fail("This operation was aborted"))).toBe(true);
    expect(shouldFallbackToAdb("shell", {}, fail("ETIMEDOUT"))).toBe(true);
  });

  it("does NOT resend a mutating op on an ambiguous (post-send) failure", () => {
    // The op may have already run on the relay; resending on adb double-fires.
    for (const cmd of ["tap", "swipe", "type", "key"] as const) {
      expect(shouldFallbackToAdb(cmd, {}, fail("This operation was aborted"))).toBe(false);
      expect(shouldFallbackToAdb(cmd, {}, fail("ETIMEDOUT"))).toBe(false);
    }
    expect(shouldFallbackToAdb("clipboard", { clipboardAction: "set" }, fail("timeout"))).toBe(false);
  });

  it("DOES fall back a mutating op when it provably never reached the device", () => {
    // A pre-send connection failure means adb is a first execution, not a resend.
    expect(shouldFallbackToAdb("tap", {}, fail("connect ECONNREFUSED 127.0.0.1:6792"))).toBe(true);
    expect(shouldFallbackToAdb("key", {}, fail("relay daemon not running"))).toBe(true);
    expect(shouldFallbackToAdb("type", {}, fail("Tiny relay not connected"))).toBe(true);
    expect(shouldFallbackToAdb("clipboard", { clipboardAction: "set" }, fail("ECONNREFUSED"))).toBe(true);
  });

  it("clipboard get has no adb fallback (read unsupported on adb, R4)", () => {
    expect(shouldFallbackToAdb("clipboard", { clipboardAction: "get" }, fail("aborted"))).toBe(false);
  });

  it("classifies failures by whether the op could have reached the device", () => {
    expect(failedBeforeReachingDevice("connect ECONNREFUSED")).toBe(true);
    expect(failedBeforeReachingDevice("relay daemon not running")).toBe(true);
    expect(failedBeforeReachingDevice("not connected")).toBe(true);
    // Post-send / ambiguous: the op may have run.
    expect(failedBeforeReachingDevice("This operation was aborted")).toBe(false);
    expect(failedBeforeReachingDevice("ETIMEDOUT")).toBe(false);
    expect(failedBeforeReachingDevice(undefined)).toBe(false);
  });
});

describe("relay refresh state", () => {
  const connection: Connection = {
    adb: { serial: "127.0.0.1:5555", sshPid: 123, tunnelPort: 5555 },
    connectedAt: "2026-06-05T00:00:00.000Z",
    deviceId: "device_1",
    padCode: "PAD",
    relay: {
      connected: true,
      relayUrl: "wss://old-relay",
      viewerUrl: "https://old-viewer",
    },
    sessionId: "session_old",
  };

  it("updates the cached session id when Gateway rolls the relay to a new active session", () => {
    const refreshed = connectionWithRefreshedRelay(
      connection,
      {
        h5: { viewerUrl: "https://new-viewer" },
        relayUrl: "wss://new-relay",
        sessionId: "session_new",
      },
      { daemonPid: 456, socketPath: "/tmp/handheld.sock" }
    );

    expect(refreshed.sessionId).toBe("session_new");
    expect(refreshed.relay).toEqual({
      connected: true,
      daemonPid: 456,
      relayUrl: "wss://new-relay",
      socketPath: "/tmp/handheld.sock",
      viewerUrl: "https://new-viewer",
    });
  });

  it("keeps the cached session id when Gateway returns only a fresh relay URL", () => {
    const refreshed = connectionWithRefreshedRelay(connection, {
      relayUrl: "wss://new-relay",
    });

    expect(refreshed.sessionId).toBe("session_old");
    expect(refreshed.relay?.viewerUrl).toBe("https://old-viewer");
  });
});
