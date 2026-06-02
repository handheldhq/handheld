import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerDevicesCommand } from "./commands/devices.js";
import { registerConnectCommand } from "./commands/connect.js";
import { registerDisconnectCommand } from "./commands/disconnect.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerControlCommands } from "./commands/control.js";
import { registerSnapshotsCommand } from "./commands/snapshots.js";
import { registerShimCommand } from "./commands/shim.js";
import { registerRouteCommand } from "./commands/route.js";
import { registerBillingCommand } from "./commands/billing.js";
import { registerRunCommand } from "./commands/run.js";
import { registerTeachCommand } from "./commands/teach.js";
import { registerGuideCommand, GUIDE_TOPICS } from "./commands/guide.js";
import { parseSettleMs } from "./action-wait.js";

const program = new Command()
  .name("handheld")
  .description(
    "Android device control for agents — drive a cloud phone or a local adb device with the snap -> act -> verify loop"
  )
  .version("0.1.0")
  .option("--device <id>", "target device ID (or set HANDHELD_DEVICE env)")
  .option("--json", "output as JSON")
  .option("--settle <ms>", "max post-action settle wait in ms", parseSettleMs)
  .option("--no-settle", "skip post-action settle waits")
  .option("--post-state", "include the settled post-action snapshot in the result")
  .option("--quiet", "minimal output");

registerAuthCommands(program);
registerDevicesCommand(program);
registerConnectCommand(program);
registerDisconnectCommand(program);
registerStatusCommand(program);
registerControlCommands(program);
registerSnapshotsCommand(program);
registerShimCommand(program);
registerRouteCommand(program);
registerBillingCommand(program);
registerRunCommand(program);
registerTeachCommand(program);
registerGuideCommand(program);

program.addHelpText(
  "after",
  "\nAgents: run `handheld guide` for the operating manual (loop, snapshot format, selectors, troubleshooting)."
);

program.option("--mcp", "run as MCP server (stdio)");

program.action(async () => {
  const options = program.opts<{ device?: string; mcp?: boolean }>();
  if (options.mcp) {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer(options.device);
    return;
  }

  program.help();
});

// Make `handheld help <x>` always useful: a guide topic routes to `guide <topic>`,
// any other word routes to that command's `--help` (the bare program otherwise
// rejects `help <command>` as extra args). Bare `handheld help` is left to commander.
const argv = process.argv;
if (argv[2] === "help" && argv[3] && !argv[3].startsWith("-")) {
  if (GUIDE_TOPICS.includes(argv[3].toLowerCase())) {
    argv.splice(2, 2, "guide", argv[3]);
  } else {
    argv.splice(2, 2, argv[3], "--help");
  }
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
