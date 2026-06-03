import { describe, expect, it } from "vitest";
import { ApiError } from "../api-client.js";
import {
  isStaleSessionError,
  parseAdbDevices,
  resolveLocalSerial,
  shouldStartNewSession,
  startBlockedCopy,
} from "./connect.js";

describe("local adb attach (connect --local)", () => {
  const SAMPLE = [
    "List of devices attached",
    "emulator-5554       device product:sdk_gphone64_arm64 model:sdk_gphone64",
    "RZ8N abc            unauthorized",
    "",
  ].join("\n");

  it("parses `adb devices -l` into serial/state rows, skipping the header", () => {
    expect(parseAdbDevices(SAMPLE)).toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "RZ8N", state: "abc" },
    ]);
    expect(parseAdbDevices("List of devices attached\n")).toEqual([]);
  });

  it("auto-selects the sole ready device when no serial is requested", () => {
    expect(
      resolveLocalSerial([{ serial: "emulator-5554", state: "device" }])
    ).toEqual({ serial: "emulator-5554" });
  });

  it("errors (not auto-select) when zero or many devices are ready", () => {
    expect(resolveLocalSerial([])).toHaveProperty("error");
    expect(
      resolveLocalSerial([{ serial: "x", state: "offline" }])
    ).toHaveProperty("error");
    const many = resolveLocalSerial([
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "device" },
    ]);
    expect(many).toHaveProperty("error");
    expect("error" in many && many.error).toContain("emulator-5556");
  });

  it("defaults the multi-device remediation to `connect --local <serial>`", () => {
    const many = resolveLocalSerial([
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "device" },
    ]);
    expect("error" in many && many.error).toContain(
      "handheld connect --local <serial>"
    );
  });

  it("uses a caller-supplied remediation hint in the multi-device error", () => {
    // init reaches this resolver too; its error must name init's flag grammar,
    // not connect's positional grammar (the audited misdirection).
    const many = resolveLocalSerial(
      [
        { serial: "emulator-5554", state: "device" },
        { serial: "emulator-5556", state: "device" },
      ],
      undefined,
      "handheld init --local --local-serial <serial>"
    );
    expect("error" in many && many.error).toContain(
      "handheld init --local --local-serial <serial>"
    );
    expect("error" in many && many.error).not.toContain(
      "connect --local <serial>"
    );
  });

  it("honors an explicit serial only when it exists and is ready", () => {
    const devices = [
      { serial: "emulator-5554", state: "device" },
      { serial: "RZ8N", state: "unauthorized" },
    ];
    expect(resolveLocalSerial(devices, "emulator-5554")).toEqual({
      serial: "emulator-5554",
    });
    expect(resolveLocalSerial(devices, "RZ8N")).toHaveProperty("error"); // not "device"
    expect(resolveLocalSerial(devices, "ghost")).toHaveProperty("error"); // missing
  });
});

describe("connect session reuse", () => {
  it("starts only when there is no active Gateway session", () => {
    expect(shouldStartNewSession({ activeSession: null })).toBe(true);
    expect(shouldStartNewSession({ activeSession: { status: "ended" } })).toBe(true);
    expect(shouldStartNewSession({ activeSession: { status: "active" } })).toBe(false);
  });

  it("detects stale/expired reused sessions that warrant a re-mint", () => {
    expect(isStaleSessionError("init:token绑定的uuid与请求uuid不一致")).toBe(true);
    expect(isStaleSessionError("Session abc has already exited")).toBe(true);
    expect(isStaleSessionError("Invalid live token")).toBe(true);
    expect(isStaleSessionError("session not active")).toBe(true);
    expect(isStaleSessionError("ECONNREFUSED")).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });

  it("formats exhausted usage-balance errors with billing guidance", () => {
    const copy = startBlockedCopy(
      new ApiError(
        409,
        "USAGE_BALANCE_EXHAUSTED",
        "Free minutes and wallet balance are exhausted"
      )
    );

    expect(copy).toMatchObject({
      code: "USAGE_BALANCE_EXHAUSTED",
      message: expect.stringContaining("wallet balance"),
    });
    expect(copy?.nextSteps.join("\n")).toContain("billing settings");
  });

  it("formats concurrent-session quota errors with device-list guidance", () => {
    const copy = startBlockedCopy(
      new ApiError(409, "SESSION_QUOTA_EXCEEDED", "max concurrent sessions reached")
    );

    expect(copy).toMatchObject({
      code: "SESSION_QUOTA_EXCEEDED",
      message: expect.stringContaining("Concurrent session limit"),
    });
    expect(copy?.nextSteps.join("\n")).toContain(
      "handheld devices --status active"
    );
    expect(copy?.nextSteps.join("\n")).toContain("handheld disconnect");
  });
});
