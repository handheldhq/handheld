import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HANDHELD_HOME } from "./state.js";
import { findFreePort, probePort } from "./transport/adb/tunnel.js";

export const TINY_PACKAGE = "com.example.tinysnapshot.v2";
export const TINY_LEGACY_PACKAGE = "com.example.tinysnapshot";
export const TINY_RUNNER = "com.example.tinysnapshot.v2/.TinyV2Instrumentation";
export const TINY_DEVICE_PORT = 6792;
export const TINY_TOKEN_HEADER = "X-Mobile-Harness-Tiny-Token";
const TINY_API_PREFIX = "/v2";

export interface TinyHelperState {
  baseUrl: string;
  port: number;
  status: string;
  tokenFile: string;
}

interface AdbResult {
  ok: boolean;
  output: string;
}

export interface TinyStableWaitOptions {
  digest?: "tree" | "action" | "layout";
  minEvents?: number;
  minNodes?: number;
  previousDigest?: string;
  quietMs?: number;
  requireDigestChange?: boolean;
  requestTimeoutMs?: number;
  samples?: number;
  since?: number;
  timeoutMs?: number;
}

export interface TinyChangeWaitOptions {
  requestTimeoutMs?: number;
  since?: number;
  timeoutMs?: number;
}

// Pointer-injection via Tiny's resident UiAutomation (/v2/input). When `settle`
// is set, Tiny injects the gesture AND runs waitForStable server-side in one
// round-trip ("input-with-settle"): it captures the pre-action layoutDigest
// itself, injects, then settles on that filter-independent digest — immune to
// the client-abort-under-load race a separate dispatch+client-wait can hit.
export interface TinyInputOptions {
  type: "tap" | "longPress" | "doubleTap" | "swipe" | "scroll" | "path";
  // tap / longPress / doubleTap
  x?: number;
  y?: number;
  // swipe / scroll
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  // path
  points?: Array<[number, number]>;
  durationMs?: number;
  humanize?: boolean;
  // server-side settle
  settle?: boolean;
  settleTimeoutMs?: number;
  quietMs?: number;
}

export function bundledTinyApkPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../assets/tiny-snapshot-helper.apk"
  );
}

function adb(serial: string, args: string[], timeoutMs = 30_000): AdbResult {
  const fullArgs = ["-s", serial, ...args];
  try {
    const output = execFileSync("adb", fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    }).trim();
    return { ok: true, output };
  } catch (error) {
    const err = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const stdout = Buffer.isBuffer(err.stdout)
      ? err.stdout.toString("utf8")
      : (err.stdout ?? "");
    const stderr = Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8")
      : (err.stderr ?? "");
    return {
      ok: false,
      output: `${stdout}\n${stderr}`.trim() || err.message || "adb failed",
    };
  }
}

