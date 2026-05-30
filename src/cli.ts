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
import { parseSettleMs } from "./action-wait.js";

const program = new Command()
  .name("handheld")
  .description("CLI for Handheld cloud phone control")
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

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
