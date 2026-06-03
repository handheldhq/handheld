import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config command secret display", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalHandheldBin: string | undefined;
  let originalHandheldApiKey: string | undefined;
  let originalMobileUseApiKey: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalHandheldBin = process.env.HANDHELD_BIN;
    originalHandheldApiKey = process.env.HANDHELD_API_KEY;
    originalMobileUseApiKey = process.env.MOBILEUSE_API_KEY;
    home = mkdtempSync(join(tmpdir(), "handheld-auth-config-test-"));
    process.env.HOME = home;
    delete process.env.HANDHELD_BIN;
    delete process.env.HANDHELD_API_KEY;
    delete process.env.MOBILEUSE_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHandheldBin === undefined) delete process.env.HANDHELD_BIN;
    else process.env.HANDHELD_BIN = originalHandheldBin;
    if (originalHandheldApiKey === undefined) delete process.env.HANDHELD_API_KEY;
    else process.env.HANDHELD_API_KEY = originalHandheldApiKey;
    if (originalMobileUseApiKey === undefined) delete process.env.MOBILEUSE_API_KEY;
    else process.env.MOBILEUSE_API_KEY = originalMobileUseApiKey;
    rmSync(home, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("scaffolds a project harness agent space during init", async () => {
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
    expect(existsSync(join(project, "agent-space", "skills", "domain", "_template.md"))).toBe(true);
    expect(mcp.mcpServers.handheld.env).toEqual({
      HANDHELD_AGENT_SPACE: join(project, "agent-space"),
      HANDHELD_API_URL: "https://api.test",
      HANDHELD_EVIDENCE_DIR: join(project, "agent-space", "evidence"),
      HANDHELD_PROJECT_AGENT_SPACE_DIR: join(project, "agent-space"),
      HANDHELD_RUN_AGENT_SPACE_DIR: join(project, "agent-space"),
    });
    expect(mcp.mcpServers.handheld.command).toBe("handheld");
    expect(mcp.mcpServers.handheld.args).toContain("--mcp");
    expect(mcp.mcpServers.handheld.args).not.toContain("--device");
    expect(output).toContain(`Workspace: ${project}`);
    expect(output).toContain(`Agent space: ${join(project, "agent-space")}`);
    expect(output).toContain(`MCP config: ${mcpPath}`);
  });

  it("scaffolds a local init workflow without cloud auth", async () => {
    const project = join(home, "local-project");

    const output = await runAuth([
      "init",
      "--local",
      "--no-connect",
      "--workspace",
      project,
    ]);

    const state = await import("../state.js");
    const mcpPath = join(project, ".handheld", "mcp.json");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(state.getConfig().apiKey).toBeUndefined();
    expect(existsSync(join(project, ".handheld", "runs"))).toBe(true);
    expect(existsSync(join(project, "agent-space", "helpers", "agent_helpers.py"))).toBe(true);
    expect(mcp.mcpServers.handheld.env).toMatchObject({
      HANDHELD_API_URL: "",
      HANDHELD_EVIDENCE_DIR: join(project, "agent-space", "evidence"),
      HANDHELD_PROJECT_AGENT_SPACE_DIR: join(project, "agent-space"),
      HANDHELD_RUN_AGENT_SPACE_DIR: join(project, "agent-space"),
    });
    expect(mcp.mcpServers.handheld.command).toBe("handheld");
    expect(mcp.mcpServers.handheld.args).toContain("--mcp");
    expect(mcp.mcpServers.handheld.args).not.toContain("--device");
    expect(output).toContain("Next: handheld connect --local");
    expect(output).toContain(`Agent space: ${join(project, "agent-space")}`);
  });

  it("lets HANDHELD_BIN override the durable project MCP command", async () => {
    process.env.HANDHELD_BIN = "/tmp/handheld-dev";
    const project = join(home, "bin-project");

    await runAuth([
      "init",
      "--local",
      "--no-connect",
      "--workspace",
      project,
    ]);

    const mcp = JSON.parse(readFileSync(join(project, ".handheld", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.handheld.command).toBe("/tmp/handheld-dev");
    expect(mcp.mcpServers.handheld.args).toEqual(["--mcp"]);
  });

  it("can scaffold local init MCP args for a known adb serial without connecting", async () => {
    const project = join(home, "serial-project");

    await runAuth([
      "init",
      "--local",
      "--no-connect",
      "--local-serial",
      "emulator-5554",
      "--workspace",
      project,
    ]);

    const mcp = JSON.parse(readFileSync(join(project, ".handheld", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.handheld.command).toBe("handheld");
    expect(mcp.mcpServers.handheld.args).toContain("--device");
    expect(mcp.mcpServers.handheld.args).toContain("emulator-5554");
  });

  it("points missing cloud auth at env-first setup", async () => {
    const auth = await import("../auth.js");

    expect(() => auth.requireApiKey()).toThrow(
      "No API key configured. Set HANDHELD_API_KEY for cloud devices, or run `handheld login` to store a local key."
    );
  });

  it("branches init failure hints by browser, local adb, and cloud failures", async () => {
    const auth = await import("./auth.js");
    const { ApiError } = await import("../api-client.js");

    expect(auth.initFailureHint(new Error("Timed out waiting for browser approval."))).toContain(
      "browser approval needs a human"
    );
    expect(auth.initFailureHint(new Error("No adb device in 'device' state"), { local: true })).toContain(
      "handheld connect --help"
    );
    expect(auth.initFailureHint(new ApiError(402, "NO_BALANCE", "No trial pool hardware"))).toContain(
      "handheld billing"
    );
  });

  it("reports the ready init handoff with deviceId and sessionId only", async () => {
    const calls: Array<{ body?: Record<string, unknown>; method: string; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined;
        calls.push({ body, method: init?.method ?? "GET", path: url.pathname + url.search });

        if (url.pathname === "/cli/device-code") {
          return new Response(JSON.stringify({
            deviceCode: "dc_1",
            expiresInSeconds: 10,
            ok: true,
            pollIntervalSeconds: 0,
            userCode: "ABCD",
            verificationUrl: "https://app.test/claim?code=ABCD",
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/cli/device-code/poll") {
          return new Response(JSON.stringify({
            apiKeyPrefix: "muk_test",
            apiUrl: "https://api.test",
            ok: true,
            status: "approved",
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/cli/init-device") {
          return new Response(JSON.stringify({
            deviceId: "prof_claim",
            ok: true,
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/profiles/prof_claim") {
          return new Response(JSON.stringify({
            profile: {
              id: "prof_claim",
              status: "ready",
            },
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/profiles/prof_claim/sessions") {
          return new Response(JSON.stringify({
            h5: {
              baseUrl: "https://h5.test",
              relayUrl: "/webrtc/relay/live?role=cli",
              token: "h5_should_not_be_handed_off",
              viewerUrl: "/live/live-token",
            },
            ok: true,
            session: {
              id: "sess_claim",
              status: "active",
            },
          }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/cli/device-code/handoff") {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ ok: false, message: "unexpected " + url.pathname }), {
          headers: { "content-type": "application/json" },
          status: 404,
        });
      }),
    );

    await runAuth([
      "init",
      "--no-open",
      "--no-connect",
      "--no-harness-workspace",
      "--api-url",
      "https://api.test",
    ]);

    expect(calls.find((call) => call.path === "/cli/device-code")?.body).toMatchObject({
      intent: "init",
    });
    const handoffs = calls.filter((call) => call.path === "/cli/device-code/handoff");
    expect(handoffs.map((call) => call.body?.status)).toEqual([
      "provisioning",
      "provisioning",
      "starting",
      "ready",
    ]);
    const ready = handoffs.at(-1)?.body;
    expect(ready).toMatchObject({
      deviceCode: "dc_1",
      deviceId: "prof_claim",
      sessionId: "sess_claim",
      status: "ready",
    });
    expect(JSON.stringify(ready)).not.toMatch(/h5_should_not_be_handed_off|viewerUrl|relayUrl|token/i);
  });
});
