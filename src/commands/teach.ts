import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { connectDevice } from "./connect.js";
import { HandheldApiClient } from "../api-client.js";
import { getResolvedDevice } from "../auth.js";
import { getConnection } from "../state.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ENVELOPE_SCHEMA = "handheld.teach.envelope.v1";

export interface TeachEnvelope {
  schema: typeof ENVELOPE_SCHEMA;
  teachId: string;
  objective: string;
  package: string | null;
  deviceId: string | null;
  viewerUrl: string | null;
  status: "waiting" | "ready" | "timeout" | "error";
  message?: string;
  createdAt: string;
  capturedAt: string | null;
  dir: string;
  bundleZip: string | null;
  bundleDir: string | null;
  trajectoryPath: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Project-local teach dir, in the invoking agent's workspace (cwd) — mirrors .handheld/runs/. */
export function getProjectTeachDir(): string {
  return resolve(process.cwd(), ".handheld", "teach");
}

export function buildTeachId(objective: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slug = slugify(objective).slice(0, 32) || "teach";
  return `${stamp}-${slug}-${randomBytes(3).toString("hex")}`;
}

function defaultDownloadsDir(): string {
  return join(homedir(), "Downloads");
}

function writeEnvelope(path: string, env: TeachEnvelope): void {
  writeFileSync(path, JSON.stringify(env, null, 2) + "\n", { mode: FILE_MODE });
}

/**
 * Find a `mu-trajectory-*.zip` in `dir` newer than `sinceMs`, preferring one
 * whose name contains `deviceId`. Returns the absolute path or null.
 */
export function findTrajectoryBundle(input: {
  dir: string;
  sinceMs: number;
  deviceId?: string | null;
}): string | null {
  if (!existsSync(input.dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(input.dir)) {
    if (!/^mu-trajectory-.*\.zip$/i.test(name)) continue;
    const full = join(input.dir, name);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    // Small slack: the download may have started a beat before our recorded start.
    if (mtime < input.sinceMs - 2000) continue;
    const matchesDevice = input.deviceId ? name.includes(input.deviceId) : false;
    // Prefer device-matching, then newest.
    const score = (matchesDevice ? 1e15 : 0) + mtime;
    const bestScore = best ? (best.path.includes(input.deviceId ?? "\0") ? 1e15 : 0) + best.mtime : -1;
    if (!best || score > bestScore) best = { path: full, mtime };
  }
  return best?.path ?? null;
}

/** Best-effort unzip via the system `unzip`. Returns the extracted dir, or null if it failed. */
function tryExtract(zipPath: string, destDir: string): string | null {
  try {
    mkdirSync(destDir, { mode: DIR_MODE, recursive: true });
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "ignore" });
    return destDir;
  } catch {
    return null;
  }
}

/** Ingest a downloaded bundle into the teach dir and mark the envelope ready. */
export function ingestBundle(input: {
  envelopePath: string;
  env: TeachEnvelope;
  sourceZip: string;
}): TeachEnvelope {
  const dir = input.env.dir;
  const bundleZip = join(dir, "bundle.zip");
  copyFileSync(input.sourceZip, bundleZip);
  const bundleDir = tryExtract(bundleZip, join(dir, "bundle"));
  let trajectoryPath: string | null = null;
  if (bundleDir) {
    const candidate = join(bundleDir, "trajectory.json");
    if (existsSync(candidate)) trajectoryPath = candidate;
  }
  const next: TeachEnvelope = {
    ...input.env,
    status: "ready",
    capturedAt: nowIso(),
    bundleZip,
    bundleDir,
    trajectoryPath,
    message: trajectoryPath
      ? "Demonstration captured. Run the teach-from-human skill on trajectoryPath."
      : "Bundle captured (extract failed — point the skill at bundleZip).",
  };
  writeEnvelope(input.envelopePath, next);
  return next;
}

interface TeachOptions {
  device?: string;
  package?: string;
  open?: boolean;
  timeout?: number;
  downloads?: string;
  teachId?: string;
  json?: boolean;
  background?: boolean;
}

