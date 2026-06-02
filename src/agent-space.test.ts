import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentSpaceDir,
  domainSkillsDir,
  importProjectDomainSkills,
  listDomainSkillFiles,
  promoteRunDomainSkill,
  readDomainSkill,
  writeRunDomainSkill,
} from "./agent-space.js";

const tempDirs: string[] = [];
const symlinkIt = process.platform === "win32" ? it.skip : it;

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
    writeFileSync(join(projectDomain, "_template.md"), "# Template\n");
    writeFileSync(join(projectDomain, "com.example.app.md"), "# Example\n");

    const imported = importProjectDomainSkills({
      projectAgentSpaceDir: agentSpaceDir(project),
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(imported.imported.map((skill) => skill.path)).toEqual(["com.example.app.md"]);
    expect(readFileSync(join(domainSkillsDir(agentSpaceDir(run)), "com.example.app.md"), "utf8")).toBe("# Example\n");
    expect(existsSync(join(domainSkillsDir(agentSpaceDir(run)), "README.md"))).toBe(false);
    expect(existsSync(join(domainSkillsDir(agentSpaceDir(run)), "_template.md"))).toBe(false);
    expect(JSON.parse(readFileSync(imported.manifestPath, "utf8"))).toMatchObject({
      projectDomainSkillsDir: projectDomain,
      imported: [{ path: "com.example.app.md" }],
    });
  });

  it("lists domain skill files without scaffold docs or templates", () => {
    const project = tempRoot();
    const projectDomain = domainSkillsDir(agentSpaceDir(project));
    mkdirSync(join(projectDomain, "nested"), { recursive: true });
    writeFileSync(join(projectDomain, "README.md"), "# Readme\n");
    writeFileSync(join(projectDomain, "_template.md"), "# Template\n");
    writeFileSync(join(projectDomain, "com.example.app.md"), "# App\n");
    writeFileSync(join(projectDomain, "nested", "_template.md"), "# Nested template\n");
    writeFileSync(join(projectDomain, "nested", "flow.md"), "# Flow\n");

    expect(listDomainSkillFiles(projectDomain).map((skill) => skill.path)).toEqual([
      "com.example.app.md",
      "nested/flow.md",
    ]);
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

  it("refuses to overwrite project skills unless explicitly allowed", () => {
    const project = tempRoot();
    const run = tempRoot();
    const projectDomain = domainSkillsDir(agentSpaceDir(project));
    mkdirSync(projectDomain, { recursive: true });
    writeFileSync(join(projectDomain, "com.android.settings.md"), "# Original\n");
    writeRunDomainSkill({
      body: "# Candidate\n",
      path: "com.android.settings.md",
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(() =>
      promoteRunDomainSkill({
        path: "com.android.settings.md",
        projectAgentSpaceDir: agentSpaceDir(project),
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("already exists");
    expect(readFileSync(join(projectDomain, "com.android.settings.md"), "utf8")).toBe("# Original\n");

    promoteRunDomainSkill({
      overwrite: true,
      path: "com.android.settings.md",
      projectAgentSpaceDir: agentSpaceDir(project),
      runAgentSpaceDir: agentSpaceDir(run),
    });
    expect(readFileSync(join(projectDomain, "com.android.settings.md"), "utf8")).toBe("# Candidate\n");
  });

  it("rejects skill paths that escape the domain-skill root", () => {
    const run = tempRoot();

    expect(() =>
      writeRunDomainSkill({
        body: "# Escape\n",
        path: "../outside",
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("escapes agent-space");

    expect(() =>
      readDomainSkill({
        path: "../outside",
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("escapes agent-space");
  });

  symlinkIt("rejects domain-skill reads through a final symlink", () => {
    const project = tempRoot();
    const outside = tempRoot();
    const projectDomain = domainSkillsDir(agentSpaceDir(project));
    mkdirSync(projectDomain, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "# Outside\n");
    symlinkSync(join(outside, "secret.md"), join(projectDomain, "leak.md"));

    expect(() =>
      readDomainSkill({
        path: "leak.md",
        projectAgentSpaceDir: agentSpaceDir(project),
        scope: "project",
      }),
    ).toThrow("symlink");
  });

  symlinkIt("rejects reads through a symlinked domain-skill root", () => {
    const project = tempRoot();
    const outside = tempRoot();
    mkdirSync(join(agentSpaceDir(project), "skills"), { recursive: true });
    writeFileSync(join(outside, "leak.md"), "# Outside\n");
    symlinkSync(outside, domainSkillsDir(agentSpaceDir(project)), "dir");

    expect(() =>
      readDomainSkill({
        path: "leak.md",
        projectAgentSpaceDir: agentSpaceDir(project),
        scope: "project",
      }),
    ).toThrow("symlink");
  });

  symlinkIt("refuses to write through a final symlink", () => {
    const run = tempRoot();
    const outside = tempRoot();
    const runDomain = domainSkillsDir(agentSpaceDir(run));
    mkdirSync(runDomain, { recursive: true });
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "# Outside\n");
    symlinkSync(outsideFile, join(runDomain, "leak.md"));

    expect(() =>
      writeRunDomainSkill({
        body: "# Candidate\n",
        path: "leak.md",
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("symlink");
    expect(readFileSync(outsideFile, "utf8")).toBe("# Outside\n");
  });

  symlinkIt("refuses to write through a symlinked intermediate directory", () => {
    const run = tempRoot();
    const outside = tempRoot();
    const runDomain = domainSkillsDir(agentSpaceDir(run));
    mkdirSync(runDomain, { recursive: true });
    symlinkSync(outside, join(runDomain, "nested"), "dir");

    expect(() =>
      writeRunDomainSkill({
        body: "# Candidate\n",
        path: "nested/com.example.md",
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("symlink");
    expect(existsSync(join(outside, "com.example.md"))).toBe(false);
  });

  symlinkIt("refuses to promote a run candidate symlink into the project", () => {
    const project = tempRoot();
    const run = tempRoot();
    const outside = tempRoot();
    const runDomain = domainSkillsDir(agentSpaceDir(run));
    mkdirSync(runDomain, { recursive: true });
    writeFileSync(join(outside, "candidate.md"), "# Outside\n");
    symlinkSync(join(outside, "candidate.md"), join(runDomain, "candidate.md"));

    expect(() =>
      promoteRunDomainSkill({
        path: "candidate.md",
        projectAgentSpaceDir: agentSpaceDir(project),
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("symlink");
  });

  symlinkIt("refuses to promote into a project target symlink", () => {
    const project = tempRoot();
    const run = tempRoot();
    const outside = tempRoot();
    const projectDomain = domainSkillsDir(agentSpaceDir(project));
    mkdirSync(projectDomain, { recursive: true });
    const outsideFile = join(outside, "secret.md");
    writeFileSync(outsideFile, "# Outside\n");
    symlinkSync(outsideFile, join(projectDomain, "candidate.md"));
    writeRunDomainSkill({
      body: "# Candidate\n",
      path: "candidate.md",
      runAgentSpaceDir: agentSpaceDir(run),
    });

    expect(() =>
      promoteRunDomainSkill({
        overwrite: true,
        path: "candidate.md",
        projectAgentSpaceDir: agentSpaceDir(project),
        runAgentSpaceDir: agentSpaceDir(run),
      }),
    ).toThrow("symlink");
    expect(readFileSync(outsideFile, "utf8")).toBe("# Outside\n");
  });
});
