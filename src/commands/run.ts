import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { AuthError, getResolvedDevice, requireApiKey, requireApiUrl } from "../auth.js";
import { connectDevice } from "./connect.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_AGENT = "claude";
const DEFAULT_ALLOWED_TOOLS = "mcp__handheld__*";
const SUPPORTED_AGENTS = ["claude", "codex"] as const;

export type AgentRuntime = (typeof SUPPORTED_AGENTS)[number];

type RootOptions = {
  device?: string;
  json?: boolean;
};

type RunCommandOptions = {
  agent?: string;
  allowApiKeyEnv?: boolean;
  claude?: string;
  codex?: string;
  dryRun?: boolean;
  interactive?: boolean;
  model?: string;
  tinyWarmup?: boolean;
  tui?: boolean;
  workspace?: string;
};

export type RunWorkspace = {
  agentsPath: string;
  claudePath: string;
  mcpConfigPath: string;
  mcpServer: HandheldMcpServerConfig;
  prompt: string;
  promptPath: string;
  runId: string;
  taskPath: string;
  workspaceDir: string;
};

export type RunWorkspaceInput = {
  apiUrl: string;
  cliArgs?: string[];
  cliCommand?: string;
  deviceId: string;
  now?: Date;
  runsDir?: string;
  task: string;
  workspace?: string;
};

export type AgentRunInput = {
  agent: AgentRuntime;
  allowedTools?: string;
  apiUrl: string;
  claudeCommand?: string;
  codexCommand?: string;
  mcpConfigPath: string;
  mcpServer: HandheldMcpServerConfig;
  model?: string;
  prompt: string;
  interactive?: boolean;
  workspaceDir: string;
};

export type AgentRunPlan = {
  agent: AgentRuntime;
  args: string[];
  command: string;
  interactive?: boolean;
  stdin?: string;
};

export type HandheldMcpServerConfig = {
  args: string[];
  command: string;
  env: {
    HANDHELD_API_URL: string;
  };
};

export type TinyWarmupPlan = {
  args: string[];
  command: string;
  logPath: string;
};

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("run a mobile task with a local agent")
    .argument("<task...>", "task for the local agent")
    .option("--agent <agent>", "agent runtime to spawn (claude or codex)", DEFAULT_AGENT)
    .option("--claude <path>", "Claude Code executable", "claude")
    .option("--codex <path>", "Codex executable", "codex")
    .option("--model <model>", "agent model alias or full model name")
    .option("--workspace <path>", "use an existing workspace directory instead of creating ./.handheld/runs/<id>")
    .option("--tui", "launch the local agent in interactive terminal mode instead of one-shot mode")
    .option("--interactive", "alias for --tui")
    .option("--dry-run", "prepare the workspace and print the agent command without connecting or spawning")
    .option("--no-tiny-warmup", "do not start Tiny helper bootstrap in the background after connect")
    .option("--allow-api-key-env", "allow provider API-key env vars to reach the agent instead of forcing local CLI auth")
    .action(async (taskParts: string[], options: RunCommandOptions, command: Command) => {
      const rootOptions = command.parent?.opts<RootOptions>() ?? {};
      try {
        await runLocalAgent(taskParts.join(" "), options, rootOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rootOptions.json) {
          console.error(JSON.stringify({ error: message, ok: false }));
        } else {
          console.error(`Run failed: ${message}`);
        }
        process.exit(1);
      }
    });
}