function requireAdb(serial: string, args: string[], timeoutMs?: number): string {
  const result = adb(serial, args, timeoutMs);
  if (!result.ok) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.output}`);
  }
  return result.output;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tokenFileForPort(port: number): string {
  mkdirSync(HANDHELD_HOME, { recursive: true, mode: 0o700 });
  return resolve(HANDHELD_HOME, `tiny-${port}.token`);
}

// Tiny binds 127.0.0.1:6792 on the device, so the only ways to reach it
// (adb-forward, on-device shell) already require device access — the token is
// NOT a security boundary. It used to be random per instrumentation-start +
// stored in a file, which caused 403 churn whenever Tiny was (re)started by a
// different session/client (the stored token then mismatched). A fixed,
// well-known value means every client/session agrees without coordination, so
// the token is never a moving part. Device access (adb/relay) remains the real
// auth boundary, exactly as when controlling the device directly.
export const FIXED_TINY_TOKEN = "mu-tiny-localhost-v1";

export function ensureTinyToken(
  port = TINY_DEVICE_PORT
): { token: string; tokenFile: string } {
  const tokenFile = tokenFileForPort(port);
  // Keep the on-disk token file in sync (the direct-HTTP path reads it), but
  // always pin it to the fixed value — never return a stale random token.
  try {
    const existing = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
    if (existing !== FIXED_TINY_TOKEN) {
      writeFileSync(tokenFile, `${FIXED_TINY_TOKEN}\n`, { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
    }
  } catch {
    // best-effort; the token value is fixed regardless of the file
  }
  return { token: FIXED_TINY_TOKEN, tokenFile };
}

export function tinyDeviceInstallCommand(apkPath: string): string {
  const quotedApk = shellQuote(apkPath);
  return [
    `pm install -r -t ${quotedApk} >/dev/null`,
    `|| (pm uninstall ${shellQuote(TINY_PACKAGE)} >/dev/null 2>&1; pm install -r -t ${quotedApk} >/dev/null)`,
    "&& echo OK",
  ].join(" ");
}

// Uninstall any existing Tiny (current + legacy package) so a subsequent
// install of the bundled APK definitely replaces it — `pm install -r` silently
// keeps the old build on a signing-key mismatch, and bootstrap otherwise
// short-circuits when Tiny is already running. Used by `tiny bootstrap --force`.
export function tinyDeviceUninstallCommand(): string {
  return [
    `pm uninstall ${shellQuote(TINY_PACKAGE)} >/dev/null 2>&1`,
    `; pm uninstall ${shellQuote(TINY_LEGACY_PACKAGE)} >/dev/null 2>&1`,
    "; echo OK",
  ].join(" ");
}

export function tinyDeviceStartCommand(token: string): string {
  return [
    `am force-stop ${shellQuote(TINY_LEGACY_PACKAGE)}`,
    `am force-stop ${shellQuote(TINY_PACKAGE)}`,
    `(${[
      "am instrument -w",
      "-e authToken",
      shellQuote(token),
      shellQuote(TINY_RUNNER),
      ">/dev/null 2>&1 </dev/null &",
    ].join(" ")})`,
    "echo OK",
  ].join("; ");
}

export function tinyDeviceRequestCommand(
  path: string,
  token: string,
  opts: { body?: string; maxTimeSec?: number; method?: string } = {},
): string {
  const normalizedPath = tinyApiPath(path);
  const parts = [
    "curl -sf",
    `--max-time ${Math.max(1, Math.round(opts.maxTimeSec ?? 5))}`,
    "-H",
    shellQuote(`${TINY_TOKEN_HEADER}: ${token}`),
  ];
  if (opts.method && opts.method.toUpperCase() !== "GET") {
    parts.push("-X", opts.method.toUpperCase());
  }
  if (opts.body !== undefined) {
    // The JSON body is single-quoted (shellQuote), so it survives the device sh
    // verbatim — the same form proven to drive POST /v2/input over the relay.
    parts.push("-H", shellQuote("Content-Type: application/json"));
    parts.push("--data", shellQuote(opts.body));
  }
  parts.push(shellQuote(`http://127.0.0.1:${TINY_DEVICE_PORT}${normalizedPath}`));
  return parts.join(" ");
}

function tinyApiPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.startsWith(`${TINY_API_PREFIX}/`)
    ? normalized
    : `${TINY_API_PREFIX}${normalized}`;
}

async function preferredTinyPort(): Promise<number> {
  if (!(await probePort(TINY_DEVICE_PORT))) {
    return TINY_DEVICE_PORT;
  }
  return await findFreePort();
}

function installTinyApk(serial: string): void {
  const apkPath = bundledTinyApkPath();
  if (!existsSync(apkPath)) {
    throw new Error(`bundled Tiny helper APK missing at ${apkPath}`);
  }

  const install = adb(serial, ["install", "-r", "-t", apkPath], 60_000);
  if (install.ok) return;

  if (!install.output.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) {
    throw new Error(install.output);
  }

  adb(serial, ["uninstall", TINY_PACKAGE], 30_000);
  requireAdb(serial, ["install", "-r", "-t", apkPath], 60_000);
}

function startTinyInstrumentation(serial: string, token: string): void {
  adb(serial, ["shell", "am", "force-stop", TINY_LEGACY_PACKAGE]);
  adb(serial, ["shell", "am", "force-stop", TINY_PACKAGE]);
  requireAdb(serial, [
    "shell",
    `am instrument -w -e authToken ${shellQuote(token)} ${TINY_RUNNER} >/dev/null 2>&1 </dev/null &`,
  ]);
}

