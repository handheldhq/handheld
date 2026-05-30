import { describe, expect, it } from "vitest";
import {
  encodeAdbInputText,
  isShellCommandUnsupported,
  quoteDeviceShellArg,
} from "./text.js";

describe("ADB text helpers", () => {
  it("encodes spaces for adb input text", () => {
    expect(encodeAdbInputText("hello world")).toBe("hello%sworld");
  });

  it("preserves percent signs while encoding spaces", () => {
    expect(encodeAdbInputText("50% complete")).toBe("50%%scomplete");
  });

  it("quotes clipboard text for device shell execution", () => {
    expect(quoteDeviceShellArg("rock'n'roll")).toBe(`'rock'"'"'n'"'"'roll'`);
  });

  it("treats the Android unsupported-shell-command message as a failure", () => {
    // `cmd clipboard set` on API 31+ returns this on stdout with exit 0.
    expect(isShellCommandUnsupported("No shell command implementation.")).toBe(true);
    expect(isShellCommandUnsupported("No shell command implementation")).toBe(true);
  });

  it("does not flag real clipboard output as unsupported", () => {
    expect(isShellCommandUnsupported("clipboard text: hello")).toBe(false);
    expect(isShellCommandUnsupported("")).toBe(false);
    expect(isShellCommandUnsupported("null")).toBe(false);
  });
});
