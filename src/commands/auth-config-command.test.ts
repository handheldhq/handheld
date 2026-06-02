import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config command secret display", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "handheld-auth-config-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runConfig(args: string[]): Promise<string> {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { registerAuthCommands } = await import("./auth.js");
    const program = new Command().name("handheld").exitOverride();
    registerAuthCommands(program);
    await program.parseAsync(["config", ...args], { from: "user" });
    return output.join("\n");
  }

  it("masks config get api-key", async () => {
    const fullKey = "muk_secret_value_123456";
    const state = await import("../state.js");
    state.setConfig({ apiKey: fullKey });

    const output = await runConfig(["get", "api-key"]);

    expect(output).toBe("muk_secr...");
    expect(output).not.toContain(fullKey);
  });

  it("masks apiKey when dumping the full config", async () => {
    const fullKey = "muk_secret_value_123456";
    const state = await import("../state.js");
    state.setConfig({ apiKey: fullKey, apiUrl: "https://api.test" });

    const output = await runConfig(["get"]);
    const parsed = JSON.parse(output);

    expect(parsed.apiKey).toBe("muk_secr...");
    expect(output).not.toContain(fullKey);
    expect(parsed.apiUrl).toBe("https://api.test");
  });
});
