import { afterEach, describe, expect, it } from "vitest";
import {
  configuredApiKey,
  isTerminalDeviceFailureStatus,
  resolveLocalInitSerial,
  resolveLoginApiUrl,
} from "./auth.js";
import { maskApiKey } from "../redact.js";

describe("config secret display", () => {
  it("masks API keys for keyed and full config output", () => {
    expect(maskApiKey("muk_1234567890abcdef")).toBe("muk_1234...");
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("   ")).toBe("");
  });
});

describe("configuredApiKey (lets init skip browser sign-in)", () => {
  afterEach(() => {
    delete process.env.HANDHELD_API_KEY;
    delete process.env.MOBILEUSE_API_KEY;
  });

  it("returns the HANDHELD_API_KEY env value, trimmed", () => {
    process.env.HANDHELD_API_KEY = "  muk_envkey  ";
    expect(configuredApiKey()).toBe("muk_envkey");
  });

  it("falls back to MOBILEUSE_API_KEY when HANDHELD_API_KEY is unset", () => {
    process.env.MOBILEUSE_API_KEY = "muk_legacy";
    expect(configuredApiKey()).toBe("muk_legacy");
  });

  it("prefers HANDHELD_API_KEY over MOBILEUSE_API_KEY", () => {
    process.env.HANDHELD_API_KEY = "muk_primary";
    process.env.MOBILEUSE_API_KEY = "muk_legacy";
    expect(configuredApiKey()).toBe("muk_primary");
  });

  it("ignores a whitespace-only env key (does not return empty)", () => {
    process.env.HANDHELD_API_KEY = "   ";
    // Falls through to saved config; whatever it returns must not be the blank env value.
    expect(configuredApiKey()).not.toBe("");
    expect(configuredApiKey()).not.toBe("   ");
  });
});

describe("resolveLoginApiUrl", () => {
  afterEach(() => {
    delete process.env.HANDHELD_API_URL;
    delete process.env.MOBILE_USE_API_URL;
  });

  it("uses an explicit CLI API URL first", () => {
    process.env.HANDHELD_API_URL = "https://env.gateway.test";

    expect(resolveLoginApiUrl("https://flag.gateway.test/")).toBe(
      "https://flag.gateway.test"
    );
  });

  it("uses the environment when the CLI flag is omitted", () => {
    process.env.HANDHELD_API_URL = "https://env.gateway.test/";

    expect(resolveLoginApiUrl()).toBe("https://env.gateway.test");
  });
});

describe("resolveLocalInitSerial (init --local device selection)", () => {
  afterEach(() => {
    delete process.env.HANDHELD_DEVICE;
  });

  it("prefers an explicit --local-serial over everything", () => {
    expect(
      resolveLocalInitSerial("emulator-5554", "emulator-5556", "emulator-5558")
    ).toBe("emulator-5554");
  });

  it("falls back to the root --device flag when --local-serial is absent", () => {
    expect(resolveLocalInitSerial(undefined, "emulator-5556")).toBe(
      "emulator-5556"
    );
  });

  it("honors HANDHELD_DEVICE env when no flag is given (the documented promise)", () => {
    expect(resolveLocalInitSerial(undefined, undefined, "emulator-5558")).toBe(
      "emulator-5558"
    );
  });

  it("reads HANDHELD_DEVICE from the environment by default", () => {
    process.env.HANDHELD_DEVICE = "emulator-5560";
    expect(resolveLocalInitSerial()).toBe("emulator-5560");
  });

  it("returns undefined (auto-select) when nothing is set, trimming blanks", () => {
    expect(resolveLocalInitSerial()).toBeUndefined();
    expect(resolveLocalInitSerial("   ", "  ", "  ")).toBeUndefined();
  });
});

describe("device readiness polling", () => {
  it("treats failed provisioning states as terminal", () => {
    expect(isTerminalDeviceFailureStatus("failed")).toBe(true);
    expect(isTerminalDeviceFailureStatus("needs_repair")).toBe(true);
    expect(isTerminalDeviceFailureStatus("ready")).toBe(false);
    expect(isTerminalDeviceFailureStatus("provisioning")).toBe(false);
  });
});
