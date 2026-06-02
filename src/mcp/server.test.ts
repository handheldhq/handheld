import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentSpaceDir, domainSkillsDir } from "../agent-space.js";
import {
  CORE_MCP_TOOL_NAMES,
  handleAgentSpaceToolCall,
  handleTeachArtifactToolCall,
  listVisibleTools,
} from "./server.js";

const tempDirs: string[] = [];
const symlinkIt = process.platform === "win32" ? it.skip : it;
const originalCwd = process.cwd();
const originalAgentSpaceEnv = {
  HANDHELD_AGENT_SPACE: process.env.HANDHELD_AGENT_SPACE,
  HANDHELD_PROJECT_AGENT_SPACE_DIR: process.env.HANDHELD_PROJECT_AGENT_SPACE_DIR,
  HANDHELD_RUN_AGENT_SPACE_DIR: process.env.HANDHELD_RUN_AGENT_SPACE_DIR,
  HH_AGENT_SPACE: process.env.HH_AGENT_SPACE,
};

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "handheld-mcp-server-test-"));
  tempDirs.push(dir);
  return dir;
}

function jsonPayload(result: ReturnType<typeof handleAgentSpaceToolCall>): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function restoreEnvKey(key: keyof typeof originalAgentSpaceEnv): void {
  const value = originalAgentSpaceEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreAgentSpaceEnv(): void {
  restoreEnvKey("HANDHELD_AGENT_SPACE");
  restoreEnvKey("HANDHELD_PROJECT_AGENT_SPACE_DIR");
  restoreEnvKey("HANDHELD_RUN_AGENT_SPACE_DIR");
  restoreEnvKey("HH_AGENT_SPACE");
}

describe("MCP tool list", () => {
  const originalFull = process.env.HANDHELD_MCP_FULL;

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
    if (originalFull === undefined) {
      delete process.env.HANDHELD_MCP_FULL;
    } else {
      process.env.HANDHELD_MCP_FULL = originalFull;
    }
    restoreAgentSpaceEnv();
  });

  it("exposes the documented core tools by default, including teach_request/status", () => {
    delete process.env.HANDHELD_MCP_FULL;

    const tools = listVisibleTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(names).toContain("teach_request");
    expect(names).toContain("teach_status");
    expect(names).toContain("read_teach_artifact");
    expect(names).toContain("capture_evidence");
    expect(names).toContain("list_domain_skills");
    expect(names).toContain("read_domain_skill");
    expect(names).toContain("save_domain_skill_candidate");
    expect(names).toContain("promote_domain_skill");
    expect(names).not.toContain("click");
    expect(names).not.toContain("profile_delete");
    expect(tools.every((tool) => tool._meta?.["handheld/category"] === "core")).toBe(true);
  });

  it("annotates read-only, mutating, destructive, and compatibility tools", () => {
    process.env.HANDHELD_MCP_FULL = "1";

    const byName = new Map(listVisibleTools().map((tool) => [tool.name, tool]));

    expect(byName.get("snap")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    expect(byName.get("capture_evidence")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("list_domain_skills")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(byName.get("save_domain_skill_candidate")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("tap")?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: false,
      readOnlyHint: false,
    });
    expect(byName.get("shell")?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(byName.get("teach_status")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(byName.get("read_teach_artifact")?.annotations).toMatchObject({
      destructiveHint: false,
      readOnlyHint: true,
    });
    expect(byName.get("click")?._meta?.["handheld/category"]).toBe("compatibility");
    expect(byName.get("profile_delete")?._meta?.["handheld/category"]).toBe("operator");
  });

  it("handles domain-skill MCP tools against run and project agent-space roots", () => {
    const project = tempRoot();
    const run = tempRoot();
    const projectAgentSpace = agentSpaceDir(project);
    const runAgentSpace = agentSpaceDir(run);
    const projectDomain = domainSkillsDir(projectAgentSpace);
    mkdirSync(projectDomain, { recursive: true });
    writeFileSync(join(projectDomain, "README.md"), "# Project domain readme\n");
    writeFileSync(join(projectDomain, "_template.md"), "# Project domain template\n");
    writeFileSync(join(projectDomain, "com.project.md"), "# Project\n");
    process.env.HANDHELD_PROJECT_AGENT_SPACE_DIR = projectAgentSpace;
    process.env.HANDHELD_RUN_AGENT_SPACE_DIR = runAgentSpace;

    const saved = jsonPayload(handleAgentSpaceToolCall("save_domain_skill_candidate", {
      body: "# Run\n",
      packageName: "com.example.app",
    }));
    expect(saved).toMatchObject({
      ok: true,
      skill: { path: "com.example.app.md" },
    });

    const listed = jsonPayload(handleAgentSpaceToolCall("list_domain_skills", {}));
    expect(listed).toMatchObject({
      project: { skills: ["com.project.md"] },
      run: { skills: ["com.example.app.md"] },
    });

    expect(jsonPayload(handleAgentSpaceToolCall("read_domain_skill", {
      path: "com.example.app",
    }))).toMatchObject({
      content: "# Run\n",
      scope: "run",
    });
    expect(jsonPayload(handleAgentSpaceToolCall("read_domain_skill", {
      path: "com.project",
      scope: "project",
    }))).toMatchObject({
      content: "# Project\n",
      scope: "project",
    });

    expect(jsonPayload(handleAgentSpaceToolCall("promote_domain_skill", {
      path: "com.example.app",
    }))).toMatchObject({
      ok: true,
      skill: { path: "com.example.app.md" },
    });
    expect(existsSync(join(projectDomain, "com.example.app.md"))).toBe(true);
    expect(readFileSync(join(projectDomain, "com.example.app.md"), "utf8")).toBe("# Run\n");
  });

  it("validates required args and scope for domain-skill MCP tools", () => {
    process.env.HANDHELD_RUN_AGENT_SPACE_DIR = agentSpaceDir(tempRoot());

    expect(() => handleAgentSpaceToolCall("read_domain_skill", {})).toThrow("path is required");
    expect(() => handleAgentSpaceToolCall("read_domain_skill", {
      path: "com.example.app",
      scope: "global",
    })).toThrow("scope must be run or project");
    expect(() => handleAgentSpaceToolCall("save_domain_skill_candidate", {})).toThrow("body is required");
  });

  it("reads teach envelopes and trajectories through MCP without host file access", () => {
    const project = tempRoot();
    process.chdir(project);
    const teachDir = join(project, ".handheld", "teach", "teach-1");
    const bundleDir = join(teachDir, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    const trajectoryPath = join(bundleDir, "trajectory.json");
    writeFileSync(trajectoryPath, JSON.stringify({ schema: "mobile-use.trajectory.v1", actions: [] }) + "\n");
    writeFileSync(join(teachDir, "envelope.json"), JSON.stringify({
      schema: "handheld.teach.envelope.v1",
      teachId: "teach-1",
      objective: "demo",
      package: "com.example",
      deviceId: "dev1",
      viewerUrl: "https://viewer",
      status: "ready",
      createdAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
      dir: teachDir,
      bundleZip: join(teachDir, "bundle.zip"),
      bundleDir,
      trajectoryPath,
    }));

    expect(jsonPayload(handleTeachArtifactToolCall({
      artifact: "envelope",
      teachId: "teach-1",
    }))).toMatchObject({
      artifact: "envelope",
      ok: true,
      teachId: "teach-1",
    });
    const trajectory = jsonPayload(handleTeachArtifactToolCall({
      teachId: "teach-1",
    }));
    expect(trajectory).toMatchObject({
      artifact: "trajectory",
      ok: true,
      teachId: "teach-1",
    });
    expect(JSON.parse(String(trajectory.content))).toMatchObject({
      schema: "mobile-use.trajectory.v1",
    });
  });

  it("refuses teach trajectory paths outside the teach session", () => {
    const project = tempRoot();
    const outside = tempRoot();
    process.chdir(project);
    const teachDir = join(project, ".handheld", "teach", "teach-1");
    mkdirSync(teachDir, { recursive: true });
    const outsideTrajectory = join(outside, "trajectory.json");
    writeFileSync(outsideTrajectory, "{}\n");
    writeFileSync(join(teachDir, "envelope.json"), JSON.stringify({
      schema: "handheld.teach.envelope.v1",
      teachId: "teach-1",
      objective: "demo",
      package: null,
      deviceId: "dev1",
      viewerUrl: "https://viewer",
      status: "ready",
      createdAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
      dir: teachDir,
      bundleZip: null,
      bundleDir: null,
      trajectoryPath: outsideTrajectory,
    }));

    expect(() => handleTeachArtifactToolCall({
      teachId: "teach-1",
    })).toThrow("escapes teach session");
  });

  symlinkIt("refuses teach trajectories through session-local symlinks", () => {
    const project = tempRoot();
    const outside = tempRoot();
    process.chdir(project);
    const teachDir = join(project, ".handheld", "teach", "teach-1");
    const bundleDir = join(teachDir, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    const outsideTrajectory = join(outside, "trajectory.json");
    writeFileSync(outsideTrajectory, "{}\n");
    symlinkSync(outsideTrajectory, join(bundleDir, "trajectory.json"));
    writeFileSync(join(teachDir, "envelope.json"), JSON.stringify({
      schema: "handheld.teach.envelope.v1",
      teachId: "teach-1",
      objective: "demo",
      package: null,
      deviceId: "dev1",
      viewerUrl: "https://viewer",
      status: "ready",
      createdAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
      dir: teachDir,
      bundleZip: null,
      bundleDir,
      trajectoryPath: join(bundleDir, "trajectory.json"),
    }));

    expect(() => handleTeachArtifactToolCall({
      teachId: "teach-1",
    })).toThrow("escapes teach session");
  });
});
