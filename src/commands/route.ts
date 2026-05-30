import type { Command } from "commander";
import { runRouteCommand } from "./route-runner.js";

export function registerRouteCommand(program: Command): void {
  program
    .command("_route", { hidden: true })
    .description("(internal) ADB shim routing")
    .argument("[serial]")
    .argument("[adbArgs...]")
    .option("--check", "check if command is routable via the relay")
    .option("--exec", "execute command via the relay")
    .allowUnknownOption(true)
    .action(async (serialArg: string | undefined, adbArgsArg: string[] | undefined, opts) => {
      await runRouteCommand({
        adbArgs: adbArgsArg ?? [],
        check: Boolean(opts.check),
        serial: serialArg,
      });
    });
}
