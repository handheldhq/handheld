import { spawn, spawnSync } from "node:child_process";
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
import { agentSpaceDir as projectAgentSpaceDirForRoot, importProjectDomainSkills, type ImportedDomainSkills } from "../agent-space.js";
import { ensureHarnessAgentWorkspace } from "../harness-workspace.js";
import { connectDevice, connectLocalDevice } from "./connect.js";

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
  harness?: boolean;
  interactive?: boolean;
  local?: boolean;
  localSerial?: string;
  model?: string;
  tinyWarmup?: boolean;
  tui?: boolean;
  workspace?: string;
  workspaceTemplate?: string;
};

type WorkspaceTemplate = "default" | "harness";

export type RunWorkspace = {
  agentSpacePath: string;
  agentsPath: string;
  claudePath: string;
  evidencePath: string;
  importedDomainSkills: ImportedDomainSkills;
  mcpConfigPath: string;
  mcpServer: HandheldMcpServerConfig;
  prompt: string;
  promptPath: string;
  projectAgentSpacePath: string;
  runId: string;
  taskPath: string;
  workspaceDir: string;
};

export type RunWorkspaceInput = {
  apiUrl: string;
  cliArgs?: string[];
  cliCommand?: string;
  connectionMode?: "cloud" | "local";
  deviceId: string;
  mcpDeviceId?: string | null;
  now?: Date;
  projectRoot?: string;
  runsDir?: string;
  task: string;
  workspace?: string;
  workspaceTemplate?: WorkspaceTemplate;
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
    HANDHELD_AGENT_SPACE: string;
    HANDHELD_API_URL: string;
    HANDHELD_EVIDENCE_DIR: string;
    HANDHELD_PROJECT_AGENT_SPACE_DIR: string;
    HANDHELD_RUN_AGENT_SPACE_DIR: string;
  };
};

export type TinyWarmupPlan = {
  args: string[];
  command: string;
  logPath: string;
};

export type RunEvidenceCapturePlan = {
  args: string[];
  command: string;
  label: string;
  path: string;
};

export type RunEvidenceCapture = RunEvidenceCapturePlan & {
  ok: boolean;
  error?: string;
  signal?: NodeJS.Signals | null;
  status?: number | null;
};

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("run a mobile task with a local agent (claude|codex) against the default device (--tui to steer, --dry-run to preview)")
    .argument("<task...>", "task for the local agent")
    .option("--agent <agent>", "agent runtime to spawn (claude or codex)", DEFAULT_AGENT)
    .option("--claude <path>", "Claude Code executable", "claude")
    .option("--codex <path>", "Codex executable", "codex")
    .option("--model <model>", "agent model alias or full model name")
    .option("--workspace <path>", "use an existing workspace directory instead of creating ./.handheld/runs/<id>")
    .option("--workspace-template <name>", "workspace template to prepare (default|harness)", "default")
    .option("--harness", "alias for --workspace-template harness")
    .option("--local", "run against a local adb device/emulator without requiring cloud API auth")
    .option("--local-serial <serial>", "local adb serial to use with --local")
    .option("--tui", "launch the local agent in interactive terminal mode instead of one-shot mode")
    .option("--interactive", "alias for --tui")
    .option("--dry-run", "prepare the workspace and print the agent command without connecting or spawning")
    .option("--no-tiny-warmup", "do not start Tiny helper bootstrap in the background after connect")
    .option("--allow-api-key-env", "allow provider API-key env vars to reach the agent instead of forcing local CLI auth")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld run <task...> [--agent claude|codex] [--model <m>] [--tui] [--dry-run] [--workspace <path>]

Examples:
  handheld run "Open Settings and confirm Wi-Fi is on"      # one-shot Claude run against the default device
  handheld run "Search Chrome for the weather" --model sonnet
  handheld run "Inspect the current screen" --agent codex --model gpt-5
  handheld run "Open Settings" --dry-run                     # print the workspace + agent command, connect nothing
  handheld run "Open Settings" --local --workspace-template harness --dry-run

