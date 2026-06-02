import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSpaceDir,
  domainSkillsDir,
  importProjectDomainSkills,
  promoteRunDomainSkill,
  readDomainSkill,
  writeRunDomainSkill,
} from "./agent-space.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "handheld-agent-space-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("agent-space domain skills", () => {
  it("imports project domain skills into a run agent-space with a manifest", () => {
    const project = tempRoot();
    const run = tempRoot();
    const projectDomain = domainSkillsDir(agentSpaceDir(project));
    mkdirSync(projectDomain, { recursive: true });
    writeFileSync(join(projectDomain, "README.md"), "# project readme\n");
    writeFileSync(join(projectDomain, "com.example.app.md"), "# Example\n");

    const imported = importProjectDomainSkills({
      projectAgentSpaceDir: agentSpaceDir(project),
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(imported.imported.map((skill) => skill.path)).toEqual(["com.example.app.md"]);
    expect(readFileSync(join(domainSkillsDir(agentSpaceDir(run)), "com.example.app.md"), "utf8")).toBe("# Example\n");
    expect(existsSync(join(domainSkillsDir(agentSpaceDir(run)), "README.md"))).toBe(false);
    expect(JSON.parse(readFileSync(imported.manifestPath, "utf8"))).toMatchObject({
      projectDomainSkillsDir: projectDomain,
      imported: [{ path: "com.example.app.md" }],
    });
  });

  it("writes run candidates and promotes them back to the project", () => {
    const project = tempRoot();
    const run = tempRoot();
    const written = writeRunDomainSkill({
      body: "# Settings\n",
      packageName: "com.android.settings",
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(written.path).toBe("com.android.settings.md");
    const promoted = promoteRunDomainSkill({
      path: written.path,
      projectAgentSpaceDir: agentSpaceDir(project),
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(promoted.path).toBe(written.path);
    expect(readDomainSkill({
      path: written.path,
      projectAgentSpaceDir: agentSpaceDir(project),
      scope: "project",
    }).content).toBe("# Settings\n");
  });
});
