#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.js");
const RESULTS_DIR = join(PACKAGE_ROOT, "bench-results");

const args = process.argv.slice(2);

function flag(name, fallback) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  return args[idx + 1] ?? fallback;
}

function has(name) {
  return args.includes(name);
}

const RUNS = Number.parseInt(flag("--runs", "3"), 10);
const PAD_CODE = flag("--pad-code");
const DEVICE_ID = flag("--device-id");
const LABEL = flag("--label", "baseline");
const INCLUDE_SCREENSHOT = !has("--skip-screenshot");
const INCLUDE_EXTRA_SHELLS = has("--extra-shells");

if (!existsSync(CLI_PATH)) {
  console.error(`mu CLI build not found at ${CLI_PATH}`);
  console.error("Run `pnpm --filter mu build` first.");
  process.exit(1);
}

if (!Number.isFinite(RUNS) || RUNS < 1) {
  console.error("--runs must be a positive integer");
  process.exit(1);
}

const connectionsPath = join(process.env.HOME ?? "", ".mu", "connections.json");
const connections = existsSync(connectionsPath)
  ? JSON.parse(readFileSync(connectionsPath, "utf8"))
  : [];

const connection =
  connections.find((entry) => PAD_CODE && entry.padCode === PAD_CODE) ??
  connections.find((entry) => DEVICE_ID && entry.deviceId === DEVICE_ID) ??
  connections[0];

if (!connection) {
  console.error("No active mu connection was found.");
  console.error("Run `mu connect <device-id>` first.");
  process.exit(1);
}

function run(cmd, cmdArgs, timeoutMs = 120_000) {
  const startedAt = performance.now();
  const result = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const durationMs = performance.now() - startedAt;

  return {
    durationMs,
    error: result.error?.message,
    exitCode: result.status,
    ok: !result.error && result.status === 0,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    avg: Math.round(avg),
    max: Math.round(sorted[sorted.length - 1]),
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    min: Math.round(sorted[0]),
    n: samples.length,
  };
}

function benchmark(name, cmd, cmdArgs, timeoutMs) {
  const warmup = run(cmd, cmdArgs, timeoutMs);
  if (!warmup.ok) {
    return {
      failure: {
        error: warmup.error,
        exitCode: warmup.exitCode,
        stderr: warmup.stderr.slice(0, 400),
        stdout: warmup.stdout.slice(0, 400),
      },
      name,
      warmupMs: Math.round(warmup.durationMs),
    };
  }

  const samples = [];
  for (let i = 0; i < RUNS; i += 1) {
    const result = run(cmd, cmdArgs, timeoutMs);
    if (!result.ok) {
      return {
        failure: {
          error: result.error,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 400),
          stdout: result.stdout.slice(0, 400),
        },
        name,
        warmupMs: Math.round(warmup.durationMs),
      };
    }
    samples.push(result.durationMs);
  }

  return {
    name,
    stats: summarize(samples),
    warmupMs: Math.round(warmup.durationMs),
  };
}

const serial = connection.adb?.serial ?? "";

const benches = [
  {
    name: "mu status",
    cmd: "node",
    args: [CLI_PATH, "status", "--json"],
  },
  {
    name: "mu key home",
    cmd: "node",
    args: [CLI_PATH, "key", "home", "--json"],
  },
  {
    name: "mu key back",
    cmd: "node",
    args: [CLI_PATH, "key", "back", "--json"],
  },
  {
    name: "mu tap",
    cmd: "node",
    args: [CLI_PATH, "tap", "540", "960", "--json"],
  },
  {
    name: "mu swipe",
    cmd: "node",
    args: [
      CLI_PATH,
      "swipe",
      "540",
      "1400",
      "540",
      "400",
      "--duration",
      "300",
      "--json",
    ],
  },
  {
    name: "mu type",
    cmd: "node",
    args: [CLI_PATH, "type", "hello", "--json"],
  },
  {
    name: "mu shell",
    cmd: "node",
    args: [CLI_PATH, "shell", "getprop ro.product.model", "--json"],
  },
];

if (connection.relay?.connected) {
  benches.push({
    name: "mu snapshot_xml route",
    cmd: "node",
    args: [CLI_PATH, "_route", "", "exec-out", "uiautomator", "dump", "/dev/tty", "--exec"],
    timeoutMs: 180_000,
  });
}