async function runLocalAgent(
  rawTask: string,
  options: RunCommandOptions,
  rootOptions: RootOptions,
): Promise<void> {
  const task = rawTask.trim();
  if (!task) throw new Error("task is required");
  const agent = normalizeAgentRuntime(options.agent);
  const interactive = options.interactive === true || options.tui === true;
  if (interactive && agent === "codex") {
    throw new Error("interactive Codex runs are not supported yet because Codex TUI cannot ignore user config; use `handheld run --agent codex` for locked headless runs");
  }

  const deviceId = getResolvedDevice(rootOptions.device);
  if (!deviceId) {
    throw new AuthError("No default device configured. Run `handheld init` first.");
  }

  const apiUrl = requireApiUrl();
  requireApiKey();

  const workspace = createRunWorkspace({
    apiUrl,
    deviceId,
    task,
    workspace: options.workspace,
  });

  let connected: Awaited<ReturnType<typeof connectDevice>> | null = null;
  let tinyWarmup: TinyWarmupPlan | null = null;
  if (!options.dryRun) {
    connected = await connectDevice({
      deviceId,
      json: true,
      startTiny: false,
      webrtcOnly: true,
    });
    if (options.tinyWarmup !== false) {
      tinyWarmup = startTinyWarmup({
        apiUrl,
        deviceId,
        workspace,
      });
    }
  }

  const plan = buildAgentRunPlan({
    agent,
    apiUrl,
    claudeCommand: options.claude,
    codexCommand: options.codex,
    mcpConfigPath: workspace.mcpConfigPath,
    mcpServer: workspace.mcpServer,
    model: options.model,
    prompt: workspace.prompt,
    interactive,
    workspaceDir: workspace.workspaceDir,
  });

  if (options.dryRun) {
    emitRunPrepared({
      connected,
      json: rootOptions.json,
      plan,
      tinyWarmup,
      workspace,
    });
    return;
  }

  const result = await spawnAgentRun(plan, {
    allowApiKeyEnv: options.allowApiKeyEnv === true,
    cwd: workspace.workspaceDir,
    interactive,
    json: rootOptions.json === true,
  });

  if (rootOptions.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          tinyWarmup,
          workspace: workspace.workspaceDir,
          deviceId,
          sessionId: connected?.sessionId ?? null,
        },
        null,
        2,
      ),
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(
      result.signal
        ? `${agent} exited from signal ${result.signal}`
        : `${agent} exited with code ${result.exitCode}`,
    );
  }
}

export function createRunWorkspace(input: RunWorkspaceInput): RunWorkspace {
  const runId = input.workspace
    ? basename(resolve(input.workspace))
    : buildRunId(input.task, input.now ?? new Date());
  const workspaceDir = resolve(input.workspace ?? join(input.runsDir ?? getProjectRunsDir(), runId));
  const agentWorkspaceDir = join(workspaceDir, "agent-workspace");
  const domainSkillsDir = join(agentWorkspaceDir, "domain-skills");
  const logsDir = join(workspaceDir, "logs");
  ensureDir(workspaceDir);
  ensureDir(agentWorkspaceDir);
  ensureDir(domainSkillsDir);
  ensureDir(logsDir);

  const mcpServer: HandheldMcpServerConfig = {
    args: input.cliArgs ?? defaultMcpArgs(input.deviceId),
    command: input.cliCommand ?? defaultMcpCommand(),
    env: {
      HANDHELD_API_URL: input.apiUrl,
    },
  };
  const mcpConfig = {
    mcpServers: {
      handheld: mcpServer,
    },
  };

  const prompt = renderPrompt({
    deviceId: input.deviceId,
    task: input.task,
    workspaceDir,
  });
  const agents = renderWorkspaceInstructions(input.deviceId);
  const taskMarkdown = `# Task\n\n${input.task}\n\n# Device\n\n${input.deviceId}\n`;

  const mcpConfigPath = join(workspaceDir, "mcp.json");
  const promptPath = join(workspaceDir, "prompt.md");
  const agentsPath = join(workspaceDir, "AGENTS.md");
  const claudePath = join(workspaceDir, "CLAUDE.md");
  const taskPath = join(workspaceDir, "task.md");

  writePrivateFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  writePrivateFile(promptPath, prompt);
  writePrivateFile(agentsPath, agents);
  writePrivateFile(claudePath, agents);
  writePrivateFile(taskPath, taskMarkdown);
  writePrivateFile(join(agentWorkspaceDir, "README.md"), renderAgentWorkspaceReadme());
  writePrivateFile(
    join(domainSkillsDir, "README.md"),
    renderDomainSkillsReadme(),
  );

  return {
    agentsPath,
    claudePath,
    mcpConfigPath,
    mcpServer,
    prompt,
    promptPath,
    runId,
    taskPath,
    workspaceDir,
  };
}