async function fetchTinyStatus(
  baseUrl: string,
  token: string,
  timeoutMs = 1_000
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${TINY_API_PREFIX}/status`, {
      headers: { [TINY_TOKEN_HEADER]: token },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("Tiny returned non-object status");
    }
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTinyJson(input: {
  baseUrl: string;
  body?: string;
  method?: string;
  path: string;
  timeoutMs?: number;
  token: string;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await fetch(`${input.baseUrl}${input.path}`, {
      body: input.body,
      headers: {
        [TINY_TOKEN_HEADER]: input.token,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
      },
      method: input.method ?? (input.body ? "POST" : "GET"),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("Tiny returned non-object response");
    }
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export function tinyWaitForStablePath(opts: TinyStableWaitOptions): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    minEvents: opts.minEvents,
    minNodes: opts.minNodes,
    quietMs: opts.quietMs,
    samples: opts.samples,
    since: opts.since,
    timeoutMs: opts.timeoutMs,
  })) {
    if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(Math.max(0, Math.round(value))));
    }
  }
  if (opts.requireDigestChange) params.set("requireDigestChange", "true");
  if (opts.digest) params.set("digest", opts.digest);
  if (opts.previousDigest) params.set("previousDigest", opts.previousDigest);
  const query = params.toString();
  return query ? `${TINY_API_PREFIX}/waitForStable?${query}` : `${TINY_API_PREFIX}/waitForStable`;
}

export function tinyWaitForChangePath(opts: TinyChangeWaitOptions): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    since: opts.since,
    timeoutMs: opts.timeoutMs,
  })) {
    if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(Math.max(0, Math.round(value))));
    }
  }
  const query = params.toString();
  return query ? `${TINY_API_PREFIX}/waitForChange?${query}` : `${TINY_API_PREFIX}/waitForChange`;
}

/**
 * Client-side abort budget for a Tiny wait request. The device bounds itself by
 * `timeoutMs`, but stable-sampling on a busy screen can overrun that, so the
 * client must wait comfortably longer than the device ever could — otherwise
 * the very transition we are waiting on aborts the request and settle silently
 * degrades to a blind sleep. (See F2.)
 */
export function tinyRequestTimeoutMs(opts: {
  requestTimeoutMs?: number;
  timeoutMs?: number;
}): number {
  if (typeof opts.requestTimeoutMs === "number") return opts.requestTimeoutMs;
  return (opts.timeoutMs ?? 1_500) + 5_000;
}

async function waitForTinyStatus(
  baseUrl: string,
  token: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchTinyStatus(baseUrl, token);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Tiny helper did not become ready: ${message}`);
}

export async function startTinyHelper(input: {
  port?: number;
  serial: string;
}): Promise<TinyHelperState> {
  const port = input.port ?? (await preferredTinyPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const { token, tokenFile } = ensureTinyToken(port);

  adb(input.serial, ["forward", "--remove", `tcp:${port}`]);
  requireAdb(input.serial, ["forward", `tcp:${port}`, `tcp:${TINY_DEVICE_PORT}`]);

  // Reclaim handshake (#8): if a healthy Tiny already answers our token, REUSE
  // it instead of force-stop + relaunch. Avoids needlessly killing a Tiny we (or
  // another manager sharing this token) already have running — the cause of the
  // 403/restart churn when two owners contend for the fixed device port. A
  // running Tiny on a *different* token rejects us (throws) → we fall through to
  // (re)start it as before, so this only ever reuses a Tiny we can authenticate.
  try {
    const status = await fetchTinyStatus(baseUrl, token, 1_500);
    if (status.ready === true) {
      return {
        baseUrl,
        port,
        status: typeof status.status === "string" ? status.status : "ready",
        tokenFile,
      };
    }
  } catch {}

  try {
    startTinyInstrumentation(input.serial, token);
    const status = await waitForTinyStatus(baseUrl, token);
    return {
      baseUrl,
      port,
      status: typeof status.status === "string" ? status.status : "ready",
      tokenFile,
    };
  } catch {}

  installTinyApk(input.serial);
  startTinyInstrumentation(input.serial, token);

  const status = await waitForTinyStatus(baseUrl, token);
  return {
    baseUrl,
    port,
    status: typeof status.status === "string" ? status.status : "ready",
    tokenFile,
  };
}

export async function getTinyStatus(input: {
  baseUrl: string;
  tokenFile: string;
}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyStatus(input.baseUrl, token, 3_000);
}

export async function getTinySnapshot(input: {
  baseUrl: string;
  tokenFile: string;
}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    path: `${TINY_API_PREFIX}/snapshot`,
    timeoutMs: 10_000,
    token,
  });
}

export async function waitTinyStable(input: {
  baseUrl: string;
  tokenFile: string;
}, opts: TinyStableWaitOptions = {}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    path: tinyWaitForStablePath(opts),
    timeoutMs: tinyRequestTimeoutMs(opts),
    token,
  });
}

export async function waitTinyChange(input: {
  baseUrl: string;
  tokenFile: string;
}, opts: TinyChangeWaitOptions = {}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    path: tinyWaitForChangePath(opts),
    timeoutMs: tinyRequestTimeoutMs(opts),
    token,
  });
}

export interface TinySetTextOptions {
  clear?: string;
  mode?: "semantic" | "paste";
  stableId?: string;
  target?: string;
  text: string;
}

/**
 * Build the `/v2/setText` request body. `semantic` mode uses
 * AccessibilityNodeInfo.ACTION_SET_TEXT (deterministic, replace-only) — the
 * reliable alternative to racy `adb input text` key injection. `target`
 * defaults to "focused" on the device when neither target nor stableId is set.
 */