if (INCLUDE_EXTRA_SHELLS) {
  benches.push(
    {
      name: "mu shell pm list packages",
      cmd: "node",
      args: [
        CLI_PATH,
        "shell",
        "pm list packages | head -n 50",
        "--json",
      ],
      timeoutMs: 180_000,
    },
    {
      name: "mu shell dumpsys window focus",
      cmd: "node",
      args: [
        CLI_PATH,
        "shell",
        "dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp|mInputMethodWindow|isStatusBarKeyguard' | head -n 40",
        "--json",
      ],
      timeoutMs: 180_000,
    },
    {
      name: "mu shell uiautomator dump",
      cmd: "node",
      args: [
        CLI_PATH,
        "shell",
        "uiautomator dump /sdcard/mu_bench_ui.xml >/dev/null 2>&1 && cat /sdcard/mu_bench_ui.xml | head -c 12000",
        "--json",
      ],
      timeoutMs: 180_000,
    }
  );
}

if (serial) {
  benches.push(
    {
      name: "adb key home",
      cmd: "adb",
      args: ["-s", serial, "shell", "input", "keyevent", "3"],
    },
    {
      name: "adb key back",
      cmd: "adb",
      args: ["-s", serial, "shell", "input", "keyevent", "4"],
    },
    {
      name: "adb tap",
      cmd: "adb",
      args: ["-s", serial, "shell", "input", "tap", "540", "960"],
    },
    {
      name: "adb swipe",
      cmd: "adb",
      args: ["-s", serial, "shell", "input", "swipe", "540", "1400", "540", "400", "300"],
    },
    {
      name: "adb type",
      cmd: "adb",
      args: ["-s", serial, "shell", "input", "text", "hello"],
    },
    {
      name: "adb shell",
      cmd: "adb",
      args: ["-s", serial, "shell", "getprop", "ro.product.model"],
    }
  );
  if (INCLUDE_EXTRA_SHELLS) {
    benches.push(
      {
        name: "adb exec-out uiautomator dump",
        cmd: "adb",
        args: ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"],
        timeoutMs: 180_000,
      },
      {
        name: "adb shell pm list packages",
        cmd: "adb",
        args: ["-s", serial, "shell", "pm list packages | head -n 50"],
        timeoutMs: 180_000,
      },
      {
        name: "adb shell dumpsys window focus",
        cmd: "adb",
        args: [
          "-s",
          serial,
          "shell",
          "dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp|mInputMethodWindow|isStatusBarKeyguard' | head -n 40",
        ],
        timeoutMs: 180_000,
      },
      {
        name: "adb shell uiautomator dump",
        cmd: "adb",
        args: [
          "-s",
          serial,
          "shell",
          "uiautomator dump /sdcard/mu_bench_ui.xml >/dev/null 2>&1 && cat /sdcard/mu_bench_ui.xml | head -c 12000",
        ],
        timeoutMs: 180_000,
      }
    );
  }
}

if (INCLUDE_SCREENSHOT) {
  benches.push(
    {
      name: "mu screenshot",
      cmd: "node",
      args: [CLI_PATH, "screenshot", "--json"],
      timeoutMs: 180_000,
    }
  );
  if (serial) {
    benches.push({
      name: "adb screenshot",
      cmd: "adb",
      args: ["-s", serial, "exec-out", "screencap", "-p"],
      timeoutMs: 180_000,
    });
  }
}

const results = benches.map((entry) =>
  benchmark(entry.name, entry.cmd, entry.args, entry.timeoutMs)
);

const output = {
  connection: {
    deviceId: connection.deviceId,
    padCode: connection.padCode,
    serial,
  },
  label: LABEL,
  results,
  runs: RUNS,
  timestamp: new Date().toISOString(),
};

mkdirSync(RESULTS_DIR, { recursive: true });
const fileName = `${LABEL}-${connection.padCode ?? connection.deviceId ?? "connection"}-${new Date()
  .toISOString()
  .slice(0, 19)
  .replace(/[:T]/g, "-")}.json`;
const outputPath = join(RESULTS_DIR, fileName);
writeFileSync(outputPath, JSON.stringify(output, null, 2));

console.log(JSON.stringify(output, null, 2));
console.error(`saved: ${outputPath}`);