Caveats:
  - Targets the default cloud device — run \`handheld init\` (or \`handheld config set default-device <id>\`) first; needs an API key.
  - For a local adb device/emulator, pass --local; add --local-serial <serial> when several devices are attached.
  - Spawns a local \`claude\`/\`codex\` binary; it must be installed and on PATH (override with --claude/--codex <path>).
  - The agent gets ONLY the locked Handheld MCP server; provider API-key env vars are stripped unless you pass --allow-api-key-env.
  - --tui is Claude-only (interactive Codex is unsupported); use plain \`handheld run --agent codex\` for headless Codex.`
    )
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
          if (/default device|init/i.test(message)) {
            console.error("Hint: no default device — run `handheld init` (or `handheld config set default-device <id>`) first.");
          } else if (/api key|unauthor|auth/i.test(message)) {
            console.error("Hint: authenticate first — `handheld login` (or set HANDHELD_API_KEY).");
          } else if (/claude|codex|ENOENT|spawn|not found/i.test(message)) {
            console.error("Hint: the agent binary must be installed and on PATH — point at it with --claude <path> / --codex <path>, or preview with --dry-run.");
          } else {
            console.error("Hint: try `handheld run <task> --dry-run` to inspect the workspace and command without spawning the agent.");
          }
        }
        process.exit(1);
      }
    });
}

