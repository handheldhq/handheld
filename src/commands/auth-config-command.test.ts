import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config command secret display", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalHandheldApiKey: string | undefined;
  let originalMobileUseApiKey: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalHandheldApiKey = process.env.HANDHELD_API_KEY;
    originalMobileUseApiKey = process.env.MOBILEUSE_API_KEY;
    home = mkdtempSync(join(tmpdir(), "handheld-auth-config-test-"));
    process.env.HOME = home;
    delete process.env.HANDHELD_API_KEY;
    delete process.env.MOBILEUSE_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHandheldApiKey === undefined) delete process.env.HANDHELD_API_KEY;
    else process.env.HANDHELD_API_KEY = originalHandheldApiKey;
    if (originalMobileUseApiKey === undefined) delete process.env.MOBILEUSE_API_KEY;
    else process.env.MOBILEUSE_API_KEY = originalMobileUseApiKey;
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

  async function runAuth(args: string[]): Promise<string> {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { registerAuthCommands } = await import("./auth.js");
    const program = new Command().name("handheld").exitOverride();
    registerAuthCommands(program);
    await program.parseAsync(args, { from: "user" });
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

  it("prints config get api-key raw when explicitly requested", async () => {
    const fullKey = "muk_secret_value_123456";
    const state = await import("../state.js");
    state.setConfig({ apiKey: fullKey });

    const output = await runConfig(["get", "api-key", "--raw"]);

    expect(output).toBe(fullKey);
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

  it("resolves API keys from env before saved config and reports the source", async () => {
    const state = await import("../state.js");
    state.setConfig({ apiKey: "muk_config_value" });
    process.env.HANDHELD_API_KEY = "muk_env_value";

    const auth = await import("./auth.js");

    expect(auth.configuredApiAuth()).toEqual({
      apiKey: "muk_env_value",
      source: "env",
    });
    expect(auth.configuredApiKey()).toBe("muk_env_value");
  });

  it("persists env auth as the global init fallback key", async () => {
    process.env.HANDHELD_API_KEY = "muk_env_bootstrap";

    await runAuth(["init", "--no-device", "--no-harness-workspace", "--api-url", "https://api.test"]);

    const state = await import("../state.js");
    expect(state.getConfig()).toMatchObject({
      apiKey: "muk_env_bootstrap",
      apiUrl: "https://api.test",
    });
  });

  it("scaffolds a project harness workspace during init", async () => {
    process.env.HANDHELD_API_KEY = "muk_env_bootstrap";
    const project = join(home, "project");

    const output = await runAuth([
      "init",
      "--no-device",
      "--api-url",
      "https://api.test",
      "--workspace",
      project,
    ]);

    const mcpPath = join(project, ".handheld", "mcp.json");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(existsSync(join(project, ".handheld", "runs"))).toBe(true);
    expect(existsSync(join(project, "agent-space", "helpers", "agent_helpers.py"))).toBe(true);
    expect(existsSync(join(project, "agent-space", "skills", "interaction", "mobile", "observe-and-act.md"))).toBe(true);
    expect(existsSync(join(project, "agent-space", "skills", "domain", "README.md"))).toBe(true);
    expect(mcp.mcpServers.handheld.env).toEqual({
      HANDHELD_API_URL: "https://api.test",
      HANDHELD_EVIDENCE_DIR: join(project, "agent-space", "evidence"),
    });
    expect(mcp.mcpServers.handheld.args).toContain("--mcp");
    expect(mcp.mcpServers.handheld.args).not.toContain("--device");
    expect(output).toContain(`Workspace: ${project}`);
    expect(output).toContain(`Agent space: ${join(project, "agent-space")}`);
    expect(output).toContain(`MCP config: ${mcpPath}`);
  });

  it("points missing cloud auth at env-first setup", async () => {
    const auth = await import("../auth.js");

    expect(() => auth.requireApiKey()).toThrow(
      "No API key configured. Set HANDHELD_API_KEY for cloud devices, or run `handheld login` to store a local key."
    );
  });
});
