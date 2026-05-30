import { afterEach, describe, expect, it } from "vitest";
import { isTerminalDeviceFailureStatus, resolveLoginApiUrl } from "./auth.js";

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
