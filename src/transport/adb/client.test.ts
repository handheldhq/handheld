import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

// Imported after the mock is registered so the transport binds to it.
const { AdbTransport } = await import("./client.js");

function adbArgv(call: unknown[]): string {
  return (call[1] as string[]).join(" ");
}

afterEach(() => execFileSync.mockReset());

describe("AdbTransport clipboard on modern Android (cmd clipboard unimplemented)", () => {
  it("does not report success when `cmd clipboard set` is unsupported", async () => {
    // API 31+ prints this to stderr with exit 0 (no throw); clipboard() merges
    // stderr via `2>&1`, so exec returns it here. The broadcast fallback finds
    // no receiver (result=0).
    execFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      const line = argv.join(" ");
      if (line.includes("cmd clipboard set")) return "No shell command implementation.";
      if (line.includes("am broadcast")) return "Broadcast completed: result=0";
      return "";
    });

    const result = await new AdbTransport("emulator-5554").clipboard("set", "hello");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ADB transport/i);
    // It must have attempted the broadcast fallback, not stopped at the no-op.
    expect(execFileSync.mock.calls.some((c) => adbArgv(c).includes("am broadcast"))).toBe(true);
  });

  it("does not leak the unsupported message as clipboard get data", async () => {
    execFileSync.mockReturnValue("No shell command implementation.");
    const result = await new AdbTransport("emulator-5554").clipboard("get");
    expect(result.ok).toBe(false);
    expect(result.data ?? "").not.toContain("No shell command implementation");
  });

  it("reports success when a Clipper receiver handles the broadcast", async () => {
    execFileSync.mockImplementation((_cmd: string, argv: string[]) => {
      const line = argv.join(" ");
      if (line.includes("cmd clipboard set")) return "No shell command implementation.";
      if (line.includes("am broadcast")) return "Broadcast completed: result=-1";
      return "";
    });
    const result = await new AdbTransport("emulator-5554").clipboard("set", "hello");
    expect(result.ok).toBe(true);
  });

  it("uses the native cmd clipboard path when it is supported", async () => {
    execFileSync.mockReturnValue(""); // older Android: set succeeds silently
    const result = await new AdbTransport("emulator-5554").clipboard("set", "hello");
    expect(result.ok).toBe(true);
    // Should not need the broadcast fallback.
    expect(execFileSync.mock.calls.some((c) => adbArgv(c).includes("am broadcast"))).toBe(false);
  });
});
