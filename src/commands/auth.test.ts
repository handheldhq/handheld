import { afterEach, describe, expect, it } from "vitest";
import {
  configuredApiKey,
  isTerminalDeviceFailureStatus,
  resolveLoginApiUrl,
} from "./auth.js";

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

describe("device readiness polling", () => {
  it("treats failed provisioning states as terminal", () => {
    expect(isTerminalDeviceFailureStatus("failed")).toBe(true);
    expect(isTerminalDeviceFailureStatus("needs_repair")).toBe(true);
    expect(isTerminalDeviceFailureStatus("ready")).toBe(false);
    expect(isTerminalDeviceFailureStatus("provisioning")).toBe(false);
  });
});
