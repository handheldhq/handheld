import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("uninstall command", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "handheld-uninstall-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function runUninstall(args: string[]): Promise<string> {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      output.push(parts.join(" "));
    });

    const { registerUninstallCommand } = await import("./uninstall.js");
    const program = new Command().name("handheld").exitOverride().option("--json");
    registerUninstallCommand(program);
    await program.parseAsync(args, { from: "user" });
    return output.join("\n");
  }

  function seed(project: string): void {
    mkdirSync(join(home, ".handheld"), { recursive: true });
    writeFileSync(join(home, ".handheld", "config.json"), "{}\n");
    mkdirSync(join(project, ".handheld"), { recursive: true });
    writeFileSync(join(project, ".handheld", "mcp.json"), "{}\n");
    mkdirSync(join(project, "agent-workspace"), { recursive: true });
    writeFileSync(join(project, "agent-workspace", "agent_helpers.py"), "# helper\n");
  }

  it("previews cleanup by default", async () => {
    const project = join(home, "project");
    seed(project);

    const output = await runUninstall(["uninstall", "--workspace", project]);

    expect(output).toContain("Dry run");
    expect(output).toContain(join(home, ".handheld"));
    expect(output).toContain(join(project, ".handheld"));
    expect(output).toContain(join(project, "agent-workspace"));
    expect(existsSync(join(home, ".handheld"))).toBe(true);
    expect(existsSync(join(project, ".handheld"))).toBe(true);
    expect(existsSync(join(project, "agent-workspace"))).toBe(true);
  });

  it("removes global and project content with --yes", async () => {
    const project = join(home, "project");
    seed(project);

    await runUninstall(["uninstall", "--workspace", project, "--yes"]);

    expect(existsSync(join(home, ".handheld"))).toBe(false);
    expect(existsSync(join(project, ".handheld"))).toBe(false);
    expect(existsSync(join(project, "agent-workspace"))).toBe(false);
  });

  it("can skip global cleanup", async () => {
    const project = join(home, "project");
    seed(project);

    const output = await runUninstall(["--json", "uninstall", "--workspace", project, "--no-global", "--yes"]);
    const parsed = JSON.parse(output);

    expect(parsed.dryRun).toBe(false);
    expect(parsed.targets.map((target: { label: string }) => target.label)).toEqual([
      "project",
      "agent-workspace",
    ]);
    expect(existsSync(join(home, ".handheld"))).toBe(true);
    expect(existsSync(join(project, ".handheld"))).toBe(false);
    expect(existsSync(join(project, "agent-workspace"))).toBe(false);
  });
});