export function buildAgentRunPlan(input: AgentRunInput): AgentRunPlan {
  if (input.agent === "codex") return buildCodexRunPlan(input);
  return buildClaudeRunPlan(input);
}

export function buildClaudeRunPlan(input: AgentRunInput): AgentRunPlan {
  const args = [
    "--disable-slash-commands",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    input.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
  ];
  if (!input.interactive) {
    args.unshift("-p");
    args.push("--output-format", "text");
  }
  if (input.model?.trim()) {
    args.push("--model", input.model.trim());
  }
  args.push(input.prompt);
  return {
    agent: "claude",
    args,
    command: input.claudeCommand?.trim() || "claude",
    interactive: input.interactive === true,
  };
}

export function buildCodexRunPlan(input: AgentRunInput): AgentRunPlan {
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-C",
    input.workspaceDir,
    "-c",
    `mcp_servers.handheld.command=${tomlString(input.mcpServer.command)}`,
    "-c",
    `mcp_servers.handheld.args=${tomlStringArray(input.mcpServer.args)}`,
    "-c",
    `mcp_servers.handheld.env.HANDHELD_API_URL=${tomlString(input.apiUrl)}`,
  ];
  if (input.model?.trim()) {
    args.push("-m", input.model.trim());
  }
  args.push("-");
  return {
    agent: "codex",
    args,
    command: input.codexCommand?.trim() || "codex",
    interactive: false,
    stdin: input.prompt,
  };
}

export function buildAgentEnv(
  source: NodeJS.ProcessEnv,
  opts: { agent: AgentRuntime; allowApiKeyEnv?: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  if (!opts.allowApiKeyEnv) {
    if (opts.agent === "claude") {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      delete env.CLAUDE_CODE_USE_FOUNDRY;
    } else {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }
  }
  return env;
}

function spawnAgentRun(
  plan: AgentRunPlan,
  opts: { allowApiKeyEnv: boolean; cwd: string; interactive: boolean; json: boolean },
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: buildAgentEnv(process.env, {
        agent: plan.agent,
        allowApiKeyEnv: opts.allowApiKeyEnv,
      }),
      stdio: opts.interactive
        ? "inherit"
        : opts.json
          ? ["pipe", "pipe", "pipe"]
          : ["pipe", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (!opts.interactive) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(plan.stdin ?? undefined);
    }
    if (opts.json) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      resolvePromise({ exitCode, signal, stderr, stdout });
    });
  });
}

export function buildTinyWarmupPlan(input: {
  apiUrl: string;
  deviceId: string;
  workspace: RunWorkspace;
}): TinyWarmupPlan {
  return {
    args: [
      ...defaultCliArgs(input.deviceId),
      "--json",
      "tiny",
      "bootstrap",
    ],
    command: defaultMcpCommand(),
    logPath: join(input.workspace.workspaceDir, "logs", "tiny-bootstrap.log"),
  };
}

