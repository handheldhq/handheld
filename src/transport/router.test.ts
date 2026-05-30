import { describe, expect, it } from "vitest";
import { parseAdbArgs, routeCommand } from "./router.js";

describe("routeCommand", () => {
  it("prefers relay for interactive commands when available", () => {
    expect(routeCommand("tap", true)).toBe("relay");
    expect(routeCommand("screenshot", true)).toBe("relay");
    expect(routeCommand("shell", true)).toBe("relay");
  });

  it("falls back to adb for adb-only commands", () => {
    expect(routeCommand("install", true)).toBe("adb");
    expect(routeCommand("pull", true)).toBe("adb");
  });
});

describe("parseAdbArgs", () => {
  it("parses input tap commands", () => {
    expect(parseAdbArgs(["shell", "input", "tap", "120", "480"])).toEqual({
      transport: "relay",
      command: "tap",
      args: { x: 120, y: 480 },
    });
  });

  it("parses exec-out screencap commands", () => {
    expect(parseAdbArgs(["exec-out", "screencap", "-p"])).toEqual({
      transport: "relay",
      command: "screenshot",
      args: {},
    });
  });

  it("parses exec-out uiautomator dump commands", () => {
    expect(parseAdbArgs(["exec-out", "uiautomator", "dump", "/dev/tty"])).toEqual({
      transport: "relay",
      command: "snapshot_xml",
      args: {},
    });
  });

  it("parses generic shell commands", () => {
    expect(parseAdbArgs(["shell", "pm", "list", "packages"])).toEqual({
      transport: "relay",
      command: "shell",
      args: { command: "pm list packages" },
    });
  });
});