export async function runLocalAgent(
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

  const workspaceTemplate = normalizeWorkspaceTemplate(
    options.harness ? "harness" : options.workspaceTemplate,
  );
  const localRun = options.local === true;
  if (options.localSerial && !localRun) {
    throw new Error("--local-serial requires --local");
  }
  const localSerial = localRun ? options.localSerial ?? rootOptions.device : undefined;
  const localAutoSelect = localRun && !localSerial;
  let deviceId = localRun
    ? (localSerial ?? "local adb device (auto-select)")
    : getResolvedDevice(rootOptions.device);
  let mcpDeviceId: string | null | undefined =
    localRun && options.dryRun && localAutoSelect ? null : deviceId;
  if (!deviceId) {
    throw new AuthError("No default device configured. Run `handheld init` first.");
  }

  const apiUrl = localRun ? (process.env.HANDHELD_API_URL ?? "") : requireApiUrl();
  if (!localRun) requireApiKey();

  let connected:
    | Awaited<ReturnType<typeof connectDevice>>
    | Awaited<ReturnType<typeof connectLocalDevice>>
    | null = null;
  if (localRun && !options.dryRun) {
    connected = await connectLocalDevice({
      json: true,
      serial: localSerial,
      startTiny: false,
    });
    deviceId = connected.deviceId;
    mcpDeviceId = deviceId;
  }

  const workspace = createRunWorkspace({
    apiUrl,
    connectionMode: localRun ? "local" : "cloud",
    deviceId,
    mcpDeviceId,
    task,
    workspace: options.workspace,
    workspaceTemplate,
  });

  let tinyWarmup: TinyWarmupPlan | null = null;
  if (!options.dryRun && !localRun) {
    connected = await connectDevice({
      deviceId,
      json: true,
      startTiny: false,
      webrtcOnly: true,
    });
  }
  if (!options.dryRun && options.tinyWarmup !== false) {
    tinyWarmup = startTinyWarmup({
      apiUrl,
      deviceId,
      workspace,
    });
  }
  const evidenceCaptures: RunEvidenceCapture[] = [];
  if (!options.dryRun) {
    evidenceCaptures.push(captureRunEvidence({
      apiUrl,
      deviceId,
      label: "initial",
      workspace,
    }));
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
  }).finally(() => {
    evidenceCaptures.push(captureRunEvidence({
      apiUrl,
      deviceId,
      label: "final",
      workspace,
    }));
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
          evidenceCaptures,
          tinyWarmup,
          workspace: workspace.workspaceDir,
          deviceId,
          sessionId: connectionSessionId(connected),
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
  const workspaceTemplate = input.workspaceTemplate ?? "default";
  const runId = input.workspace
    ? basename(resolve(input.workspace))
    : buildRunId(input.task, input.now ?? new Date());
  const workspaceDir = resolve(input.workspace ?? join(input.runsDir ?? getProjectRunsDir(), runId));
  const agentSpaceDir = join(workspaceDir, "agent-space");
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const projectAgentSpaceDir = projectAgentSpaceDirForRoot(projectRoot);
  const domainSkillsDir = join(agentSpaceDir, "skills", "domain");
  const evidenceDir = join(agentSpaceDir, "evidence");
  const logsDir = join(workspaceDir, "logs");
  ensureDir(workspaceDir);
  ensureDir(agentSpaceDir);
  ensureDir(domainSkillsDir);
  ensureDir(evidenceDir);
  ensureDir(logsDir);

  const mcpServer: HandheldMcpServerConfig = {
    args: input.cliArgs ?? defaultMcpArgs(input.mcpDeviceId === undefined ? input.deviceId : input.mcpDeviceId),
    command: input.cliCommand ?? defaultMcpCommand(),
    env: {
      HANDHELD_AGENT_SPACE: agentSpaceDir,
      HANDHELD_API_URL: input.apiUrl,
      HANDHELD_EVIDENCE_DIR: evidenceDir,
      HANDHELD_PROJECT_AGENT_SPACE_DIR: projectAgentSpaceDir,
      HANDHELD_RUN_AGENT_SPACE_DIR: agentSpaceDir,
    },
  };
  const mcpConfig = {
    mcpServers: {
      handheld: mcpServer,
    },
  };

  const prompt = renderPrompt({
    connectionMode: input.connectionMode ?? "cloud",
    deviceId: input.deviceId,
    mcpDeviceId: input.mcpDeviceId === undefined ? input.deviceId : input.mcpDeviceId,
    projectAgentSpaceDir,
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
  if (workspaceTemplate === "harness") {
    ensureHarnessAgentWorkspace({
      agentSpaceDir,
      overwrite: true,
    });
  } else {
    writePrivateFile(
      join(agentSpaceDir, "README.md"),
      renderAgentSpaceReadme(),
    );
    writePrivateFile(
      join(domainSkillsDir, "README.md"),
      renderDomainSkillsReadme(),
    );
    writePrivateFile(
      join(evidenceDir, "README.md"),
      renderEvidenceReadme(),
    );
  }
  const importedDomainSkills = importProjectDomainSkills({
    projectAgentSpaceDir,
    runAgentSpaceDir: agentSpaceDir,
  });

  return {
    agentSpacePath: agentSpaceDir,
    agentsPath,
    claudePath,
    evidencePath: evidenceDir,
    importedDomainSkills,
    mcpConfigPath,
    mcpServer,
    prompt,
    promptPath,
    projectAgentSpacePath: projectAgentSpaceDir,
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
  ];
  for (const [key, value] of Object.entries(input.mcpServer.env)) {
    args.push("-c", `mcp_servers.handheld.env.${key}=${tomlString(value)}`);
  }
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
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_AGENT_ENV_KEYS) copyEnvKey(source, env, key);
  for (const key of HANDHELD_AGENT_ENV_KEYS) copyEnvKey(source, env, key);
  if (opts.allowApiKeyEnv) {
    const providerKeys = opts.agent === "claude"
      ? CLAUDE_PROVIDER_ENV_KEYS
      : CODEX_PROVIDER_ENV_KEYS;
    for (const key of providerKeys) copyEnvKey(source, env, key);
  }
  return env;
}

const BASE_AGENT_ENV_KEYS = [
  "APPDATA",
  "COLORTERM",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

const HANDHELD_AGENT_ENV_KEYS = [
  "HANDHELD_AGENT_SPACE",
  "HANDHELD_API_KEY",
  "HANDHELD_API_URL",
  "HANDHELD_EVIDENCE_DIR",
  "HANDHELD_PROJECT_AGENT_SPACE_DIR",
  "HANDHELD_RUN_AGENT_SPACE_DIR",
  "HH_AGENT_SPACE",
  "HH_EVIDENCE_DIR",
  "MOBILEUSE_API_KEY",
];

const CLAUDE_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const CODEX_PROVIDER_ENV_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
];

function copyEnvKey(
  source: NodeJS.ProcessEnv,
  target: NodeJS.ProcessEnv,
  key: string,
): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
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

export function buildRunEvidenceCapturePlan(input: {
  deviceId: string;
  label: string;
  now?: Date;
  workspace: RunWorkspace;
}): RunEvidenceCapturePlan {
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const label = slugify(input.label).slice(0, 48) || "state";
  return {
    args: [
      ...defaultCliArgs(input.deviceId),
      "--json",
      "snap",
      "--screenshot",
    ],
    command: defaultMcpCommand(),
    label: input.label,
    path: join(input.workspace.evidencePath, `${stamp}-${label}-snap.json`),
  };
}

export function captureRunEvidence(input: {
  apiUrl: string;
  deviceId: string;
  label: string;
  workspace: RunWorkspace;
}): RunEvidenceCapture {
  const plan = buildRunEvidenceCapturePlan(input);
  try {
    const result = spawnSync(plan.command, plan.args, {
      encoding: "utf8",
      env: {
        ...process.env,
        HANDHELD_API_URL: input.apiUrl,
      },
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60_000,
    });
    if (result.status === 0 && result.stdout.trim()) {
      writePrivateFile(plan.path, result.stdout);
      return { ...plan, ok: true, signal: result.signal, status: result.status };
    }
    const error = result.error?.message || result.stderr.trim() || "Evidence capture returned no snapshot";
    writePrivateFile(
      plan.path,
      JSON.stringify(
        {
          args: plan.args,
          command: plan.command,
          error,
          label: input.label,
          ok: false,
          signal: result.signal,
          status: result.status,
          stderr: result.stderr,
          stdout: result.stdout,
        },
        null,
        2,
      ),
    );
    return { ...plan, error, ok: false, signal: result.signal, status: result.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      writePrivateFile(
        plan.path,
        JSON.stringify({ args: plan.args, command: plan.command, error: message, label: input.label, ok: false }, null, 2),
      );
    } catch {
      // Best-effort evidence must never make a run fail.
    }
    return { ...plan, error: message, ok: false };
  }
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
  connected:
    | Awaited<ReturnType<typeof connectDevice>>
    | Awaited<ReturnType<typeof connectLocalDevice>>
    | null;
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
          agentSpace: input.workspace.agentSpacePath,
          projectAgentSpace: input.workspace.projectAgentSpacePath,
          importedDomainSkills: input.workspace.importedDomainSkills.imported,
          evidence: input.workspace.evidencePath,
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
  console.log(`Agent space: ${input.workspace.agentSpacePath}`);
  console.log(`Project agent space: ${input.workspace.projectAgentSpacePath}`);
  console.log(`Evidence: ${input.workspace.evidencePath}`);
  console.log(`MCP config: ${input.workspace.mcpConfigPath}`);
  console.log(`Prompt: ${input.workspace.promptPath}`);
  if (input.tinyWarmup) {
    console.log(`Tiny warmup log: ${input.tinyWarmup.logPath}`);
  }
  console.log(`Command: ${input.plan.command} ${input.plan.args.map(shellQuote).join(" ")}`);
  if (input.plan.stdin) console.log(`Stdin: ${input.workspace.promptPath}`);
}

function renderPrompt(input: {
  connectionMode: "cloud" | "local";
  deviceId: string;
  mcpDeviceId?: string | null;
  projectAgentSpaceDir: string;
  task: string;
  workspaceDir: string;
}): string {
  const reconnectInstruction = input.connectionMode === "local"
    ? input.mcpDeviceId === null
      ? "If the tool says no device is connected, call connect with local true and no deviceId so Handheld can auto-pick the sole ready local adb device."
      : `If the tool says no device is connected, call connect with deviceId "${input.mcpDeviceId ?? input.deviceId}" and local true.`
    : `If the tool says no device is connected, call connect with deviceId "${input.deviceId}".`;
  return `You are a Handheld local agent running in an isolated workspace.

Workspace: ${input.workspaceDir}
Project agent space: ${input.projectAgentSpaceDir}
Device: ${input.deviceId}

Task:
${input.task}

Rules:
- Use only the handheld MCP tools.
- Tiny helper bootstrap is already warming in the background. Start by observing the phone with snap; if it is still installing, wait briefly and retry.
- ${reconnectInstruction}
- Keep actions small and verify visible state after meaningful actions.
- Do not edit host files, run host shell commands, or use non-mobile tools.
- Use capture_evidence for important checkpoints and before your final answer; initial and final CLI snapshots are also recorded automatically in the run evidence directory.
- Project domain skills are imported into this run's agent-space/skills/domain. Keep new app facts run-local first, then use domain-skill MCP tools to promote durable facts back to the project agent-space.
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
- capture_evidence writes durable snapshots/status/screenshots into agent-space/evidence/.
- agent-space/ is the only place for run-local helper notes.
- agent-space/skills/domain/ starts with imported project app facts, then collects run-local discoveries.
- Use list_domain_skills/read_domain_skill to inspect skills, save_domain_skill_candidate for run-local discoveries, and promote_domain_skill for durable project knowledge.
`;
}

function renderAgentSpaceReadme(template: WorkspaceTemplate = "default"): string {
  if (template === "harness") {
    return `# agent-space

This is a harness-shaped mobile agent space.

- Use only Handheld MCP tools for device actions.
- helpers/agent_helpers.py is an editable helper shim for normal CLI agents; cloud-loop agents should call MCP tools directly.
- skills/domain/ stores package-keyed app maps.
- skills/interaction/mobile/ stores reusable mobile mechanics.
- evidence/ stores snapshots, screenshots, and final-state notes.
`;
  }
  return `# agent-space

Run-local helper notes live here. Keep source-of-truth actions in Handheld MCP tools.
`;
}

function renderDomainSkillsReadme(): string {
  return `# skills/domain

Capture durable app knowledge here: package names, stable labels, waits, traps, and verification checks.
Avoid secrets, run narration, and raw coordinates as primary instructions.
`;
}

function renderEvidenceReadme(): string {
  return `# evidence

Capture final and intermediate proof here: snapshots, screenshots, status JSON, and concise notes.
Do not store secrets or unredacted credentials.
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

function defaultCliArgs(deviceId?: string | null): string[] {
  const cliPath = process.argv[1];
  const args = cliPath ? [cliPath] : [];
  if (deviceId) args.push("--device", deviceId);
  return args;
}

function defaultMcpArgs(deviceId?: string | null): string[] {
  return [...defaultCliArgs(deviceId), "--mcp"];
}

function normalizeAgentRuntime(value?: string): AgentRuntime {
  const normalized = (value ?? DEFAULT_AGENT).trim().toLowerCase();
  if ((SUPPORTED_AGENTS as readonly string[]).includes(normalized)) {
    return normalized as AgentRuntime;
  }
  throw new Error(`unsupported agent "${value}". Supported agents: ${SUPPORTED_AGENTS.join(", ")}`);
}

function normalizeWorkspaceTemplate(value?: string): WorkspaceTemplate {
  const normalized = (value ?? "default").trim().toLowerCase();
  if (normalized === "default" || normalized === "harness") {
    return normalized;
  }
  throw new Error(
    'unsupported workspace template "' +
      value +
      '". Supported templates: default, harness'
  );
}

function connectionSessionId(
  connected:
    | Awaited<ReturnType<typeof connectDevice>>
    | Awaited<ReturnType<typeof connectLocalDevice>>
    | null,
): string | null {
  return connected && "sessionId" in connected ? connected.sessionId : null;
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
