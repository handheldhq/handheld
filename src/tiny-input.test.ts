import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  tinyInput,
  tinyInputBody,
  tinyInputTimeoutMs,
  tinySupportsInput,
} from "./tiny-helper.js";

describe("tinyInputBody", () => {
  it("serializes a tap with settle, dropping undefined fields", () => {
    const body = JSON.parse(
      tinyInputBody({ type: "tap", x: 10, y: 20, settle: true, settleTimeoutMs: 1800, quietMs: 200 })
    );
    expect(body).toEqual({
      type: "tap",
      x: 10,
      y: 20,
      settle: true,
      settleTimeoutMs: 1800,
      quietMs: 200,
    });
    expect("x1" in body).toBe(false);
  });

  it("serializes a swipe with duration", () => {
    const body = JSON.parse(
      tinyInputBody({ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300, settle: true })
    );
    expect(body).toMatchObject({ type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300, settle: true });
  });

  it("omits settle metadata when settle is not requested", () => {
    const body = JSON.parse(tinyInputBody({ type: "tap", x: 5, y: 6 }));
    expect("settle" in body).toBe(false);
    expect("settleTimeoutMs" in body).toBe(false);
  });
});

describe("tinyInputTimeoutMs", () => {
  it("outlasts injection + server settle", () => {
    // settle window + gesture duration + client buffer
    expect(tinyInputTimeoutMs({ type: "swipe", x1: 0, y1: 0, x2: 0, y2: 0, durationMs: 2500, settle: true, settleTimeoutMs: 1800 }))
      .toBe(1800 + 2500 + 5000);
  });

  it("uses the default settle window when settle is on without an explicit timeout", () => {
    expect(tinyInputTimeoutMs({ type: "tap", x: 0, y: 0, settle: true })).toBe(1500 + 0 + 5000);
  });

  it("adds only the buffer (+ duration) when settle is off", () => {
    expect(tinyInputTimeoutMs({ type: "tap", x: 0, y: 0 })).toBe(5000);
  });
});

describe("tinySupportsInput", () => {
  it("true only when capabilities.input === true", () => {
    expect(tinySupportsInput({ capabilities: { input: true } })).toBe(true);
    expect(tinySupportsInput({ capabilities: { input: false } })).toBe(false);
    expect(tinySupportsInput({ capabilities: {} })).toBe(false);
    expect(tinySupportsInput({})).toBe(false);
    expect(tinySupportsInput(null)).toBe(false);
    expect(tinySupportsInput(undefined)).toBe(false);
  });
});

// Opt-in live integration against a running Tiny (the new layoutDigest APK).
// Enable with: HANDHELD_LIVE_TINY=1 HANDHELD_LIVE_TINY_BASEURL=http://localhost:6795 \
//   HANDHELD_LIVE_TINY_TOKEN_FILE=/tmp/tiny5554.token HANDHELD_LIVE_TINY_SERIAL=emulator-5554
const live = process.env.HANDHELD_LIVE_TINY === "1";
describe.runIf(live)("tinyInput (live device)", () => {
  const baseUrl = process.env.HANDHELD_LIVE_TINY_BASEURL ?? "http://localhost:6795";
  const tokenFile = process.env.HANDHELD_LIVE_TINY_TOKEN_FILE ?? "/tmp/tiny5554.token";
  const serial = process.env.HANDHELD_LIVE_TINY_SERIAL ?? "emulator-5554";
  const adb = (...args: string[]) =>
    execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" });

  it("scroll-with-settle returns changed + a fresh settled snapshot", async () => {
    // Force a fresh top-of-list so the scroll genuinely moves content
    // (a resumed, already-scrolled Settings instance would be a no-op).
    adb("shell", "am", "force-stop", "com.android.settings");
    await new Promise((r) => setTimeout(r, 500));
    adb("shell", "am", "start", "-a", "android.settings.SETTINGS");
    await new Promise((r) => setTimeout(r, 1800));
    const resp = await tinyInput(
      { baseUrl, tokenFile },
      { type: "swipe", x1: 540, y1: 1700, x2: 540, y2: 700, durationMs: 300, settle: true, settleTimeoutMs: 1800 }
    );
    expect(resp.ok).toBe(true);
    expect(resp.settled).toBe(true);
    expect(typeof resp.changed).toBe("boolean");
    expect(resp.changed).toBe(true); // scrolling the settings list moves the layout
    const snapshot = resp.snapshot as { nodes?: unknown[] } | undefined;
    expect(Array.isArray(snapshot?.nodes)).toBe(true);
    expect((snapshot?.nodes?.length ?? 0)).toBeGreaterThan(0);
  });

  it("no-op tap (dead zone) settles with changed=false", async () => {
    adb("shell", "am", "start", "-a", "android.settings.SETTINGS");
    await new Promise((r) => setTimeout(r, 1500));
    const resp = await tinyInput(
      { baseUrl, tokenFile },
      { type: "tap", x: 12, y: 300, settle: true, settleTimeoutMs: 1500 }
    );
    expect(resp.ok).toBe(true);
    expect(resp.changed).toBe(false);
  });
});
