import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentSpaceDir, domainSkillsDir } from "../agent-space.js";
import { CORE_MCP_TOOL_NAMES, handleAgentSpaceToolCall, listVisibleTools } from "./server.js";

const tempDirs: string[] = [];
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

  it("exposes the documented core tools by default, including teach_request", () => {
    delete process.env.HANDHELD_MCP_FULL;

    const tools = listVisibleTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(names).toContain("teach_request");
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
});
