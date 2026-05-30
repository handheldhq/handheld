import { describe, expect, it } from "vitest";
import {
  relaySwipeShellCommand,
  relayTapShellCommand,
} from "./client.js";

describe("relay shell input commands", () => {
  it("uses device shell tap for relay taps", () => {
    expect(relayTapShellCommand({ x: 120.4, y: 480.6 })).toBe("input tap 120 481");
  });

  it("uses shell swipe for long press", () => {
    expect(relayTapShellCommand({ duration: 750, longPress: true, x: 10, y: 20 }))
      .toBe("input swipe 10 20 10 20 750");
  });

  it("uses device shell swipe for relay swipes", () => {
    expect(relaySwipeShellCommand({ x1: 1, y1: 2, x2: 3, y2: 4 })).toBe(
      "input swipe 1 2 3 4 300",
    );
  });
});
