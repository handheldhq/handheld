import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export type HarnessAgentWorkspace = {
  agentHelpersPath: string;
  agentWorkspaceDir: string;
  domainSkillsDir: string;
  evidenceDir: string;
  interactionSkillsDir: string;
};

export type ProjectHarnessWorkspace = HarnessAgentWorkspace & {
  handheldDir: string;
  mcpConfigPath: string;
  rootDir: string;
  runsDir: string;
};

export function ensureHarnessAgentWorkspace(input: {
  agentWorkspaceDir: string;
  overwrite?: boolean;
}): HarnessAgentWorkspace {
  const agentWorkspaceDir = resolve(input.agentWorkspaceDir);
  const domainSkillsDir = join(agentWorkspaceDir, "domain-skills");
  const interactionSkillsDir = join(agentWorkspaceDir, "interaction-skills", "mobile");
  const evidenceDir = join(agentWorkspaceDir, "evidence");
  const agentHelpersPath = join(agentWorkspaceDir, "agent_helpers.py");
  ensureDir(agentWorkspaceDir);
  ensureDir(domainSkillsDir);
  ensureDir(interactionSkillsDir);
  ensureDir(evidenceDir);
  writePrivateFile(join(agentWorkspaceDir, "README.md"), renderAgentWorkspaceReadme(), {
    overwrite: input.overwrite,
  });
  writePrivateFile(join(domainSkillsDir, "README.md"), renderDomainSkillsReadme(), {
    overwrite: input.overwrite,
  });
  writePrivateFile(join(evidenceDir, "README.md"), renderEvidenceReadme(), {
    overwrite: input.overwrite,
  });
  writePrivateFile(agentHelpersPath, renderAgentHelpersTemplate(), {
    overwrite: input.overwrite,
  });
  for (const [name, body] of Object.entries(renderInteractionSkills())) {
    writePrivateFile(join(interactionSkillsDir, name), body, {
      overwrite: input.overwrite,
    });
  }
  return {
    agentHelpersPath,
    agentWorkspaceDir,
    domainSkillsDir,
    evidenceDir,
    interactionSkillsDir,
  };
}

export function createProjectHarnessWorkspace(input: {
  apiUrl: string;
  cliArgs?: string[];
  cliCommand?: string;
  deviceId?: string | null;
  overwrite?: boolean;
  rootDir?: string;
}): ProjectHarnessWorkspace {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const handheldDir = join(rootDir, ".handheld");
  const runsDir = join(handheldDir, "runs");
  ensureDir(handheldDir);
  ensureDir(runsDir);
  const workspace = ensureHarnessAgentWorkspace({
    agentWorkspaceDir: join(rootDir, "agent-workspace"),
    overwrite: input.overwrite,
  });
  const mcpConfigPath = join(handheldDir, "mcp.json");
  writePrivateFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          handheld: {
            args: input.cliArgs ?? defaultMcpArgs(input.deviceId),
            command: input.cliCommand ?? process.execPath,
            env: {
              HANDHELD_API_URL: input.apiUrl,
              HANDHELD_EVIDENCE_DIR: workspace.evidenceDir,
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
    { overwrite: true },
  );
  writePrivateFile(join(handheldDir, "README.md"), renderProjectHandheldReadme(), {
    overwrite: input.overwrite,
  });
  return {
    ...workspace,
    handheldDir,
    mcpConfigPath,
    rootDir,
    runsDir,
  };
}

function defaultMcpArgs(deviceId?: string | null): string[] {
  const cliPath = process.argv[1];
  const args = cliPath ? [cliPath] : [];
  if (deviceId) args.push("--device", deviceId);
  args.push("--mcp");
  return args;
}

function renderAgentWorkspaceReadme(): string {
  return `# agent-workspace

This is a harness-shaped mobile agent workspace.

- Use only Handheld CLI/MCP tools for device actions.
- agent_helpers.py is an editable helper shim for normal CLI agents; cloud-loop agents should call MCP tools directly.
- domain-skills/ stores package-keyed app maps.
- interaction-skills/mobile/ stores reusable mobile mechanics.
- evidence/ stores snapshots, screenshots, and final-state notes.
`;
}

function renderDomainSkillsReadme(): string {
  return `# domain-skills

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

function renderAgentHelpersTemplate(): string {
  return `"""Editable Handheld harness helper shim.

This file is loaded by handheld_harness.helpers when HH_AGENT_WORKSPACE points
at this directory. It imports the handheld-harness helper namespace, then leaves
space for task-specific wrappers. It is not a second runtime: helpers still
delegate to the handheld CLI/MCP boundary.
"""

from handheld_harness.helpers import *  # noqa: F401,F403


# Add task-specific helper wrappers below. Keep device actions delegated through
# the imported handheld-harness helpers.
`;
}

function renderProjectHandheldReadme(): string {
  return `# .handheld

Project-local Handheld agent workspace metadata.

- mcp.json points agents at the Handheld MCP server for this project.
- runs/ stores isolated handheld run workspaces.
- ../agent-workspace/ stores editable helper shims, domain skills, interaction skills, and evidence.
`;
}

function renderInteractionSkills(): Record<string, string> {
  return {
    "observe-and-act.md": `# Observe And Act

Loop: snap, one small action, post-state or re-snap, verify. If settle is inconclusive, observe again; do not repeat the mutating action blindly.
`,
    "selectors-and-refs.md": `# Selectors And Refs

Prefer id=, label=, and text= selectors. @eN refs are volatile and only valid for the latest snapshot. Coordinates are fallback only.
`,
    "keyboard-and-text-entry.md": `# Keyboard And Text Entry

Use fill/type MCP tools for text. Verify a focused editable field before typing into focus. Re-snap after keyboard dismissal.
`,
    "scroll-lists-and-recycler-views.md": `# Scroll Lists And Recycler Views

Use small scrolls, then re-snap. Recycler rows recycle refs, so use visible row text or stable ids after the row is on-screen.
`,
    "app-launch-and-deeplinks.md": `# App Launch And Deeplinks

Use app launch/open-url tools, then verify package/activity before acting.
`,
    "permissions-dialogs-and-system-ui.md": `# Permissions Dialogs And System UI

Permission prompts often belong to System UI. Use visible labels such as Allow, then verify control returned to the app.
`,
    "webviews.md": `# WebViews

Treat WebViews as mobile UI unless a better tool surface is available. Use visible text, small scrolls, and post-state checks.
`,
    "files-apk-and-intents.md": `# Files APK And Intents

Use handheld tools for package/file/intent work. Do not add raw adb setup flows to skills.
`,
    "cloud-device-sessions.md": `# Cloud Device Sessions

Cloud-loop agents stay on locked Handheld MCP tools. Do not reach for provider API keys in the workspace.
`,
    "evidence-and-final-answer.md": `# Evidence And Final Answer

Capture final observed state and evidence paths before final response. Redact sensitive identifiers.
`,
  };
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: DIR_MODE, recursive: true });
  }
}

function writePrivateFile(
  path: string,
  data: string,
  opts: { overwrite?: boolean } = {},
): void {
  if (opts.overwrite !== true && existsSync(path)) return;
  writeFileSync(path, data.endsWith("\n") ? data : `${data}\n`, {
    mode: FILE_MODE,
  });
}
