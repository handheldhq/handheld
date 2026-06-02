import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { AGENT_SPACE_DIRNAME, LEGACY_AGENT_WORKSPACE_DIRNAME } from "../harness-workspace.js";
import { HANDHELD_HOME } from "../state.js";

type RootOptions = {
  json?: boolean;
};

type UninstallOptions = {
  global?: boolean;
  project?: boolean;
  workspace?: string;
  yes?: boolean;
};

export type UninstallTarget = {
  exists: boolean;
  label: "global" | "project" | "agent-space" | "legacy-agent-workspace";
  path: string;
  removed?: boolean;
};

export type UninstallPlan = {
  dryRun: boolean;
  projectRoot: string;
  targets: UninstallTarget[];
};

export function buildUninstallPlan(input: {
  dryRun?: boolean;
  includeGlobal?: boolean;
  includeProject?: boolean;
  workspace?: string;
} = {}): UninstallPlan {
  const projectRoot = resolve(input.workspace ?? process.cwd());
  const targets: UninstallTarget[] = [];
  if (input.includeGlobal !== false) {
    targets.push({
      exists: existsSync(HANDHELD_HOME),
      label: "global",
      path: HANDHELD_HOME,
    });
  }
  if (input.includeProject !== false) {
    targets.push(
      {
        exists: existsSync(join(projectRoot, ".handheld")),
        label: "project",
        path: join(projectRoot, ".handheld"),
      },
      {
        exists: existsSync(join(projectRoot, AGENT_SPACE_DIRNAME)),
        label: "agent-space",
        path: join(projectRoot, AGENT_SPACE_DIRNAME),
      },
      {
        exists: existsSync(join(projectRoot, LEGACY_AGENT_WORKSPACE_DIRNAME)),
        label: "legacy-agent-workspace",
        path: join(projectRoot, LEGACY_AGENT_WORKSPACE_DIRNAME),
      },
    );
  }

  const seen = new Set<string>();
  return {
    dryRun: input.dryRun !== false,
    projectRoot,
    targets: targets.filter((target) => {
      const key = resolve(target.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export function executeUninstallPlan(plan: UninstallPlan): UninstallPlan {
  if (plan.dryRun) return plan;
  return {
    ...plan,
    targets: plan.targets.map((target) => {
      if (!target.exists) return { ...target, removed: false };
      rmSync(target.path, { force: true, recursive: true });
      return { ...target, exists: false, removed: true };
    }),
  };
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("remove local Handheld state and project agent-space files (dry-run unless --yes)")
    .option("-y, --yes", "actually remove files; without this, only print what would be removed")
    .option("--workspace <path>", "project directory to clean (default current directory)")
    .option("--no-global", "do not remove ~/.handheld")
    .option("--no-project", "do not remove project .handheld/, agent-space/, or legacy agent-workspace/")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  handheld uninstall                  # preview global + project cleanup\n" +
        "  handheld uninstall --yes            # remove ~/.handheld, ./.handheld, ./agent-space\n" +
        "  handheld uninstall --no-global --yes\n" +
        "  handheld uninstall --workspace /tmp/app --yes\n" +
        "\nCaveats:\n" +
        "  - This is local cleanup for testing. It does not delete cloud phones or Gateway profiles.\n" +
        "  - Project cleanup removes only .handheld/, agent-space/, and legacy agent-workspace/ under the selected workspace.\n" +
        "  - Use --yes intentionally; the default is a dry run."
    )
    .action((opts: UninstallOptions, command: Command) => {
      const rootOptions = command.parent?.opts<RootOptions>() ?? {};
      const plan = buildUninstallPlan({
        dryRun: opts.yes !== true,
        includeGlobal: opts.global !== false,
        includeProject: opts.project !== false,
        workspace: opts.workspace,
      });
      const result = executeUninstallPlan(plan);
      if (rootOptions.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }

      if (result.dryRun) {
        console.log("Dry run. Would remove:");
      } else {
        console.log("Removed local Handheld content:");
      }
      for (const target of result.targets) {
        const status = result.dryRun
          ? target.exists ? "exists" : "missing"
          : target.removed ? "removed" : "missing";
        console.log("- " + target.label + ": " + target.path + " (" + status + ")");
      }
      if (result.dryRun) {
        console.log("Run `handheld uninstall --yes` to remove these paths.");
      }
    });
}