function startTinyWarmup(input: {
  apiUrl: string;
  deviceId: string;
  workspace: RunWorkspace;
}): TinyWarmupPlan {
  const plan = buildTinyWarmupPlan(input);
  writePrivateFile(
    plan.logPath,
    `Tiny warmup started ${new Date().toISOString()}\nCommand: ${plan.command} ${plan.args.map(shellQuote).join(" ")}\n\n`,
  );
  let logFd: number | null = null;
  try {
    logFd = openSync(plan.logPath, "a", FILE_MODE);
    const child = spawn(plan.command, plan.args, {
      detached: true,
      env: {
        ...process.env,
        HANDHELD_API_URL: input.apiUrl,
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    if (logFd != null) closeSync(logFd);
  }
  return plan;
}

function emitRunPrepared(input: {
  connected: Awaited<ReturnType<typeof connectDevice>> | null;
  json?: boolean;
  plan: AgentRunPlan;
  tinyWarmup: TinyWarmupPlan | null;
  workspace: RunWorkspace;
}): void {
  if (input.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: input.plan.command,
          args: input.plan.args,
          stdin: input.plan.stdin ? input.workspace.promptPath : null,
          workspace: input.workspace.workspaceDir,
          mcpConfig: input.workspace.mcpConfigPath,
          prompt: input.workspace.promptPath,
          connected: input.connected,
          tinyWarmup: input.tinyWarmup,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Workspace: ${input.workspace.workspaceDir}`);
  console.log(`MCP config: ${input.workspace.mcpConfigPath}`);
  console.log(`Prompt: ${input.workspace.promptPath}`);
  if (input.tinyWarmup) {
    console.log(`Tiny warmup log: ${input.tinyWarmup.logPath}`);
  }
  console.log(`Command: ${input.plan.command} ${input.plan.args.map(shellQuote).join(" ")}`);
  if (input.plan.stdin) console.log(`Stdin: ${input.workspace.promptPath}`);
}

function renderPrompt(input: {
  deviceId: string;
  task: string;
  workspaceDir: string;
}): string {
  return `You are a Handheld local agent running in an isolated workspace.

Workspace: ${input.workspaceDir}
Device: ${input.deviceId}

Task:
${input.task}

Rules:
- Use only the handheld MCP tools.
- Tiny helper bootstrap is already warming in the background. Start by observing the phone with snap; if it is still installing, wait briefly and retry.
- If the tool says no device is connected, call connect with deviceId "${input.deviceId}".
- Keep actions small and verify visible state after meaningful actions.
- Do not edit host files, run host shell commands, or use non-mobile tools.
- Keep durable app facts under agent-workspace/domain-skills if you discover reusable app behavior.
- If you get GENUINELY stuck on a device step (two distinct approaches tried and re-observed, a knowledge gap — not a transient), call teach_request to have a human demonstrate it; poll the returned envelope until status is "ready", then synthesize a reusable domain-skill from the trajectory (the teach-from-human skill). Reach for this last, not first.
- Final answer: concise outcome plus the evidence you observed.
`;
}

function renderWorkspaceInstructions(deviceId: string): string {
  return `# Handheld Run Workspace

This workspace is intentionally isolated for one local agent run.

- Target device: ${deviceId}
- Use only the handheld MCP tools exposed by mcp.json.
- Do not rely on global Claude settings, project settings, hooks, or non-mobile tools.
- Tiny helper bootstrap starts in the background when the run connects.
- agent-workspace/ is the only place for run-local helper notes.
- agent-workspace/domain-skills/ is for durable app facts: selectors, waits, traps, and verification checks.
`;
}

function renderAgentWorkspaceReadme(): string {
  return `# agent-workspace

Run-local helper notes live here. Keep source-of-truth actions in Handheld MCP tools.
`;
}

function renderDomainSkillsReadme(): string {
  return `# domain-skills

Capture durable app knowledge here: package names, stable labels, waits, traps, and verification checks.
Avoid secrets, run narration, and raw coordinates as primary instructions.
`;
}

function buildRunId(task: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slug = slugify(task).slice(0, 32) || "task";
  return `${stamp}-${slug}-${randomBytes(3).toString("hex")}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function defaultMcpCommand(): string {
  return process.execPath;
}

function getProjectRunsDir(): string {
  return resolve(process.cwd(), ".handheld", "runs");
}

function defaultCliArgs(deviceId: string): string[] {
  const cliPath = process.argv[1];
  if (!cliPath) return ["--device", deviceId];
  return [cliPath, "--device", deviceId];
}

function defaultMcpArgs(deviceId: string): string[] {
  return [...defaultCliArgs(deviceId), "--mcp"];
}

function normalizeAgentRuntime(value?: string): AgentRuntime {
  const normalized = (value ?? DEFAULT_AGENT).trim().toLowerCase();
  if ((SUPPORTED_AGENTS as readonly string[]).includes(normalized)) {
    return normalized as AgentRuntime;
  }
  throw new Error(`unsupported agent "${value}". Supported agents: ${SUPPORTED_AGENTS.join(", ")}`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: DIR_MODE, recursive: true });
  }
}

function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data.endsWith("\n") ? data : `${data}\n`, {
    mode: FILE_MODE,
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