export function tinySetTextBody(opts: TinySetTextOptions): string {
  const body: Record<string, string> = {
    mode: opts.mode ?? "semantic",
    text: opts.text,
    clear: opts.clear ?? "replace",
  };
  if (opts.stableId) body.stableId = opts.stableId;
  if (opts.target) body.target = opts.target;
  if (!opts.stableId && !opts.target) body.target = "focused";
  return JSON.stringify(body);
}

export async function tinySetText(input: {
  baseUrl: string;
  tokenFile: string;
}, opts: TinySetTextOptions): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    body: tinySetTextBody(opts),
    path: `${TINY_API_PREFIX}/setText`,
    timeoutMs: 8_000,
    token,
  });
}

/** Does this Tiny build support /v2/input (pointer injection)? Read from the
 * /status capabilities so callers fall back cleanly on older helpers. */
export function tinySupportsInput(status: Record<string, unknown> | null | undefined): boolean {
  const caps = status && typeof status === "object"
    ? (status as { capabilities?: unknown }).capabilities
    : undefined;
  return Boolean(caps && typeof caps === "object" && (caps as { input?: unknown }).input === true);
}

/** Serialize a /v2/input request body, dropping undefined fields. Pure (tested). */
export function tinyInputBody(opts: TinyInputOptions): string {
  const body: Record<string, unknown> = { type: opts.type };
  for (const k of ["x", "y", "x1", "y1", "x2", "y2", "durationMs"] as const) {
    if (opts[k] !== undefined) body[k] = opts[k];
  }
  if (opts.points !== undefined) body.points = opts.points;
  if (opts.humanize !== undefined) body.humanize = opts.humanize;
  if (opts.settle) {
    body.settle = true;
    if (opts.settleTimeoutMs !== undefined) body.settleTimeoutMs = opts.settleTimeoutMs;
    if (opts.quietMs !== undefined) body.quietMs = opts.quietMs;
  }
  return JSON.stringify(body);
}

/** Client read budget for an input-with-settle call: must outlast Tiny's own
 * injection (durationMs) + server settle (settleTimeoutMs) so the client never
 * aborts a gesture that is still genuinely in flight. */
export function tinyInputTimeoutMs(opts: TinyInputOptions): number {
  const settle = opts.settle ? (opts.settleTimeoutMs ?? 1_500) : 0;
  const duration = opts.durationMs ?? 0;
  return settle + duration + 5_000;
}

/** POST a gesture to Tiny /v2/input. With opts.settle, the response carries
 * `changed` + `settle` metadata + the fresh post-action `snapshot`. */
export async function tinyInput(input: {
  baseUrl: string;
  tokenFile: string;
}, opts: TinyInputOptions): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    body: tinyInputBody(opts),
    path: `${TINY_API_PREFIX}/input`,
    timeoutMs: tinyInputTimeoutMs(opts),
    token,
  });
}

/** Capture a screenshot via Tiny (UiAutomation.takeScreenshot). Supports
 * format=jpg|png + quality (JPEG is ~5-10x smaller than PNG); response carries
 * base64 `data` + `mimeType`. /screenshot chunks, so this works over the relay
 * device-shell too. */
export async function tinyScreenshot(input: {
  baseUrl: string;
  tokenFile: string;
}, opts: { format?: string; quality?: number } = {}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  const params = new URLSearchParams();
  if (opts.format) params.set("format", opts.format);
  if (opts.quality !== undefined) params.set("quality", String(opts.quality));
  const q = params.toString();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    path: `${TINY_API_PREFIX}/screenshot${q ? `?${q}` : ""}`,
    timeoutMs: 20_000,
    token,
  });
}

/**
 * Set the device clipboard in-process via ClipboardManager. `cmd clipboard set`
 * is unimplemented on API 31+, so this is the reliable path for `copy`.
 */
export async function tinyClipboardSet(input: {
  baseUrl: string;
  tokenFile: string;
}, text: string): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    body: JSON.stringify({ text }),
    path: `${TINY_API_PREFIX}/clipboard`,
    timeoutMs: 5_000,
    token,
  });
}

/**
 * Read the device clipboard. NOTE: Android restricts clipboard reads to the
 * foreground app / default IME on API 29+, so this background instrumentation
 * usually cannot read it — the response carries `restricted: true` in that case.
 */
export async function tinyClipboardGet(input: {
  baseUrl: string;
  tokenFile: string;
}): Promise<Record<string, unknown>> {
  const token = readFileSync(input.tokenFile, "utf8").trim();
  return await fetchTinyJson({
    baseUrl: input.baseUrl,
    path: `${TINY_API_PREFIX}/clipboard`,
    timeoutMs: 5_000,
    token,
  });
}
