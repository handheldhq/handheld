import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentEnv,
  buildCodexRunPlan,
  buildClaudeRunPlan,
  buildRunEvidenceCapturePlan,
  buildTinyWarmupPlan,
  createRunWorkspace,
  registerRunCommand,
  runLocalAgent,
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
          env: {
            HANDHELD_AGENT_SPACE: workspace.agentSpacePath,
            HANDHELD_API_URL: "https://api.test",
            HANDHELD_EVIDENCE_DIR: workspace.evidencePath,
            HANDHELD_PROJECT_AGENT_SPACE_DIR: workspace.projectAgentSpacePath,
            HANDHELD_RUN_AGENT_SPACE_DIR: workspace.agentSpacePath,
          },
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
    expect(
      existsSync(join(workspace.workspaceDir, "agent-space", "helpers", "agent_helpers.py")),
    ).toBe(false);
    expect(existsSync(workspace.evidencePath)).toBe(true);
  });

  it("creates harness agent-space helpers, interaction skills, and evidence docs", () => {
    const root = tempRoot();
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: root,
      task: "Inspect screen",
      workspaceTemplate: "harness",
    });

    const agentSpace = join(workspace.workspaceDir, "agent-space");
    expect(readFileSync(join(agentSpace, "README.md"), "utf8")).toContain(
      "harness-shaped mobile agent space",
    );
    expect(readFileSync(join(agentSpace, "helpers", "agent_helpers.py"), "utf8")).toContain(
      "not a second runtime",
    );
    expect(readFileSync(join(agentSpace, "skills", "domain", "_template.md"), "utf8")).toContain(
      "Activity checkpoint",
    );
    expect(readFileSync(workspace.importedDomainSkills.manifestPath, "utf8")).toContain(
      "projectDomainSkillsDir",
    );
    expect(
      existsSync(join(agentSpace, "skills", "interaction", "mobile", "observe-and-act.md")),
    ).toBe(true);
    expect(readFileSync(join(agentSpace, "evidence", "README.md"), "utf8")).toContain(
      "Capture final",
    );
  });

  it("prepares a local harness dry run without requiring cloud API configuration", async () => {
    const workspaceDir = tempRoot();
    const previousApiUrl = process.env.HANDHELD_API_URL;
    delete process.env.HANDHELD_API_URL;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });
    try {
      await runLocalAgent(
        "Observe",
        {
          agent: "codex",
          dryRun: true,
          local: true,
          localSerial: "emulator-5554",
          workspace: workspaceDir,
          workspaceTemplate: "harness",
        },
        { json: true },
      );
    } finally {
      spy.mockRestore();
      if (previousApiUrl === undefined) {
        delete process.env.HANDHELD_API_URL;
      } else {
        process.env.HANDHELD_API_URL = previousApiUrl;
      }
    }

    const prepared = JSON.parse(logs.join("\n"));
    expect(prepared.ok).toBe(true);
    expect(prepared.workspace).toBe(workspaceDir);
    expect(prepared.agentSpace).toBe(join(workspaceDir, "agent-space"));
    expect(prepared.evidence).toBe(join(workspaceDir, "agent-space", "evidence"));
    expect(prepared.connected).toBeNull();
    expect(prepared.args).toContain(
      `mcp_servers.handheld.env.HANDHELD_AGENT_SPACE="${workspaceDir}/agent-space"`,
    );
    expect(prepared.args).toContain('mcp_servers.handheld.env.HANDHELD_API_URL=""');
    expect(prepared.args).toContain(
      `mcp_servers.handheld.env.HANDHELD_EVIDENCE_DIR="${workspaceDir}/agent-space/evidence"`,
    );
    expect(prepared.args).toContain(
      `mcp_servers.handheld.env.HANDHELD_RUN_AGENT_SPACE_DIR="${workspaceDir}/agent-space"`,
    );
    expect(
      prepared.args.find((arg: string) => arg.startsWith("mcp_servers.handheld.args=")),
    ).toContain("emulator-5554");
    expect(readFileSync(join(workspaceDir, "prompt.md"), "utf8")).toContain(
      'connect with deviceId "emulator-5554" and local true',
    );
    expect(readFileSync(join(workspaceDir, "agent-space", "helpers", "agent_helpers.py"), "utf8")).toContain(
      "from handheld_harness.helpers import *",
    );
  });

  it("omits fake local device selectors when local dry-run auto-selects adb", async () => {
    const workspaceDir = tempRoot();
    const previousApiUrl = process.env.HANDHELD_API_URL;
    delete process.env.HANDHELD_API_URL;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });
    try {
      await runLocalAgent(
        "Observe",
        {
          agent: "codex",
          dryRun: true,
          local: true,
          workspace: workspaceDir,
          workspaceTemplate: "harness",
        },
        { json: true },
      );
    } finally {
      spy.mockRestore();
      if (previousApiUrl === undefined) {
        delete process.env.HANDHELD_API_URL;
      } else {
        process.env.HANDHELD_API_URL = previousApiUrl;
      }
    }

    const prepared = JSON.parse(logs.join("\n"));
    const mcp = JSON.parse(readFileSync(prepared.mcpConfig, "utf8"));

    expect(prepared.connected).toBeNull();
    expect(mcp.mcpServers.handheld.args).not.toContain("--device");
    expect(mcp.mcpServers.handheld.args).not.toContain("local");
    expect(readFileSync(join(workspaceDir, "prompt.md"), "utf8")).toContain(
      "call connect with local true and no deviceId",
    );
  });

  it("parses --local before the task without consuming the task text", async () => {
    const workspaceDir = tempRoot();
    const previousApiUrl = process.env.HANDHELD_API_URL;
    delete process.env.HANDHELD_API_URL;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });
    const program = new Command().name("handheld").exitOverride().option("--json");
    registerRunCommand(program);

    try {
      await program.parseAsync(
        [
          "--json",
          "run",
          "--local",
          "--local-serial",
          "emulator-5554",
          "Observe",
          "--dry-run",
          "--agent",
          "codex",
          "--workspace",
          workspaceDir,
        ],
        { from: "user" },
      );
    } finally {
      spy.mockRestore();
      if (previousApiUrl === undefined) {
        delete process.env.HANDHELD_API_URL;
      } else {
        process.env.HANDHELD_API_URL = previousApiUrl;
      }
    }

    const prepared = JSON.parse(logs.join("\n"));
    expect(readFileSync(join(workspaceDir, "task.md"), "utf8")).toContain("Observe");
    expect(prepared.connected).toBeNull();
  });

  it("runs a non-dry local task with the connected serial in MCP and evidence capture", async () => {
    vi.resetModules();
    const workspaceDir = tempRoot();
    const logs: string[] = [];
    const spawnCalls: Array<{ args: string[]; command: string; cwd?: string }> = [];
    const spawnSyncCalls: Array<{ args: string[]; command: string }> = [];
    const connectLocalDevice = vi.fn(async () => ({
      adb: { serial: "emulator-5554" },
      deviceId: "emulator-5554",
      relay: { connected: false },
      tiny: null,
    }));
    vi.doMock("./connect.js", () => ({
      connectDevice: vi.fn(),
      connectLocalDevice,
    }));
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((command: string, args: string[], options: { cwd?: string }) => {
        spawnCalls.push({ args: [...args], command, cwd: options.cwd });
        const child = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          stdin: { end: (value?: string) => void; on: () => void };
          stdout: EventEmitter;
        };
        child.stdin = { end: () => undefined, on: () => undefined };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }),
      spawnSync: vi.fn((command: string, args: string[]) => {
        spawnSyncCalls.push({ args: [...args], command });
        return { signal: null, status: 0, stderr: "", stdout: "{\"ok\":true}\n" };
      }),
    }));
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(String(value));
    });

    try {
      const run = await import("./run.js");
      await run.runLocalAgent(
        "Observe",
        {
          agent: "codex",
          codex: "codex-test",
          local: true,
          tinyWarmup: false,
          workspace: workspaceDir,
          workspaceTemplate: "harness",
        },
        { json: true },
      );
    } finally {
      spy.mockRestore();
      vi.doUnmock("./connect.js");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }

    const result = JSON.parse(logs.join("\n"));
    const mcp = JSON.parse(readFileSync(join(workspaceDir, "mcp.json"), "utf8"));

    expect(connectLocalDevice).toHaveBeenCalledWith({
      json: true,
      serial: undefined,
      startTiny: false,
    });
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe("emulator-5554");
    expect(result.evidenceCaptures).toHaveLength(2);
    expect(result.evidenceCaptures.every((capture: { ok: boolean }) => capture.ok)).toBe(true);
    expect(spawnSyncCalls).toHaveLength(2);
    expect(spawnSyncCalls.every((call) => call.args.includes("emulator-5554"))).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({ command: "codex-test", cwd: workspaceDir });
    expect(mcp.mcpServers.handheld.args).toContain("--device");
    expect(mcp.mcpServers.handheld.args).toContain("emulator-5554");
    expect(mcp.mcpServers.handheld.env.HANDHELD_EVIDENCE_DIR).toBe(join(workspaceDir, "agent-space", "evidence"));
  });

  it("rejects a local serial without local mode", async () => {
    await expect(
      runLocalAgent(
        "Observe",
        {
          dryRun: true,
          localSerial: "emulator-5554",
          workspace: tempRoot(),
        },
        { json: true },
      ),
    ).rejects.toThrow("--local-serial requires --local");
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
      `mcp_servers.handheld.env.HANDHELD_AGENT_SPACE="${workspace.agentSpacePath}"`,
      "-c",
      'mcp_servers.handheld.env.HANDHELD_API_URL="https://api.test"',
      "-c",
      `mcp_servers.handheld.env.HANDHELD_EVIDENCE_DIR="${workspace.evidencePath}"`,
      "-c",
      `mcp_servers.handheld.env.HANDHELD_PROJECT_AGENT_SPACE_DIR="${workspace.projectAgentSpacePath}"`,
      "-c",
      `mcp_servers.handheld.env.HANDHELD_RUN_AGENT_SPACE_DIR="${workspace.agentSpacePath}"`,
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

  it("builds best-effort first/final evidence capture commands", () => {
    const workspace = createRunWorkspace({
      apiUrl: "https://api.test",
      cliArgs: ["handheld", "--device", "dev_123", "--mcp"],
      cliCommand: "node",
      deviceId: "dev_123",
      runsDir: tempRoot(),
      task: "Observe",
    });
    const plan = buildRunEvidenceCapturePlan({
      deviceId: "dev_123",
      label: "final state",
      now: new Date("2026-06-02T12:00:00Z"),
      workspace,
    });

    expect(plan.command).toBe(process.execPath);
    expect(plan.args.slice(-3)).toEqual(["--json", "snap", "--screenshot"]);
    expect(plan.args).toContain("--device");
    expect(plan.args).toContain("dev_123");
    expect(plan.path).toBe(join(workspace.evidencePath, "20260602T120000Z-final-state-snap.json"));
  });

  it("strips provider API-key env by default but can preserve it explicitly", () => {
    const env = buildAgentEnv(
      {
        ANTHROPIC_API_KEY: "secret",
        ANTHROPIC_AUTH_TOKEN: "token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        HANDHELD_API_KEY: "hk_env",
        HANDHELD_RUN_AGENT_SPACE_DIR: "/tmp/run-agent-space",
        PATH: "/bin",
        SECRET_TOKEN: "secret-token",
      },
      { agent: "claude" },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.HANDHELD_API_KEY).toBe("hk_env");
    expect(env.HANDHELD_RUN_AGENT_SPACE_DIR).toBe("/tmp/run-agent-space");
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