export async function runTeach(
  objective: string,
  opts: TeachOptions,
  programDevice?: string
): Promise<TeachEnvelope> {
  const json = !!opts.json;
  const deviceId = getResolvedDevice(opts.device ?? programDevice) ?? null;

  const teachId = opts.teachId ?? buildTeachId(objective);
  const dir = join(getProjectTeachDir(), teachId);
  mkdirSync(dir, { mode: DIR_MODE, recursive: true });
  const envelopePath = join(dir, "envelope.json");
  writeFileSync(join(dir, "objective.md"), objective + "\n", { mode: FILE_MODE });

  let env: TeachEnvelope = {
    schema: ENVELOPE_SCHEMA,
    teachId,
    objective,
    package: opts.package ?? null,
    deviceId,
    viewerUrl: null,
    status: "waiting",
    createdAt: nowIso(),
    capturedAt: null,
    dir,
    bundleZip: null,
    bundleDir: null,
    trajectoryPath: null,
    message: "Opening the live viewer; waiting for the human demonstration.",
  };
  writeEnvelope(envelopePath, env);

  // Open the live viewer (relay-only, headed) — the same browser pop the auth/init
  // flow uses, but pointed at the device's live view for the human to take over.
  const startMs = Date.now();
  if (!deviceId) {
    env = { ...env, status: "error", message: "No device. Pass --device or set a default; teach needs a cloud device with a live viewer." };
    writeEnvelope(envelopePath, env);
    if (json) console.log(JSON.stringify(env));
    else {
      console.error(env.message);
      console.error("Hint: claim one with `handheld init`, or pass `--device <id>` (see `handheld devices`).");
    }
    return env;
  }
  try {
    const result = await connectDevice({
      api: new HandheldApiClient(),
      deviceId,
      headed: opts.open !== false,
      json,
      webrtcOnly: true,
    });
    env = { ...env, viewerUrl: result.relay.viewerUrl ?? null };
    writeEnvelope(envelopePath, env);
    if (!result.relay.viewerUrl) {
      env = { ...env, status: "error", message: "This device has no live viewer (local/relay-less). Teach needs a cloud device with a relay live view." };
      writeEnvelope(envelopePath, env);
      if (json) console.log(JSON.stringify(env));
      else {
        console.error(env.message);
        console.error("Hint: target a cloud phone instead (`handheld devices`, then `--device <id>`); local adb devices can't be taught (no relay viewer).");
      }
      return env;
    }
  } catch (err) {
    env = { ...env, status: "error", message: `connect failed: ${(err as Error).message}` };
    writeEnvelope(envelopePath, env);
    if (json) console.log(JSON.stringify(env));
    else {
      console.error(env.message);
      console.error("Hint: check auth (`handheld login` / HANDHELD_API_KEY) and that the device is up (`handheld devices`); then retry.");
    }
    return env;
  }

  const downloadsDir = opts.downloads ?? defaultDownloadsDir();
  const timeoutSec = opts.timeout && opts.timeout > 0 ? opts.timeout : 1800;

  if (!json) {
    console.log(`Live viewer: ${env.viewerUrl}`);
    console.log(`Teach session: ${dir}`);
    console.log(`Envelope:      ${envelopePath}`);
    console.log("");
    console.log("→ In the viewer: Record your demonstration, then Stop. The viewer");
    console.log(`  downloads a mu-trajectory zip; this watches ${downloadsDir} for it.`);
    console.log(`  Waiting up to ${Math.round(timeoutSec)}s…`);
  }

  // Watch the downloads dir for the bundle the viewer drops on stop.
  const deadline = startMs + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const found = findTrajectoryBundle({ dir: downloadsDir, sinceMs: startMs, deviceId });
    if (found) {
      // Let the download finish writing (size stable across two reads).
      const s1 = statSync(found).size;
      await sleep(800);
      const s2 = existsSync(found) ? statSync(found).size : -1;
      if (s2 === s1 && s2 >= 0) {
        env = ingestBundle({ envelopePath, env, sourceZip: found });
        if (json) console.log(JSON.stringify(env));
        else {
          console.log("");
          console.log(`✓ Captured: ${basename(found)}`);
          if (env.trajectoryPath) console.log(`  trajectory: ${env.trajectoryPath}`);
          console.log(`  envelope:   ${envelopePath} (status: ready)`);
        }
        return env;
      }
    }
    await sleep(1500);
  }

  env = { ...env, status: "timeout", message: `No trajectory bundle appeared in ${downloadsDir} within ${Math.round(timeoutSec)}s.` };
  writeEnvelope(envelopePath, env);
  if (json) console.log(JSON.stringify(env));
  else console.error(`\n✗ ${env.message}`);
  return env;
}

