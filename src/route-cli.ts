import { runRouteCommand } from "./commands/route-runner.js";

function parseArgs(argv: string[]) {
  let check = false;
  let exec = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--exec") {
      exec = true;
      continue;
    }
    positionals.push(arg);
  }

  return {
    adbArgs: positionals.slice(1),
    check,
    exec,
    serial: positionals[0],
  };
}

const parsed = parseArgs(process.argv.slice(2));

if (!parsed.check && !parsed.exec) {
  process.exit(1);
}

await runRouteCommand({
  adbArgs: parsed.adbArgs,
  check: parsed.check,
  serial: parsed.serial,
});
