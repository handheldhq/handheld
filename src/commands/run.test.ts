import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentEnv,
  buildCodexRunPlan,
  buildClaudeRunPlan,
  buildTinyWarmupPlan,
  createRunWorkspace,
} from "./run.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "handheld-run-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("handheld run workspace", () => {
  it("creates an isolated Mobile Use workspace with MCP config and agent instructions", () => {
    const root = tempRoot();
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      now: new Date("2026-05-27T12:34:56Z"),
      runsDir: root,
      task: "Open Settings and verify Wi-Fi is visible",
    });

    expect(workspace.workspaceDir).toContain(root);
    expect(workspace.runId).toContain("open-settings-and-verify-wi-fi");

    const mcp = JSON.parse(readFileSync(workspace.mcpConfigPath, "utf8"));
    expect(mcp).toEqual({
      mcpServers: {
        handheld: {
          args: ["handheld", "--device", "dev_123", "--mcp"],
          command: "node",
          env: { HANDHELD_API_URL: "https://api.test" },
        },
      },
    });

    expect(readFileSync(workspace.agentsPath, "utf8")).toContain(
      "Use only the handheld MCP tools",
    );
    expect(readFileSync(workspace.claudePath, "utf8")).toContain(
      "Do not rely on global Claude settings",
    );
    expect(readFileSync(workspace.promptPath, "utf8")).toContain(
      "Start by observing the phone with snap",
    );
  });
});

describe("Claude run plan", () => {
  it("locks Claude to the generated MCP config and disables inherited settings without disabling persistence", () => {
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: tempRoot(),
      task: "Do the task",
    });
    const plan = buildClaudeRunPlan({
      agent: "claude",
      apiUrl: "https://api.test",
      claudeCommand: "claude",
      mcpConfigPath: "/tmp/mcp.json",
      mcpServer: workspace.mcpServer,
      model: "sonnet",
      prompt: "Do the task",
      workspaceDir: workspace.workspaceDir,
    });

    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual([
      "-p",
      "--disable-slash-commands",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__handheld__*",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "text",
      "--model",
      "sonnet",
      "Do the task",
    ]);
  });

  it("builds a Codex exec plan with ignored user config and explicit MCP config", () => {
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: tempRoot(),
      task: "Observe",
    });
    const plan = buildCodexRunPlan({
      agent: "codex",
      apiUrl: "https://api.test",
      codexCommand: "codex",
      mcpConfigPath: workspace.mcpConfigPath,
      mcpServer: workspace.mcpServer,
      model: "gpt-5",
      prompt: "Observe",
      workspaceDir: workspace.workspaceDir,
    });

    expect(plan.command).toBe("codex");
    expect(plan.stdin).toBe("Observe");
    expect(plan.args).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-C",
      workspace.workspaceDir,
      "-c",
      'mcp_servers.handheld.command="node"',
      "-c",
      'mcp_servers.handheld.args=["handheld", "--device", "dev_123", "--mcp"]',
      "-c",
      'mcp_servers.handheld.env.HANDHELD_API_URL="https://api.test"',
      "-m",
      "gpt-5",
      "-",
    ]);
  });

  it("starts Tiny bootstrap in the prepared run workspace", () => {
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: tempRoot(),
      task: "Observe",
    });
    const plan = buildTinyWarmupPlan({
      apiUrl: "https://api.test",
      deviceId: "dev_123",
      workspace,
    });

    expect(plan.command).toBe(process.execPath);
    expect(plan.args.slice(-3)).toEqual(["--json", "tiny", "bootstrap"]);
    expect(plan.args).toContain("--device");
    expect(plan.args).toContain("dev_123");
    expect(plan.logPath).toBe(join(workspace.workspaceDir, "logs", "tiny-bootstrap.log"));
  });

  it("strips provider API-key env by default but can preserve it explicitly", () => {
    const env = buildAgentEnv(
      {
        ANTHROPIC_API_KEY: "secret",
        ANTHROPIC_AUTH_TOKEN: "token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        PATH: "/bin",
      },
      { agent: "claude" },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.PATH).toBe("/bin");

    const kept = buildAgentEnv(
      { ANTHROPIC_API_KEY: "secret", PATH: "/bin" },
      { agent: "claude", allowApiKeyEnv: true },
    );
    expect(kept.ANTHROPIC_API_KEY).toBe("secret");

    const codex = buildAgentEnv(
      {
        CODEX_API_KEY: "codex-secret",
        OPENAI_API_KEY: "openai-secret",
        PATH: "/bin",
      },
      { agent: "codex" },
    );
    expect(codex.CODEX_API_KEY).toBeUndefined();
    expect(codex.OPENAI_API_KEY).toBeUndefined();
    expect(codex.PATH).toBe("/bin");

    const codexKept = buildAgentEnv(
      {
        CODEX_API_KEY: "codex-secret",
        OPENAI_API_KEY: "openai-secret",
        PATH: "/bin",
      },
      { agent: "codex", allowApiKeyEnv: true },
    );
    expect(codexKept.CODEX_API_KEY).toBe("codex-secret");
    expect(codexKept.OPENAI_API_KEY).toBe("openai-secret");
  });

  it("builds an interactive Claude TUI plan without print-mode flags", () => {
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: tempRoot(),
      task: "Observe",
    });
    const plan = buildClaudeRunPlan({
      agent: "claude",
      apiUrl: "https://api.test",
      claudeCommand: "claude",
      interactive: true,
      mcpConfigPath: workspace.mcpConfigPath,
      mcpServer: workspace.mcpServer,
      prompt: "Observe",
      workspaceDir: workspace.workspaceDir,
    });

    expect(plan.interactive).toBe(true);
    expect(plan.args).not.toContain("-p");
    expect(plan.args).not.toContain("--output-format");
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.args.at(-1)).toBe("Observe");
  });
});