/**
 * Start a teach session detached (for the agent / MCP path): pre-create the dir +
 * envelope, spawn `handheld teach` in the background, and return the envelope info
 * the caller polls. The caller reads envelopePath until status !== "waiting".
 */
export function startTeachDetached(input: {
  objective: string;
  deviceId?: string;
  package?: string;
  timeoutSec?: number;
}): { teachId: string; dir: string; envelopePath: string } {
  const teachId = buildTeachId(input.objective);
  const dir = join(getProjectTeachDir(), teachId);
  mkdirSync(dir, { mode: DIR_MODE, recursive: true });
  const envelopePath = join(dir, "envelope.json");
  const env: TeachEnvelope = {
    schema: ENVELOPE_SCHEMA,
    teachId,
    objective: input.objective,
    package: input.package ?? null,
    deviceId: input.deviceId ?? null,
    viewerUrl: null,
    status: "waiting",
    createdAt: nowIso(),
    capturedAt: null,
    dir,
    bundleZip: null,
    bundleDir: null,
    trajectoryPath: null,
    message: "Starting teach session…",
  };
  writeEnvelope(envelopePath, env);

  const cliPath = process.argv[1];
  const args = [
    ...(cliPath ? [cliPath] : []),
    "teach",
    "--teach-id",
    teachId,
    ...(input.deviceId ? ["--device", input.deviceId] : []),
    ...(input.package ? ["--package", input.package] : []),
    ...(input.timeoutSec ? ["--timeout", String(input.timeoutSec)] : []),
    input.objective,
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { teachId, dir, envelopePath };
}

export function readEnvelope(envelopePath: string): TeachEnvelope | null {
  try {
    return JSON.parse(readFileSync(envelopePath, "utf-8")) as TeachEnvelope;
  } catch {
    return null;
  }
}

export function registerTeachCommand(program: Command): void {
  program
    .command("teach <objective...>")
    .description(
      "open the cloud device's live viewer for a human to demonstrate a task, then capture the trajectory bundle for the teach-from-human skill"
    )
    .option("--device <id>", "target cloud device (falls back to default-device)")
    .option("--package <pkg>", "app the workflow is keyed to (optional hint)")
    .option("--no-open", "do not open a browser; just watch for the bundle")
    .option("--timeout <sec>", "max seconds to wait for the demonstration bundle", parseFloat)
    .option("--downloads <dir>", "directory to watch for the downloaded mu-trajectory zip (default ~/Downloads)")
    .option("--teach-id <id>", "use a pre-assigned teach id (internal; for the detached/agent path)")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld teach <objective...> [--device <id>] [--package <pkg>] [--timeout <sec>] [--downloads <dir>] [--no-open]

Examples:
  handheld teach "Log in to the banking app and reach the dashboard"
  handheld teach "Complete checkout" --package com.shop.app --timeout 1200
  handheld teach "Pair the watch" --no-open      # watch ~/Downloads without popping a browser

Caveats:
  - Needs a CLOUD device with a live viewer (relay) — pass --device or set a default; LOCAL/relay-less devices have no viewer and will error.
  - Needs an API key for the connect step (\`handheld login\` / HANDHELD_API_KEY).
  - In the viewer the human records + stops; this watches the downloads dir for the mu-trajectory zip, then writes a ready 'envelope.json'.
  - Times out (default 1800s) if no bundle appears — confirm the viewer downloaded the zip into --downloads (default ~/Downloads).`
    )
    .action(async (objectiveParts: string[], opts: TeachOptions) => {
      const objective = objectiveParts.join(" ").trim();
      if (!objective) {
        console.error("Usage: handheld teach <objective...>");
        console.error('Hint: pass the task to demonstrate as text, e.g. handheld teach "Log in and open the dashboard".');
        process.exit(1);
      }
      const env = await runTeach(objective, { ...opts, json: program.opts().json }, program.opts().device);
      if (env.status === "timeout" || env.status === "error") process.exit(1);
    });
}
