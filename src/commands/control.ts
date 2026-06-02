import { basename } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
  getActiveConnection,
  getConnection,
  getRelayState,
  saveConnection,
  type Connection,
  type TinyState,
} from "../state.js";
import { getAuthorizationHeaders } from "../auth.js";
import {
  RelayClient,
  relaySwipeShellCommand,
  relayTapShellCommand,
} from "../transport/relay/client.js";
import { AdbTransport } from "../transport/adb/client.js";
import { requestRelayDaemon, spawnRelayDaemon } from "../transport/relay/daemon.js";
import { routeCommand } from "../transport/router.js";
import { HandheldApiClient } from "../api-client.js";
import type {
  CommandResult,
  ScreenshotResult,
  Transport,
  TransportCommand,
  KeyInput,
} from "../transport/types.js";
import {
  bundledTinyApkPath,
  ensureTinyToken,
  getTinySnapshot,
  getTinyStatus,
  startTinyHelper,
  tinyClipboardGet,
  tinyClipboardSet,
  TINY_DEVICE_PORT,
  TINY_PACKAGE,
  tinyDeviceInstallCommand,
  tinyDeviceRequestCommand,
  tinyDeviceStartCommand,
  tinyDeviceUninstallCommand,
  type TinyInputOptions,
  tinyInputBody,
  tinyScreenshot,
  tinySetTextBody,
  tinyWaitForChangePath,
  tinyWaitForStablePath,
  waitTinyStable,
} from "../tiny-helper.js";
import {
  failedBeforeReachingDevice,
  tryServerSettle,
  type TinyInputSender,
} from "../server-settle.js";
import { isStaleSessionError } from "../transport-errors.js";
import type { TinyReader } from "../action-wait.js";
import { hasFocusedEditableField, typeViaTinySetText } from "../text-entry.js";
import {
  formatSnapshot,
  loadLastSnapshot,
  normalizeTinySnapshot,
  saveLastSnapshot,
  snapshotNodesForDisplay,
  type SnapshotDocument,
  type SnapshotOutput,
} from "../snapshot.js";
import {
  amStartError,
  clearFocusedInputCommand,
  currentAppCommand,
  isSnapshotTarget,
  launchTargetCommand,
  launcherActivitiesCommand,
  normalizeKeyInput,
  packageListCommand,
  parseCurrentComponent,
  parseIntOption,
  parseLauncherActivities,
  parsePackageList,
  parseScreenSize,
  pointFromSnapshotTarget,
  resolveAppPackage,
  screenSizeCommand,
  scrollSwipe,
  startAppCommand,
  stopAppCommand,
} from "../device-actions.js";
import {
  actionWaitOptionsFromCli,
  beginActionWait,
  finishActionWait,
  type ActionWaitResult,
} from "../action-wait.js";

type TransportResult = CommandResult | (ScreenshotResult & { error?: string });
type SettledTransportResult = TransportResult & {
  snapshot?: SnapshotOutput;
  wait?: ActionWaitResult;
};

class RelayDaemonTransport implements Transport {
  readonly connected = true;
  readonly name = "relay" as const;

  constructor(private socketPath: string) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  private async request(
    action: TransportCommand,
    args?: Record<string, unknown>
  ) {
    return await requestRelayDaemon(this.socketPath, { action, args });
  }

  async tap(opts: Parameters<Transport["tap"]>[0]) {
    const response = await this.request("shell", {
      command: relayTapShellCommand(opts),
    });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async swipe(opts: Parameters<Transport["swipe"]>[0]) {
    const response = await this.request("shell", {
      command: relaySwipeShellCommand(opts),
    });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async type(text: string) {
    const response = await this.request("type", { text });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async key(key: KeyInput) {
    const response = await this.request("key", { key });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async screenshot() {
    const response = await this.request("screenshot");
    if (!response.ok || typeof response.data !== "string") {
      return { ok: false, error: response.error };
    }
    return {
      ok: true,
      base64: response.data,
      buffer: Buffer.from(response.data, "base64"),
    };
  }

  async shell(command: string) {
    const response = await this.request("shell", { command });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async clipboard(action: "get" | "set", text?: string) {
    const response = await this.request("clipboard", { action, text });
    return { ok: response.ok, data: response.data, error: response.error };
  }

  async gps(latitude: number, longitude: number) {
    const response = await this.request("gps", { latitude, longitude });
    return { ok: response.ok, data: response.data, error: response.error };
  }
}

function getTransport(program: Command): {
  connection: Connection;
  relay: Transport | null;
  adb: AdbTransport | null;
  deviceId: string;
} {
  const deviceId = program.opts().device ?? process.env.HANDHELD_DEVICE;
  const conn = deviceId ? getConnection(deviceId) : getActiveConnection();

  if (!conn) {
    console.error("Not connected.");
    console.error(
      "Hint: run `handheld connect --local` (local adb device/emulator) or `handheld connect <device-id>` (cloud phone) first; see `handheld guide workflow`."
    );
    process.exit(1);
  }

  const relayState = getRelayState(conn);
  const relay =
    relayState.connected && relayState.socketPath
      ? new RelayDaemonTransport(relayState.socketPath)
      : relayState.connected && relayState.relayUrl
        ? new RelayClient(relayState.relayUrl, getAuthorizationHeaders())
        : null;

  const adb = conn.adb.serial ? new AdbTransport(conn.adb.serial) : null;

  // Stash the live transports so settleCommandResult can build a device-shell
  // TinyReader for the settle path without threading relay/adb through every
  // command's call (one command runs per CLI process, so a module var is safe).
  currentTransports = { adb, relay };
  currentConnection = conn;
  return { adb, connection: conn, deviceId: conn.deviceId, relay };
}

let currentTransports: { adb: AdbTransport | null; relay: Transport | null } | null = null;
let currentConnection: Connection | null = null;

// Refresh an expired relay/live bridge token in place: re-fetch a fresh relay
// URL (re-mints the gateway bridge token with a new exp — no device restart),
// respawn the relay daemon, persist it, and return a fresh relay transport.
// Returns null if there's no relay connection to refresh. Used to transparently
// retry a command that failed because the ~1h bridge token expired.
async function refreshRelay(): Promise<Transport | null> {
  const conn = currentConnection;
  if (!conn) return null;
  const relayState = getRelayState(conn);
  if (!relayState.connected && !relayState.relayUrl) return null;
  const api = new HandheldApiClient();
  const relayInfo = await api.getDeviceRelayInfo(conn.deviceId, { ttlMs: conn.sessionTtlMs });
  const relayUrl = relayInfo.relayUrl;
  let socketPath: string | undefined;
  let daemonPid: number | undefined;
  if (process.platform !== "win32") {
    try {
      const daemon = await spawnRelayDaemon({ deviceId: conn.deviceId, relayUrl });
      socketPath = daemon.socketPath;
      daemonPid = daemon.pid;
    } catch {
      // fall back to a direct RelayClient below
    }
  }
  const refreshed: Connection = {
    ...conn,
    relay: {
      connected: true,
      daemonPid,
      relayUrl,
      socketPath,
      viewerUrl: relayInfo.h5?.viewerUrl ?? conn.relay?.viewerUrl,
    },
  };
  currentConnection = refreshed;
  saveConnection(refreshed);
  return socketPath
    ? new RelayDaemonTransport(socketPath)
    : new RelayClient(relayUrl, getAuthorizationHeaders());
}

async function disconnectRelay(relay: Transport | null): Promise<void> {
  if (!(relay instanceof RelayClient)) {
    return;
  }
  try {
    await relay.disconnect();
  } catch {}
}

function pickTransport(
  command: TransportCommand,
  relay: Transport | null,
  adb: AdbTransport | null
): Transport {
  const route = routeCommand(command, !!relay);
  if (route === "relay" && relay) return relay;
  if (adb) return adb;
  if (relay) return relay;
  console.error("No transport available.");
  console.error(
    "Hint: the connection has neither a relay nor an ADB serial — reconnect (`handheld connect --local` keeps ADB; cloud connect needs a live relay session)."
  );
  process.exit(1);
}

function canFallbackToAdb(
  command: TransportCommand,
  opts: { clipboardAction?: "get" | "set" } = {}
): boolean {
  if (command === "clipboard") return opts.clipboardAction === "set";
  return ["tap", "swipe", "type", "key", "screenshot", "shell"].includes(command);
}

async function executeTransport<T extends TransportResult>(
  transport: Transport,
  execute: (transport: Transport) => Promise<T>
): Promise<T> {
  try {
    return await execute(transport);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
    } as T;
  }
}

async function runWithAdbFallback<T extends TransportResult>(
  command: TransportCommand,
  relay: Transport | null,
  adb: AdbTransport | null,
  execute: (transport: Transport) => Promise<T>,
  opts: { clipboardAction?: "get" | "set"; preferAdb?: boolean } = {}
): Promise<T> {
  const primary = opts.preferAdb && adb
    ? adb
    : pickTransport(command, relay, adb);
  let result = await executeTransport(primary, execute);
  // Relay bridge/live token expired (the ~1h gateway TTL)? The device
  // session is still alive — refresh the token in place (re-mint a fresh bridge
  // token, respawn the daemon) and retry once on the fresh relay, before any
  // adb fallback. Makes the 1h TTL invisible for long sessions.
  if (
    relay &&
    primary === relay &&
    !result.ok &&
    isStaleSessionError("error" in result ? result.error : undefined)
  ) {
    try {
      const fresh = await refreshRelay();
      if (fresh) result = await executeTransport(fresh, execute);
    } catch {
      // refresh failed — fall through to the adb fallback / return below
    }
  }
  if (!adb || primary === adb || !shouldFallbackToAdb(command, opts, result)) {
    return result;
  }
  return await executeTransport(adb, execute);
}

// Mutating commands change device state. The on-device op completes
// independently of the client, so a transport *timeout* (the op may have run,
// only the response was lost) must NOT trigger an adb re-run — that double-fires
// (phantom tap/swipe/keypress). Re-run on adb only when the failure proves the
// op never reached the device (so adb is a first execution, not a resend). (#5)
const MUTATING_COMMANDS = new Set<TransportCommand>(["tap", "swipe", "type", "key"]);

function isMutatingCommand(
  command: TransportCommand,
  opts: { clipboardAction?: "get" | "set" } = {}
): boolean {
  if (command === "clipboard") return opts.clipboardAction === "set";
  return MUTATING_COMMANDS.has(command);
}

// Canonical "did the op reach the device?" predicate lives in server-settle.ts
// (shared by the gesture-settle path); re-exported for control's tests, and used
// by shouldFallbackToAdb below. Imported at the top of the file.
export { failedBeforeReachingDevice };

export function shouldFallbackToAdb(
  command: TransportCommand,
  opts: { clipboardAction?: "get" | "set"; preferAdb?: boolean },
  result: TransportResult
): boolean {
  if (result.ok) return false;
  if (!canFallbackToAdb(command, opts)) return false;
  // Idempotent reads (screenshot / shell) are safe to retry on any failure.
  // Mutating ops resend only when the op provably never ran (#5).
  if (isMutatingCommand(command, opts)) {
    return failedBeforeReachingDevice("error" in result ? result.error : undefined);
  }
  return true;
}

function outputResult(
  program: Command,
  result: SettledTransportResult,
  failurePrefix: string
): boolean {
  if (program.opts().json) {
    console.log(JSON.stringify(result));
  } else if (!result.ok) {
    console.error(`${failurePrefix}:`, result.error ?? "unknown error");
  } else if (result.snapshot) {
    // --post-state in text mode: render the settled snapshot like `snap` does.
    // Nodes are already display-filtered, so format without re-filtering.
    console.log(formatSnapshot(result.snapshot as unknown as SnapshotDocument, { header: true }));
  }
  if (!result.ok) {
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function settleAfterSuccess<T extends TransportResult>(
  result: T,
  beforeAction: Awaited<ReturnType<typeof beginActionWait>>
): Promise<T & { snapshot?: SnapshotOutput; wait?: ActionWaitResult }> {
  if (!result.ok) return result;
  const wait = await finishActionWait(beforeAction);
  if (!wait) return result;
  // Lift the post-action snapshot (when present) to the result's top level so
  // it sits alongside ok/data rather than buried in the settle metadata.
  const { snapshot, ...waitMeta } = wait;
  return snapshot !== undefined
    ? { ...result, snapshot, wait: waitMeta }
    : { ...result, wait: waitMeta };
}

async function ensureTinyState(connection: Connection): Promise<TinyState> {
  if (connection.tiny) return connection.tiny;
  if (!connection.adb.serial) {
    console.error("Snapshot requires the Tiny helper or ADB, and neither is available.");
    console.error(
      "Hint: reconnect with ADB enabled (`handheld connect --local`), or bootstrap the on-device helper with `handheld tiny bootstrap`. See `handheld guide troubleshooting`."
    );
    process.exit(1);
  }

  const tiny = await startTinyHelper({ serial: connection.adb.serial });
  saveConnection({ ...connection, tiny });
  return tiny;
}

function tapTargetFromArgs(input: {
  allowBareIndex?: boolean;
  deviceId: string;
  target: string;
  y?: string;
}): { x: number; y: number } {
  if (shouldResolveSnapshotTarget(input)) {
    const snapshot = loadLastSnapshot(input.deviceId);
    if (!snapshot) {
      console.error(`No cached snapshot to resolve "${input.target}" against.`);
      console.error("Hint: run `handheld snap` first — targets resolve against the last snapshot.");
      process.exit(1);
    }
    const center = pointFromSnapshotTarget(snapshot, input.target);
    if (!center) {
      console.error(`Target "${input.target}" did not resolve to a tappable node.`);
      console.error(
        "Hint: refs renumber on every screen change — re-run `handheld snap` and reread the refs, or use a durable id=/label=/text= selector (see `handheld guide selectors`)."
      );
      process.exit(1);
    }
    return center;
  }

  if (input.y === undefined) {
    console.error(`Could not interpret "${input.target}" as a target.`);
    console.error(
      "Hint: pass a ref/selector (e.g. @e7, id=submit, label=Submit) after `handheld snap`, or two numeric coordinates: `handheld tap <x> <y>`."
    );
    process.exit(1);
  }
  const x = Number(input.target);
  const y = Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    console.error(`Tap coordinates must be numbers (got "${input.target}" "${input.y}").`);
    console.error(
      "Hint: use `handheld tap <x> <y>` with integers, or a snapshot target like @e7 / id=… / label=… ."
    );
    process.exit(1);
  }
  if (x < 0 || y < 0) {
    console.error(`Tap coordinates must be non-negative (got ${x}, ${y}).`);
    console.error("Hint: coordinates are device pixels measured from the top-left corner (0,0).");
    process.exit(1);
  }
  return { x, y };
}

function shouldResolveSnapshotTarget(input: {
  allowBareIndex?: boolean;
  target: string;
  y?: string;
}): boolean {
  if (!isSnapshotTarget(input.target)) return false;
  if (input.y !== undefined && /^\d+$/.test(input.target)) return false;
  return input.allowBareIndex || !/^\d+$/.test(input.target);
}

function isFocusedTarget(target: string | undefined): boolean {
  return !target || target === "-" || target === "focused";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertOk(result: TransportResult, label: string): void {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error ?? "unknown error"}`);
  }
}

async function focusTarget(input: {
  adb: AdbTransport | null;
  deviceId: string;
  relay: Transport | null;
  target?: string;
}): Promise<void> {
  if (isFocusedTarget(input.target)) return;
  const point = tapTargetFromArgs({
    allowBareIndex: true,
    deviceId: input.deviceId,
    target: input.target!,
  });
  assertOk(
    await runWithAdbFallback(
      "tap",
      input.relay,
      input.adb,
      (transport) => transport.tap(point),
      { preferAdb: shouldResolveSnapshotTarget({ allowBareIndex: true, target: input.target! }) }
    ),
    "Focus target failed"
  );
  await sleep(150);
}

async function focusClearAndType(input: {
  adb: AdbTransport | null;
  append?: boolean;
  clear?: boolean;
  deviceId: string;
  relay: Transport | null;
  submit?: boolean;
  target?: string;
  text: string;
  tiny?: TinyState;
}): Promise<TransportResult> {
  // Prefer Tiny over `adb input text` key injection: it sets/inserts the value
  // deterministically instead of replaying keys into an IME that may not be
  // ready, which drops characters after a fresh focus/navigation. Replace uses
  // semantic ACTION_SET_TEXT; --append uses paste mode (clipboard + ACTION_PASTE
  // at the cursor).
  if (input.tiny) {
    const viaTiny = await typeViaTinySetText({
      append: input.append,
      deviceId: input.deviceId,
      target: input.target,
      text: input.text,
      tiny: input.tiny,
    });
    if (viaTiny?.ok) {
      if (!input.submit) return viaTiny;
      return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
        transport.key("enter")
      );
    }
    // Tiny attempted the set but rejected it, and there is no target to focus —
    // nothing is focused, so report that honestly instead of "succeeding"
    // vacuously through key injection into whatever screen is up.
    if (viaTiny && !input.target) {
      return {
        ok: false,
        error: "No input field is focused — tap a field first or pass a target ref.",
      };
    }
    // viaTiny === null (Tiny unusable) or a ref target was given — fall through
    // to the key-injection path (which focuses the target first).
  } else if (input.relay || input.adb) {
    // No direct Tiny endpoint (relay-only / adb): set the field via Tiny
    // /setText over the device-shell channel — deterministic and far faster
    // than `adb input text` key injection (which also drops chars after a fresh
    // focus). Focus a ref/coord target first if one was given.
    if (input.target) await focusTarget(input);
    const token = ensureTinyToken().token;
    const body = tinySetTextBody({
      clear: input.append ? "append" : "replace",
      mode: input.append ? "paste" : "semantic",
      target: "focused",
      text: input.text,
    });
    try {
      const res = await readTinyJsonFromDevice({
        adb: input.adb,
        body,
        method: "POST",
        path: "/setText",
        relay: input.relay,
        token,
      });
      if (res.ok === true) {
        if (!input.submit) return { ok: true, data: res };
        return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
          transport.key("enter")
        );
      }
      // setText reached the device but found nothing to set; with no target to
      // focus, report honestly rather than key-injecting into whatever is up.
      if (!input.target) {
        return {
          ok: false,
          error: "No input field is focused — tap a field first or pass a target ref.",
        };
      }
    } catch {
      // device-shell setText unreachable — fall through to key injection.
    }
  }

  await focusTarget(input);
  if (input.clear !== false && !input.append) {
    assertOk(
      await runShell(input.relay, input.adb, clearFocusedInputCommand()),
      "Clear failed"
    );
  }
  const typed = await runWithAdbFallback("type", input.relay, input.adb, (transport) =>
    transport.type(input.text)
  );
  if (!typed.ok || !input.submit) return typed;
  return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
    transport.key("enter")
  );
}

async function pasteClipboardText(input: {
  adb: AdbTransport | null;
  relay: Transport | null;
}): Promise<TransportResult> {
  const clipboard = await runWithAdbFallback(
    "clipboard",
    input.relay,
    input.adb,
    (transport) => transport.clipboard("get"),
    { clipboardAction: "get" }
  );
  if (clipboard.ok && typeof clipboard.data === "string") {
    if (!clipboard.data) return clipboard;
    return await runWithAdbFallback("type", input.relay, input.adb, (transport) =>
      transport.type(clipboard.data as string)
    );
  }
  return await runWithAdbFallback("key", input.relay, input.adb, (transport) =>
    transport.key(normalizeKeyInput("paste"))
  );
}

async function doubleTap(input: {
  adb: AdbTransport | null;
  intervalMs: number;
  point: { x: number; y: number };
  preferAdb?: boolean;
  relay: Transport | null;
}): Promise<TransportResult> {
  const first = await runWithAdbFallback(
    "tap",
    input.relay,
    input.adb,
    (transport) => transport.tap(input.point),
    { preferAdb: input.preferAdb }
  );
  if (!first.ok) return first;
  await sleep(input.intervalMs);
  return await runWithAdbFallback(
    "tap",
    input.relay,
    input.adb,
    (transport) => transport.tap(input.point),
    { preferAdb: input.preferAdb }
  );
}

async function runShell(
  relay: Transport | null,
  adb: AdbTransport | null,
  command: string
): Promise<CommandResult> {
  return await runWithAdbFallback("shell", relay, adb, (transport) =>
    transport.shell(command)
  );
}

/**
 * Fold the foreground package/activity into a snapshot. Tiny reports the
 * window's app but not the activity, so we read it from `dumpsys window`.
 * Best-effort: a failed or empty lookup leaves `activity`/`component` unset.
 */
async function attachForegroundComponent(
  snapshot: SnapshotDocument,
  relay: Transport | null,
  adb: AdbTransport | null
): Promise<void> {
  try {
    const result = await runShell(relay, adb, currentAppCommand());
    if (!result.ok || typeof result.data !== "string") return;
    const current = parseCurrentComponent(result.data);
    if (current.activity) snapshot.activity = current.activity;
    if (current.component) snapshot.component = current.component;
  } catch {
    // best-effort
  }
}

async function runShellString(
  relay: Transport | null,
  adb: AdbTransport | null,
  command: string,
  label: string
): Promise<string> {
  const result = await runShell(relay, adb, command);
  assertOk(result, label);
  return String(result.data ?? "");
}

async function uploadSessionFile(input: {
  api: HandheldApiClient;
  autoInstall?: boolean;
  chmod?: string;
  contentType?: string;
  customizeFilePath?: string;
  deviceId: string;
  filename?: string;
  libraryPath?: string;
  localFile: string;
  packageName?: string;
  persist?: boolean;
  sessionId?: string;
}) {
  const sessionId =
    input.sessionId || await input.api.resolveActiveSessionId(input.deviceId);
  const size = statSync(input.localFile).size;
  const filename = input.filename ?? basename(input.localFile);
  const intent = await input.api.createSessionUploadIntent(sessionId, {
    filename,
    persist: input.persist,
    size,
  });
  const bytes = readFileSync(input.localFile);
  const put = await fetch(intent.uploadUrl, {
    body: bytes,
    method: "PUT",
  });
  if (!put.ok) {
    throw new Error(`Upload failed with HTTP ${put.status}`);
  }
  return await input.api.commitSessionUpload(sessionId, {
    autoInstall: input.autoInstall,
    chmod: input.chmod,
    contentType: input.contentType,
    customizeFilePath: input.customizeFilePath,
    filename,
    key: intent.key,
    libraryPath: input.libraryPath,
    packageName: input.packageName,
  });
}

async function listPackagesAndActivities(
  relay: Transport | null,
  adb: AdbTransport | null,
  includeSystem = true
) {
  const packages = await runShell(relay, adb, packageListCommand(includeSystem));
  assertOk(packages, "List packages failed");
  const activities = await runShell(relay, adb, launcherActivitiesCommand());
  return {
    activities: activities.ok && typeof activities.data === "string"
      ? parseLauncherActivities(activities.data)
      : [],
    packages: parsePackageList(String(packages.data ?? "")),
  };
}

function launcherAppRows(
  activities: { activity?: string; packageName: string }[],
  packages: string[]
) {
  return (activities.length > 0
    ? activities
    : packages.map((packageName) => ({ packageName, activity: undefined })))
    .map((app) => ({
      activity: app.activity,
      component: app.activity ? `${app.packageName}/${app.activity}` : app.packageName,
      packageName: app.packageName,
    }));
}

async function resolveInstalledApp(
  relay: Transport | null,
  adb: AdbTransport | null,
  query: string
) {
  const { activities, packages } = await listPackagesAndActivities(relay, adb, true);
  return resolveAppPackage({ activities, packages, query });
}

// POST /v2/input?settle over the relay/adb device-shell channel (curl on-device
// -> Tiny localhost). chunked=1&maxChars=32768 so a large settled snapshot
// reassembles via the responseChunk cursor (once Tiny chunks /input; smaller
// responses return whole). Lets server-side input-with-settle work over relay,
// where there's no direct connection.tiny HTTP endpoint.
function deviceInputSender(
  relay: Transport | null,
  adb: AdbTransport | null
): TinyInputSender {
  const token = ensureTinyToken().token;
  return async (full) =>
    await readTinyJsonFromDevice({
      adb,
      body: tinyInputBody(full),
      maxTimeSec: Math.ceil(((full.settleTimeoutMs ?? 1500) + (full.durationMs ?? 0)) / 1000) + 6,
      method: "POST",
      path: "/input?chunked=1&maxChars=32768",
      relay,
      token,
    });
}

// A relay/adb device-shell TinyReader: the settle path (beginActionWait/
// finishActionWait) talks to Tiny over the same on-device curl channel as snap,
// so type/key/back/copy/paste settle on a digest over relay instead of a blind
// sleep. chunked=1&maxChars=32768 reassembles large /waitForStable + /snapshot
// responses. eventCounterCheap=false => skip the extra /status round-trip.
function deviceShellTinyReader(relay: Transport | null, adb: AdbTransport | null): TinyReader {
  const token = ensureTinyToken().token;
  const withChunk = (p: string) => p + (p.includes("?") ? "&" : "?") + "chunked=1&maxChars=32768";
  const get = (path: string, maxTimeSec?: number) =>
    readTinyJsonFromDevice({ adb, maxTimeSec, path, relay, token });
  return {
    eventCounterCheap: false,
    status: () => get("/status"),
    snapshot: () => get(withChunk("/snapshot?compact=1&interactiveOnly=1&maxNodes=300"), 12),
    waitChange: (opts) => get(withChunk(tinyWaitForChangePath(opts))),
    waitStable: (opts) =>
      get(withChunk(tinyWaitForStablePath(opts)), Math.ceil((opts.timeoutMs ?? 1500) / 1000) + 6),
  };
}

async function settleCommandResult(
  program: Command,
  connection: Connection,
  run: () => Promise<TransportResult>,
  failurePrefix: string,
  gesture?: TinyInputOptions,
  transports?: { adb: AdbTransport | null; relay: Transport | null }
): Promise<void> {
  const waitOpts = actionWaitOptionsFromCli(program.opts());
  // Settle over the relay/adb device-shell when there's no direct Tiny endpoint.
  // Falls back to the transports stashed by getTransport so every command (not
  // just gestures that pass transports explicitly) settles over relay.
  const tx = transports ?? currentTransports;
  const reader =
    !connection.tiny && tx && (tx.relay || tx.adb)
      ? deviceShellTinyReader(tx.relay, tx.adb)
      : undefined;
  // Server-side input-with-settle is the default when settle is enabled and we
  // can reach Tiny — directly (connection.tiny) or over the relay/adb device
  // shell. The client dispatch+wait below is the fallback.
  if (gesture && waitOpts.enabled !== false) {
    const send =
      !connection.tiny && transports && (transports.relay || transports.adb)
        ? deviceInputSender(transports.relay, transports.adb)
        : undefined;
    if (connection.tiny || send) {
      const served = await tryServerSettle(
        connection,
        gesture,
        { enabled: waitOpts.enabled, postState: waitOpts.postState, timeoutMs: waitOpts.timeoutMs },
        send
      );
      if (served) {
        outputResult(program, served as SettledTransportResult, failurePrefix);
        return;
      }
    }
  }
  const beforeAction = await beginActionWait(connection, waitOpts, reader);
  const result = await run();
  outputResult(program, await settleAfterSuccess(result, beforeAction), failurePrefix);
}

/**
 * After a launch, the foreground app's accessibility tree is not capturable
 * immediately — `getWindows()` briefly returns only the System UI window, so a
 * snapshot taken right away misses the app and any ref lookup comes up empty.
 * Poll Tiny until the launched package shows up (or a timeout), so the snapshot
 * the caller takes next actually contains the app.
 */
async function waitForAppWindow(
  connection: Connection,
  packageName: string,
  timeoutMs = 6_000
): Promise<boolean> {
  if (!connection.tiny) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const snap = await getTinySnapshot(connection.tiny);
      const nodes = Array.isArray(snap.nodes)
        ? (snap.nodes as Array<Record<string, unknown>>)
        : [];
      if (nodes.some((node) => node.bundleId === packageName)) return true;
    } catch {
      // transient — retry until the deadline
    }
    await sleep(150);
  }
  return false;
}

async function tinySnapshot(connection: Connection, deviceId: string) {
  const tiny = await ensureTinyState(connection);
  const raw = await captureTinySnapshotResilient(connection, tiny);
  const snapshot = normalizeTinySnapshot({ deviceId, raw });
  saveLastSnapshot(snapshot);
  return snapshot;
}

/**
 * Fetch a Tiny snapshot, recovering once if Tiny is unreachable. Android can
 * reap the on-device instrumentation (the HTTP server) mid-session under memory
 * pressure or a stop; rather than fail the read, restart it via the ADB path
 * and retry so the session self-heals. (R7)
 */
async function captureTinySnapshotResilient(
  connection: Connection,
  tiny: TinyState
): Promise<Record<string, unknown>> {
  try {
    return await getTinySnapshot(tiny);
  } catch (err) {
    if (!connection.adb.serial) throw err;
    return await restartTinyIfDownThenSnapshot(connection, tiny, err);
  }
}

/**
 * Recover a failed snapshot. A restart is DISRUPTIVE — startTinyHelper
 * force-stops both helper generations and re-launches the instrumentation —
 * so confirm Tiny is genuinely down first (a transient fetch error must not
 * nuke a healthy, focused session). If `/status` answers, the failure was
 * transient: just retry the read. Only restart when status also fails. (R7)
 */
async function restartTinyIfDownThenSnapshot(
  connection: Connection,
  tiny: TinyState,
  originalErr: unknown
): Promise<Record<string, unknown>> {
  try {
    await getTinyStatus(tiny);
    return await getTinySnapshot(tiny);
  } catch {
    // Tiny is unreachable on both /snapshot and /status — actually down.
    if (!connection.adb.serial) throw originalErr;
    const restarted = await startTinyHelper({ serial: connection.adb.serial });
    saveConnection({ ...connection, tiny: restarted });
    return await getTinySnapshot(restarted);
  }
}

/**
 * Set the clipboard, preferring Tiny's in-process ClipboardManager (works on
 * API 31+, where `cmd clipboard set` does not) and falling back to the
 * transport otherwise.
 */
async function clipboardSetResilient(
  connection: Connection,
  relay: Transport | null,
  adb: AdbTransport | null,
  text: string
): Promise<CommandResult> {
  if (connection.tiny) {
    try {
      const r = await tinyClipboardSet(connection.tiny, text);
      if (r.ok === true) return { ok: true };
    } catch {
      // fall through to the transport
    }
  }
  return await runWithAdbFallback(
    "clipboard",
    relay,
    adb,
    (transport) => transport.clipboard("set", text),
    { clipboardAction: "set" }
  );
}

/**
 * Read the clipboard, preferring Tiny. Android restricts clipboard reads to the
 * foreground app / default IME on API 29+, so Tiny (a background instrumentation)
 * usually can't read it — surfaced as an honest failure rather than empty data.
 */
async function clipboardGetResilient(
  connection: Connection,
  relay: Transport | null,
  adb: AdbTransport | null
): Promise<CommandResult> {
  if (connection.tiny) {
    try {
      const r = await tinyClipboardGet(connection.tiny);
      if (r.ok === true && r.restricted !== true) {
        return { ok: true, data: typeof r.text === "string" ? r.text : "" };
      }
      if (r.restricted === true) {
        return {
          ok: false,
          error:
            "Clipboard read is restricted on this Android version (foreground app / default IME only).",
        };
      }
    } catch {
      // fall through to the transport
    }
  }
  return await runWithAdbFallback(
    "clipboard",
    relay,
    adb,
    (transport) => transport.clipboard("get"),
    { clipboardAction: "get" }
  );
}

const TINY_REMOTE_APK = "/data/local/tmp/handheld-tiny-snapshot-helper.apk";
// Full Tiny snapshots can stall on the Settings app; bounded actionable refs stay fast.
// Use /snapshot (not /observe) so the relay path matches local: same node shape
// AND layoutDigest (the /observe observation shape drops it). normalizeTinySnapshot
// consumes /snapshot identically over either transport. maxChars=32768 is Tiny's
// per-chunk ceiling (ResponseStore.MAX_CHARS); the relay shell carries ~64KB per
// round-trip, so responses <=32KB return in one shot (Tiny skips chunking when the
// body fits) and larger ones need only a few refetches — vs ~20 at the old 2400.
const TINY_AGENT_SNAPSHOT_PATH =
  "/snapshot?interactiveOnly=1&compact=1&maxNodes=300&chunked=1&maxChars=32768";

function parseTinyShellJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Tiny returned empty shell output");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tiny returned non-object shell output");
  }
  return parsed as Record<string, unknown>;
}

function isTinyChunkEnvelope(value: Record<string, unknown>): boolean {
  return value.chunked === true && typeof value.id === "string" && typeof value.data === "string";
}

function chunkNextOffset(value: Record<string, unknown>): number | null {
  const raw = value.nextOffset;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
}

function tinyStatusSupportsAgentShape(status: Record<string, unknown>): boolean {
  const capabilities = status.capabilities;
  return Boolean(
    capabilities &&
      typeof capabilities === "object" &&
      (capabilities as Record<string, unknown>).observe === true &&
      (capabilities as Record<string, unknown>).responseChunks === true
  );
}

function isTransientTinyRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ADB command timed out|timed out waiting for shell|Relay request timed out|closed before .* completed/i
    .test(message);
}

async function readTinyJsonFromDevice(input: {
  adb: AdbTransport | null;
  body?: string;
  maxTimeSec?: number;
  method?: string;
  path: string;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  // Only idempotent GET reads (snapshot/observe/capture) retry on transient
  // errors. A POST (e.g. /input) runs attempts=1 — never resend a mutating op
  // that may have already executed on-device (no double-fire, #5).
  const attempts =
    !input.method || input.method.toUpperCase() === "GET"
      ? (/^\/(snapshot|observe|capture)\b/.test(input.path) ? 3 : 1)
      : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const parsed = parseTinyShellJson(
        await runShellString(
          input.relay,
          input.adb,
          tinyDeviceRequestCommand(input.path, input.token, {
            body: input.body,
            maxTimeSec: input.maxTimeSec,
            method: input.method,
          }),
          `Tiny ${input.path} failed`
        )
      );
      return isTinyChunkEnvelope(parsed)
        ? await readTinyChunkedJsonFromDevice({
            adb: input.adb,
            first: parsed,
            relay: input.relay,
            token: input.token,
          })
        : parsed;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientTinyRequestError(error)) break;
      await runShell(input.relay, input.adb, tinyDeviceStartCommand(input.token)).catch(
        () => undefined
      );
      await sleep(750);
    }
  }
  throw lastError;
}

async function readTinyChunkedJsonFromDevice(input: {
  adb: AdbTransport | null;
  first: Record<string, unknown>;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const id = String(input.first.id);
  let text = String(input.first.data ?? "");
  let eof = input.first.eof === true;
  let nextOffset = chunkNextOffset(input.first);
  let reads = 0;
  while (!eof && nextOffset !== null) {
    reads += 1;
    if (reads > 128) {
      throw new Error(`Tiny chunked response ${id} did not finish`);
    }
    const chunk = parseTinyShellJson(
      await runShellString(
        input.relay,
        input.adb,
        tinyDeviceRequestCommand(`/responseChunk?id=${encodeURIComponent(id)}&offset=${nextOffset}&maxChars=32768`, input.token),
        `Tiny response chunk ${id} failed`
      )
    );
    if (chunk.ok === false) {
      throw new Error(String(chunk.message ?? "Tiny response chunk failed"));
    }
    text += String(chunk.data ?? "");
    eof = chunk.eof === true;
    nextOffset = chunkNextOffset(chunk);
  }
  return parseTinyShellJson(text);
}

async function waitForDeviceTiny(input: {
  adb: AdbTransport | null;
  relay: Transport | null;
  token: string;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      const status = await readTinyJsonFromDevice({
        adb: input.adb,
        path: "/status",
        relay: input.relay,
        token: input.token,
      });
      return status;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Tiny helper did not become ready: ${message}`);
}

// Is the Tiny helper APK already installed on the device? Lets the bootstrap
// skip the slow upload+install (and, when absent, skip a wasted start probe).
async function tinyPackageInstalled(
  relay: Transport | null,
  adb: AdbTransport | null,
): Promise<boolean> {
  try {
    const result = await runShell(relay, adb, `pm list packages ${TINY_PACKAGE}`);
    return result.ok && typeof result.data === "string" && result.data.includes(TINY_PACKAGE);
  } catch {
    return false;
  }
}

async function ensureDeviceTiny(input: {
  adb: AdbTransport | null;
  // Lazy so a controller (local adb, or an already-running Tiny) never
  // constructs a Gateway client — and so never requires an API key. The client
  // is only built on the Gateway-upload fallback path below.
  api: () => HandheldApiClient;
  connection: Connection;
  force?: boolean;
  onProgress?: (message: string) => void;
  relay: Transport | null;
}): Promise<{ token: string; tokenFile: string }> {
  const tokenState = ensureTinyToken();
  if (input.force) {
    // Force a clean reinstall: uninstall first (so the bundled APK definitely
    // replaces a running/old-signed build) and skip the "already running"
    // short-circuits below — fall straight through to upload + install + start.
    input.onProgress?.("Force reinstall: uninstalling existing Tiny...");
    await runShell(input.relay, input.adb, tinyDeviceUninstallCommand()).catch(() => undefined);
  } else {
    // 1) Already running and answering our token? Reuse — the fast path.
    try {
      const status = await readTinyJsonFromDevice({
        adb: input.adb,
        path: "/status",
        relay: input.relay,
        token: tokenState.token,
      });
      if (tinyStatusSupportsAgentShape(status)) return tokenState;
    } catch {}

    // 2) Already installed but not running? (Re)start it and wait — but only
    // probe when the APK is actually present, otherwise we burn the 15s wait
    // before falling through to install. When absent, skip straight to install.
    if (await tinyPackageInstalled(input.relay, input.adb)) {
      await runShell(input.relay, input.adb, tinyDeviceStartCommand(tokenState.token));
      try {
        const status = await waitForDeviceTiny({
          adb: input.adb,
          relay: input.relay,
          token: tokenState.token,
        });
        if (tinyStatusSupportsAgentShape(status)) return tokenState;
      } catch {}
      // Installed but still unreachable — fall through and reinstall as a last
      // resort (handles a corrupt/old-signed build).
    }
  }

  input.onProgress?.(
    "Getting Tiny installed on the device. First snapshot can take up to 30 seconds..."
  );
  await uploadSessionFile({
    api: input.api(),
    customizeFilePath: TINY_REMOTE_APK,
    deviceId: input.connection.deviceId,
    filename: basename(bundledTinyApkPath()),
    localFile: bundledTinyApkPath(),
    sessionId: input.connection.sessionId,
  });
  await runShellString(
    input.relay,
    input.adb,
    tinyDeviceInstallCommand(TINY_REMOTE_APK),
    "Tiny install failed"
  );
  input.onProgress?.("Tiny installed. Starting snapshot service...");
  await runShellString(
    input.relay,
    input.adb,
    tinyDeviceStartCommand(tokenState.token),
    "Tiny start failed"
  );
  const status = await waitForDeviceTiny({
    adb: input.adb,
    relay: input.relay,
    token: tokenState.token,
  });
  if (!tinyStatusSupportsAgentShape(status)) {
    throw new Error("Tiny helper does not support agent-shaped observations");
  }
  return tokenState;
}

async function snapshotRaw(input: {
  adb: AdbTransport | null;
  // Lazy — see ensureDeviceTiny. A local/already-running Tiny snapshot resolves
  // through ensureTinyState below without ever building a Gateway client.
  api: () => HandheldApiClient;
  connection: Connection;
  deviceId: string;
  onProgress?: (message: string) => void;
  relay: Transport | null;
}): Promise<Record<string, unknown>> {
  if (input.connection.tiny || input.connection.adb.serial) {
    let tiny: TinyState | undefined;
    try {
      tiny = await ensureTinyState(input.connection);
      return await getTinySnapshot(tiny);
    } catch (error) {
      // Recover only if Tiny is genuinely down (verified inside the helper via
      // /status), then retry — a transient fetch error must not trigger the
      // disruptive force-stop+restart that startTinyHelper performs. Falls back
      // to the device transport only if recovery also fails. (R7)
      if (input.connection.adb.serial && tiny) {
        try {
          return await restartTinyIfDownThenSnapshot(input.connection, tiny, error);
        } catch (restartError) {
          if (!input.relay && !input.adb) throw restartError;
        }
      } else if (!input.relay && !input.adb) {
        throw error;
      }
    }
  }
  const tiny = await ensureDeviceTiny(input);
  return await readTinyJsonFromDevice({
    adb: input.adb,
    path: TINY_AGENT_SNAPSHOT_PATH,
    relay: input.relay,
    token: tiny.token,
  });
}

function snapshotTextMatches(snapshot: Awaited<ReturnType<typeof tinySnapshot>>, text: string): boolean {
  const needle = text.toLowerCase();
  return snapshot.nodes.some((node) =>
    [node.label, node.value, node.identifier]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

async function waitForSnapshotCondition(input: {
  condition: string;
  connection: Connection;
  deviceId: string;
  timeoutMs: number;
  value?: string;
}) {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  const baseline = input.condition === "change"
    ? loadLastSnapshot(input.deviceId) ?? await tinySnapshot(input.connection, input.deviceId)
    : null;

  while (Date.now() <= deadline) {
    const snapshot = await tinySnapshot(input.connection, input.deviceId);
    const matched =
      input.condition === "text"
        ? snapshotTextMatches(snapshot, input.value ?? "")
        : input.condition === "ref"
          ? Boolean(input.value && pointFromSnapshotTarget(snapshot, input.value))
          : input.condition === "change"
            // Prefer the filter-independent layout digest: the baseline (cached
            // snapshot) and the current poll may have been taken with different
            // filters, and only layoutDigest is comparable across them (#1).
            // Fall back to treeDigest, then a raw node compare, for snapshots
            // predating layoutDigest.
            ? (baseline?.layoutDigest && snapshot.layoutDigest
                ? baseline.layoutDigest !== snapshot.layoutDigest
                : baseline?.treeDigest && snapshot.treeDigest
                  ? baseline.treeDigest !== snapshot.treeDigest
                  : JSON.stringify(baseline?.nodes) !== JSON.stringify(snapshot.nodes))
            : false;
    if (matched) {
      return { ok: true, snapshot, waitedMs: Date.now() - startedAt };
    }
    await sleep(200);
  }
  return {
    error: `Timed out waiting for ${input.condition}${input.value ? ` ${input.value}` : ""}`,
    ok: false,
    waitedMs: Date.now() - startedAt,
  };
}

export function registerControlCommands(program: Command): void {
  program
    .command("tap <target> [y]")
    .description("tap a snapshot target (@eN | id= | label= | text=) or `<x> <y>` coordinates")
    .option("--long", "long press")
    .option("--duration <ms>", "press duration in ms", parseIntOption)
    .addHelpText(
      "after",
      `
Target grammar:
  <target>   one of: @eN ref (from the last snap) | id=… | label=… | text=… selector
  <x> <y>    two numeric coordinates (device pixels from top-left)

Examples:
  handheld tap @e7                  # tap the ref from the last snapshot
  handheld tap 'label=Submit'       # tap by visible name (survives re-renders)
  handheld tap 540 960              # tap raw coordinates
  handheld tap @e7 --long           # long press the ref

Caveats:
  - @eN refs renumber on EVERY screen change — re-run \`handheld snap\` before
    reusing them, or prefer durable id=/label=/text= selectors.
  - Raw coordinates are brittle across layouts/resolutions; use them last.
  - The CLI settles after the tap by default (--no-settle to skip).
  See \`handheld guide selectors\` for selector matching rules.`
    )
    .action(async (target: string, y: string | undefined, opts) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        const point = tapTargetFromArgs({ deviceId, target, y });
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback(
              "tap",
              relay,
              adb,
              (transport) =>
                transport.tap({
                  x: point.x,
                  y: point.y,
                  longPress: opts.long,
                  duration: opts.duration,
                }),
              { preferAdb: shouldResolveSnapshotTarget({ target, y }) }
            ),
          "Tap failed",
          {
            type: opts.long ? "longPress" : "tap",
            x: point.x,
            y: point.y,
            ...(opts.duration !== undefined ? { durationMs: opts.duration } : {}),
          },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("click <target> [y]", { hidden: true })
    .description("alias of tap: click a snapshot index/ref/selector or `<x> <y>` coordinates")
    .addHelpText(
      "after",
      `
Alias of \`handheld tap\` (a bare numeric index like \`click 7\` is accepted as @e7).
  handheld click @e7 | click 'id=submit' | click 540 960

Caveat: @eN refs (and bare indices) renumber on every screen change — re-snap
or use an id=/label= selector. Prefer \`handheld tap\`.`
    )
    .action(async (target: string, y: string | undefined) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        const point = tapTargetFromArgs({ allowBareIndex: true, deviceId, target, y });
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback(
              "tap",
              relay,
              adb,
              (transport) => transport.tap(point),
              { preferAdb: shouldResolveSnapshotTarget({ allowBareIndex: true, target, y }) }
            ),
          "Click failed",
          { type: "tap", x: point.x, y: point.y },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("click-at <x> <y>", { hidden: true })
    .description("click at raw `<x> <y>` device-pixel coordinates")
    .addHelpText(
      "after",
      `
  handheld click-at 540 960          # tap device pixel (540, 960)

Caveat: coordinates are brittle across layouts/resolutions — prefer
\`handheld tap @eN\` / a selector when a snapshot ref exists.`
    )
    .action(async (x: string, y: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("tap", relay, adb, (transport) =>
              transport.tap({ x: Number(x), y: Number(y) })
            ),
          "Click failed",
          { type: "tap", x: Number(x), y: Number(y) },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("click-area <x1> <y1> <x2> <y2>", { hidden: true })
    .description("click the center of the `<x1> <y1> <x2> <y2>` rectangle")
    .addHelpText(
      "after",
      `
Taps the midpoint of the given rectangle (useful with a node's bounds=… attr,
shown by \`handheld snap --bounds\`).
  handheld click-area 100 200 400 260

Caveat: coordinates are brittle — prefer a snapshot ref/selector when one exists.`
    )
    .action(async (x1: string, y1: string, x2: string, y2: string) => {
      const { relay, adb, connection } = getTransport(program);
      const point = {
        x: Math.round((Number(x1) + Number(x2)) / 2),
        y: Math.round((Number(y1) + Number(y2)) / 2),
      };
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("tap", relay, adb, (transport) =>
              transport.tap(point)
            ),
          "Click area failed",
          { type: "tap", x: point.x, y: point.y },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("long-press <target> [y]")
    .alias("long_press")
    .description("long press a snapshot target (@eN | id= | label= | text=) or `<x> <y>` (--duration ms)")
    .option("--duration <ms>", "press duration in ms", parseIntOption, 1000)
    .addHelpText(
      "after",
      `
Target grammar: same as \`tap\` — @eN | id=… | label=… | text=… | <x> <y>.

Examples:
  handheld long-press @e12                 # 1000ms by default
  handheld long-press 'id=row_item' --duration 1500
  handheld long-press 540 960

Caveats:
  - @eN refs renumber on every screen change — re-snap or use a durable selector.
  - A bare numeric index (e.g. \`long-press 12\`) is treated as @e12.`
    )
    .action(async (target: string, y: string | undefined, opts) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        const point = tapTargetFromArgs({ allowBareIndex: true, deviceId, target, y });
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback(
              "tap",
              relay,
              adb,
              (transport) =>
                transport.tap({
                  ...point,
                  duration: opts.duration,
                  longPress: true,
                }),
              { preferAdb: shouldResolveSnapshotTarget({ allowBareIndex: true, target, y }) }
            ),
          "Long press failed",
          {
            type: "longPress",
            x: point.x,
            y: point.y,
            ...(opts.duration !== undefined ? { durationMs: opts.duration } : {}),
          },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("double-tap <target> [y]")
    .alias("double_tap")
    .description("double tap a snapshot target (@eN | id= | label= | text=) or `<x> <y>` (--interval ms)")
    .option("--interval <ms>", "delay between taps in ms", parseIntOption, 80)
    .addHelpText(
      "after",
      `
Target grammar: same as \`tap\` — @eN | id=… | label=… | text=… | <x> <y>.

Examples:
  handheld double-tap @e9
  handheld double-tap 'label=Map'
  handheld double-tap 540 960 --interval 120

Caveats:
  - @eN refs renumber on every screen change — re-snap or use a durable selector.
  - A bare numeric index (e.g. \`double-tap 9\`) is treated as @e9.`
    )
    .action(async (target: string, y: string | undefined, opts) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        const point = tapTargetFromArgs({ allowBareIndex: true, deviceId, target, y });
        await settleCommandResult(
          program,
          connection,
          () =>
            doubleTap({
              adb,
              intervalMs: opts.interval,
              point,
              preferAdb: shouldResolveSnapshotTarget({ allowBareIndex: true, target, y }),
              relay,
            }),
          "Double tap failed",
          { type: "doubleTap", x: point.x, y: point.y },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("swipe <x1> <y1> <x2> <y2>")
    .description("swipe from `<x1> <y1>` to `<x2> <y2>` (--duration ms)")
    .option("--duration <ms>", "swipe duration in ms", parseIntOption)
    .addHelpText(
      "after",
      `
Drags from the start to the end device-pixel coordinate.
  handheld swipe 540 1600 540 600            # swipe up (content scrolls down)
  handheld swipe 540 600 540 1600 --duration 500   # slower swipe down

Caveats:
  - Coordinates are raw device pixels; for simple list scrolling prefer
    \`handheld scroll up|down|left|right\` (it computes the gesture for you).
  - A longer --duration reads more like a finger; very short swipes can fling.`
    )
    .action(async (x1: string, y1: string, x2: string, y2: string, opts) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("swipe", relay, adb, (transport) =>
              transport.swipe({
                x1: Number(x1),
                y1: Number(y1),
                x2: Number(x2),
                y2: Number(y2),
                duration: opts.duration,
              })
            ),
          "Swipe failed",
          {
            type: "swipe",
            x1: Number(x1),
            y1: Number(y1),
            x2: Number(x2),
            y2: Number(y2),
            ...(opts.duration !== undefined ? { durationMs: opts.duration } : {}),
          },
          { adb, relay }
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("type [targetOrText] [text...]")
    .description("type into the focused field (replaces); pass a target to focus first (--append, --submit)")
    .option("--target <ref>", "snapshot ref/index to focus before typing")
    .option("--x <x>", "x coordinate to focus before typing", Number)
    .option("--y <y>", "y coordinate to focus before typing", Number)
    .option("--append", "append without clearing when a target is provided")
    .option("--clear", "clear before typing (default when target/x/y is provided)")
    .option("--submit", "press enter after typing")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld type "text"                 # type into the currently focused field
  handheld type <target> "text"        # focus <target> first, then type
  <target> = @eN | id=… | label=… | text=…  (or - / "focused" for the focused field)

Examples:
  handheld type "hello world"               # replaces the focused field
  handheld type 'label=Notes' "meeting"     # focus the field, then replace
  handheld type @e5 "more" --append         # append instead of replacing
  handheld type 'id=search' "wifi" --submit # type then press enter

Caveats:
  - Default REPLACES the field's contents (deterministic via the Tiny helper);
    --append adds to the existing text instead.
  - With no target and nothing focused, this fails ("No input field is focused")
    rather than typing into the wrong screen — tap a field first or pass a target.
  - @eN refs renumber on every screen change — re-snap or use an id=/label= selector.
  - --x/--y focus by coordinate and must be given together. See \`handheld guide selectors\`.`
    )
    .action(async (targetOrText: string | undefined, textParts: string[], opts) => {
      const targetFromPosition =
        targetOrText &&
        textParts.length > 0 &&
        (isSnapshotTarget(targetOrText) || isFocusedTarget(targetOrText))
          ? targetOrText
          : undefined;
      const target = opts.target ?? targetFromPosition;
      const text = targetFromPosition
        ? textParts.join(" ")
        : [targetOrText, ...textParts].filter(Boolean).join(" ");
      if (!text) {
        console.error("No text to type.");
        console.error(
          'Hint: pass the text, e.g. `handheld type "hello"` (focused field) or `handheld type label=Notes "hello"` (focus a target first).'
        );
        process.exit(1);
      }
      const hasCoordinateFocus =
        Number.isFinite(opts.x) || Number.isFinite(opts.y);
      if (hasCoordinateFocus && (!Number.isFinite(opts.x) || !Number.isFinite(opts.y))) {
        console.error("Coordinate focus needs both --x and --y.");
        console.error(
          'Hint: pass both (e.g. `--x 540 --y 960`), or focus by ref/selector instead: `handheld type @e5 "text"`.'
        );
        process.exit(1);
      }
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          async () => {
            if (hasCoordinateFocus) {
              assertOk(
                await runWithAdbFallback("tap", relay, adb, (transport) =>
                  transport.tap({ x: opts.x, y: opts.y })
                ),
                "Focus target failed"
              );
              await sleep(150);
            }
            return await focusClearAndType({
              adb,
              append: opts.append,
              // Default to replacing the field (deterministic via Tiny
              // setText); --append opts into key-injection append.
              clear: opts.append ? false : true,
              deviceId,
              relay,
              submit: opts.submit,
              target,
              text,
              tiny: connection.tiny,
            });
          },
          "Type failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("fill <target> <text...>", { hidden: true })
    .description("focus a target (@eN | id= | label= | text=), clear it, and type (--append, --submit)")
    .option("--append", "append without clearing existing text")
    .option("--submit", "press enter after typing")
    .addHelpText(
      "after",
      `
Always focuses <target> first (unlike \`type\`, which defaults to the focused field).
  handheld fill @e5 "hello world"
  handheld fill 'label=Email' "me@example.com" --submit
  handheld fill 'id=notes' "more text" --append

Caveats:
  - Replaces the field by default; --append keeps existing text.
  - @eN refs renumber on every screen change — re-snap or use an id=/label= selector.
  Prefer \`handheld type <target> "text"\`, which this command mirrors.`
    )
    .action(async (target: string, textParts: string[], opts) => {
      const text = textParts.join(" ");
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            focusClearAndType({
              adb,
              append: opts.append,
              clear: true,
              deviceId,
              relay,
              submit: opts.submit,
              target,
              text,
              tiny: connection.tiny,
            }),
          "Fill failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("clear [target]", { hidden: true })
    .description("clear the focused field, or focus a target (@eN | id= | label=) and clear it")
    .option("--repeat <count>", "delete key repeat count", parseIntOption, 80)
    .addHelpText(
      "after",
      `
  handheld clear                 # clear the currently focused field
  handheld clear @e5             # focus the ref, then clear
  handheld clear 'id=search' --repeat 120

Caveats:
  - With no target and nothing focused, this fails honestly ("No input field is
    focused") rather than reporting a vacuous success — tap a field or pass a target.
  - @eN refs renumber on every screen change — re-snap or use a durable selector.
  - --repeat is the number of delete presses; raise it for very long fields.`
    )
    .action(async (target: string | undefined, opts) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          async () => {
            if (isFocusedTarget(target)) {
              // No explicit target: clearing the "focused" field is a no-op
              // (and a dishonest ok:true) when nothing is focused. Mirror the
              // type/paste guard and fail honestly. (R3)
              if (!(await hasFocusedEditableField(connection.tiny))) {
                return {
                  ok: false,
                  error: "No input field is focused — tap a field first or pass a target ref.",
                };
              }
            } else {
              const point = tapTargetFromArgs({
                allowBareIndex: true,
                deviceId,
                target: target!,
              });
              assertOk(
                await runWithAdbFallback(
                  "tap",
                  relay,
                  adb,
                  (transport) => transport.tap(point),
                  { preferAdb: isSnapshotTarget(target!) }
                ),
                "Focus target failed"
              );
              await sleep(150);
            }
            return await runShell(relay, adb, clearFocusedInputCommand(opts.repeat));
          },
          "Clear failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("key <key>", { hidden: true })
    .description("press a key by name (back, home, enter, paste, …) or numeric Android keycode")
    .addHelpText(
      "after",
      `
Accepts an alias (back, home, recent/recents, enter, escape, tab, search, paste,
backspace/del, delete, arrow_up/down/left/right, volume_up/down, power, menu,
app_switch), a raw KeyEvent name (e.g. VOLUME_MUTE), or a numeric keycode.
  handheld key enter | key back | key 4 | key volume_up

Caveat: un-aliased symbolic names are uppercased before dispatch (Android's
keyCodeFromString is case-sensitive). Prefer \`handheld press-key\` (same behavior,
visible in --help) or the \`back\`/\`home\`/\`recent\` shortcuts.`
    )
    .action(async (key: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const beforeAction = await beginActionWait(
          connection,
          actionWaitOptionsFromCli(program.opts())
        );
        const result = await runWithAdbFallback("key", relay, adb, (transport) =>
          transport.key(normalizeKeyInput(key))
        );
        outputResult(
          program,
          await settleAfterSuccess(result, beforeAction),
          "Key failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("system-button <button>", { hidden: true })
    .description("press a system button: back | home | recent | enter")
    .addHelpText(
      "after",
      `
  handheld system-button back | system-button home | system-button recent

Caveat: thin wrapper over the key path. Prefer the dedicated shortcuts
\`handheld back\` / \`home\` / \`recent\`, which are visible in \`handheld --help\`.`
    )
    .action(async (button: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("key", relay, adb, (transport) =>
              transport.key(normalizeKeyInput(button))
            ),
          "System button failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("keycode <keycode>", { hidden: true })
    .description("press a raw numeric Android keycode (KeyEvent.KEYCODE_*)")
    .addHelpText(
      "after",
      `
  handheld keycode 4      # KEYCODE_BACK
  handheld keycode 66     # KEYCODE_ENTER
  handheld keycode 187    # KEYCODE_APP_SWITCH (recent apps)

Caveat: takes a number only — for names use \`handheld press-key <name>\`.`
    )
    .action(async (keycode: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("key", relay, adb, (transport) =>
              transport.key(Number(keycode))
            ),
          "Keycode failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("press-key <key>")
    .alias("press_key")
    .description("press a key by name (back, home, enter, paste, …) or numeric Android keycode")
    .addHelpText(
      "after",
      `
Accepts an alias (back, home, recent/recents, enter, escape, tab, search, paste,
backspace/del, delete, arrow_up/down/left/right, volume_up/down, power, menu,
app_switch), a raw KeyEvent name (e.g. VOLUME_MUTE), or a numeric keycode.
  handheld press-key enter | press-key back | press-key 4 | press-key volume_up

Caveat: un-aliased symbolic names are uppercased before dispatch (Android's
keyCodeFromString is case-sensitive). For Enter after typing, prefer
\`handheld type … --submit\`; for navigation use \`back\` / \`home\` / \`recent\`.`
    )
    .action(async (key: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("key", relay, adb, (transport) =>
              transport.key(normalizeKeyInput(key))
            ),
          "Press key failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  // Navigation shortcuts. `recent`/`recents`/`menu` all open the Android app
  // switcher; `back`/`home` press the system back/home buttons. Each gets a short
  // help block noting that the switcher view animates and may never settle, so a
  // snapshot taken right after can be transient (re-snap or use `open-app`). (#3)
  const navHelp: Record<string, string> = {
    back: `
Presses the system Back button (KEYCODE_BACK).
  handheld back

Caveat: re-run \`handheld snap\` afterward — the screen changed, so cached @eN
refs no longer apply.`,
    home: `
Presses the system Home button — returns to the launcher.
  handheld home

Caveat: re-snap after navigating; refs from the previous screen are now stale.`,
    recent: `
Opens the recent-apps switcher (KEYCODE_APP_SWITCH).
  handheld recent

Caveat: the switcher animates and may never settle, so a snapshot taken right
after can be empty/transient. To switch apps reliably use \`handheld open-app <pkg>\`.`,
    recents: `
Alias of \`handheld recent\` — opens the recent-apps switcher.
  handheld recents

Caveat: the switcher animates and may never settle; prefer \`handheld open-app\`
to switch apps reliably, then re-snap.`,
    menu: `
Opens the recent-apps switcher (Android app switcher), not a contextual menu.
  handheld menu

Caveat: the switcher animates and may never settle; prefer \`handheld open-app\`
to switch apps reliably, then re-snap.`,
  };
  for (const [name, key] of [
    ["back", "back"],
    ["home", "home"],
    ["recent", "recent"],
    ["recents", "recent"],
    ["menu", "recent"],
  ] as const) {
    program
      .command(name)
      .description(name === "menu" ? "open recent apps (Android app switcher)" : `press ${key}`)
      .addHelpText("after", navHelp[name]!)
      .action(async () => {
        const { relay, adb, connection } = getTransport(program);
        try {
          await settleCommandResult(
            program,
            connection,
            () =>
              runWithAdbFallback("key", relay, adb, (transport) =>
                transport.key(normalizeKeyInput(key))
              ),
            `${name} failed`
          );
        } finally {
          await disconnectRelay(relay);
        }
      });
  }

  // Capture a screenshot. JPEG via Tiny (~5-10x smaller than PNG -> faster, esp.
  // over relay) is the default; if Tiny isn't reachable, fall back to the PNG
  // runtime/screencap path so a capture still succeeds. format "png" forces PNG.
  async function captureScreenshot(
    ctx: { adb: AdbTransport | null; connection: Connection; relay: Transport | null },
    shotOpts: { format?: string; quality?: number }
  ): Promise<
    | { base64: string; buffer: Buffer; ext: "jpg" | "png"; mimeType: string; ok: true }
    | { error: string; ok: false }
  > {
    const { adb, connection, relay } = ctx;
    const wantsJpeg = !shotOpts.format || /^jpe?g$/i.test(String(shotOpts.format));
    const quality = shotOpts.quality ?? 80;
    if (wantsJpeg) {
      try {
        let res: Record<string, unknown> | undefined;
        if (connection.tiny) {
          res = await tinyScreenshot(connection.tiny, { format: "jpg", quality });
        } else if (relay || adb) {
          const token = ensureTinyToken().token;
          res = await readTinyJsonFromDevice({
            adb,
            maxTimeSec: 20,
            path: `/screenshot?format=jpg&quality=${quality}&chunked=1&maxChars=32768`,
            relay,
            token,
          });
        }
        if (res && typeof res.data === "string") {
          return {
            base64: res.data,
            buffer: Buffer.from(res.data, "base64"),
            ext: "jpg",
            mimeType: "image/jpeg",
            ok: true,
          };
        }
      } catch {
        // Tiny unavailable -> fall through to the PNG runtime/screencap path.
      }
    }
    const result = await runWithAdbFallback("screenshot", relay, adb, (transport) =>
      transport.screenshot()
    );
    if (!result.ok || !result.buffer) {
      return {
        error: "error" in result && result.error ? String(result.error) : "Screenshot failed",
        ok: false,
      };
    }
    return {
      base64: result.base64 ?? result.buffer.toString("base64"),
      buffer: result.buffer,
      ext: "png",
      mimeType: "image/png",
      ok: true,
    };
  }

  program
    .command("screenshot")
    .description("capture a screenshot [--output <file>] [--base64] [--format jpg|png] [--quality 1-100]")
    .option("--output <file>", "save to file")
    .option("--base64", "output raw base64 to stdout")
    .option("--format <fmt>", "image format: jpg (default) or png", "jpg")
    .option("--quality <n>", "jpeg quality 1-100", parseIntOption, 80)
    .addHelpText(
      "after",
      `
JPEG via the Tiny helper (~5-10x smaller than PNG, faster over relay) is the
default; falls back to PNG screencap if Tiny is unreachable. With no flags the
image is written to ./handheld-screenshot-<ts>.<ext> and the path is printed.

Examples:
  handheld screenshot                          # save JPEG to a timestamped file
  handheld screenshot --output shot.png --format png
  handheld screenshot --base64 > shot.b64      # raw base64 to stdout

Caveats:
  - Pixels, not structure — for tappable targets/refs use \`handheld snap\`
    (or \`handheld snap --screenshot\` to get both at once).
  - --base64 and \`--json\` both emit base64 to stdout (no file written).`
    )
    .action(async (opts) => {
      const ctx = getTransport(program);
      try {
        const shot = await captureScreenshot(ctx, {
          format: opts.format,
          quality: opts.quality,
        });
        if (!shot.ok) {
          outputResult(program, { error: shot.error, ok: false }, "Screenshot failed");
          return;
        }
        const { base64, buffer, ext } = shot;
        if (opts.output) {
          writeFileSync(opts.output, buffer);
          if (!program.opts().json) console.log(`Saved to ${opts.output}`);
        } else if (opts.base64 || program.opts().json) {
          if (program.opts().json) {
            console.log(JSON.stringify({ base64, ok: true }));
          } else {
            process.stdout.write(base64);
          }
        } else {
          const name = `handheld-screenshot-${Date.now()}.${ext}`;
          writeFileSync(name, buffer);
          console.log(`Saved to ${name}`);
        }
      } finally {
        await disconnectRelay(ctx.relay);
      }
    });

  program
    .command("snap")
    .description("print the actionable snapshot tree [-i] [--all] [--offscreen] [--bounds] [--raw|--json] [--screenshot]")
    .option("-i, --interactive", "show only actionable refs")
    .option("--all", "include structural containers + off-screen nodes (full tree)")
    .option("--offscreen", "include off-screen nodes (skip viewport culling)")
    .option("--bounds", "include node bounds")
    .option("--no-header", "omit snapshot header")
    .option("--raw", "print raw Tiny snapshot JSON")
    .option("--screenshot", "include a screenshot with the snapshot")
    .option("--screenshot-base64", "include screenshot base64 in non-JSON output")
    .option("--screenshot-output <file>", "save screenshot to file")
    .addHelpText(
      "after",
      `
The core observe step: prints each on-screen node as
  - @eN Role "title" subtitle="…" = "value" [id=… focused actions=[press,…]]
and caches the snapshot so tap/type/… can resolve @eN / id= / label= / text=
targets against it. Read \`handheld guide format\` for the full line grammar.

Views:
  handheld snap              # default: compact, collapsed, on-screen tree
  handheld snap -i           # only actionable refs (no read-only text)
  handheld snap --all        # full uncollapsed tree incl. off-screen + keyboard keys
  handheld snap --offscreen  # keep below-the-fold nodes (still collapsed)
  handheld snap --raw        # raw Tiny snapshot JSON (every field, never culled)
  handheld snap --json       # structured node list (--json is a global flag)
  handheld snap --screenshot # also capture a JPEG alongside the tree

Caveats:
  - The default view drops off-screen nodes; a "[N more below — scroll: …]" line
    means there is more content — \`handheld scroll down\` then re-snap.
  - A soft keyboard collapses to one "[keyboard open · … ]" line — enter text with
    \`handheld type\`, don't tap keys (pass --all to expand them).
  - Every screen change RENUMBERS @eN refs, so re-snap before reusing them; for
    durable handles use id=/label=/text= selectors (\`handheld guide selectors\`).`
    )
    .action(async (opts) => {
      const { connection, deviceId, relay, adb } = getTransport(program);
      try {
        const raw = await snapshotRaw({
          adb,
          api: () => new HandheldApiClient(),
          connection,
          deviceId,
          onProgress: program.opts().json || program.opts().quiet
            ? undefined
            : (message: string) => console.error(message),
          relay,
        });
        const snapshot = normalizeTinySnapshot({ deviceId, raw });
        // Current Tiny folds the foreground activity into the snapshot itself
        // (on-device, no round-trip). Only fall back to a host dumpsys for an
        // older Tiny that didn't provide it.
        if (!snapshot.activity) await attachForegroundComponent(snapshot, relay, adb);
        saveLastSnapshot(snapshot);
        const wantsScreenshot =
          opts.screenshot || opts.screenshotBase64 || opts.screenshotOutput;
        const screenshot = wantsScreenshot
          ? await captureScreenshot({ adb, connection, relay }, { format: "jpg" })
          : null;

        if (opts.raw) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        if (program.opts().json) {
          const nodes = snapshotNodesForDisplay(snapshot, {
            all: opts.all,
            interactive: opts.interactive,
            offscreen: opts.offscreen,
          });
          console.log(JSON.stringify({
            ...snapshot,
            nodes,
            raw: undefined,
            screenshot: screenshot?.ok
              ? {
                  base64: screenshot.base64,
                  mimeType: screenshot.mimeType,
              }
            : screenshot
              ? {
                  error: screenshot.error,
                  ok: false,
                }
              : undefined,
            totalNodeCount: snapshot.nodes.length,
          }));
          return;
        }
        console.log(formatSnapshot(snapshot, {
          all: opts.all,
          bounds: opts.bounds,
          header: opts.header,
          interactive: opts.interactive,
          offscreen: opts.offscreen,
        }));
        if (screenshot) {
          if (!screenshot.ok) {
            console.error("Screenshot failed:", screenshot.error);
            process.exitCode = 1;
            return;
          }
          if (opts.screenshotBase64) {
            console.log(`Screenshot base64: ${screenshot.base64}`);
          } else {
            const name =
              opts.screenshotOutput ?? `handheld-screenshot-${Date.now()}.${screenshot.ext}`;
            writeFileSync(name, screenshot.buffer);
            console.log(`Screenshot: ${name}`);
          }
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("shell <command>")
    .description("run a shell command on the device (quote the whole command)")
    .addHelpText(
      "after",
      `
Runs the command on the device and prints stdout.
  handheld shell 'getprop ro.product.model'
  handheld shell 'dumpsys battery'
  handheld shell 'pm list packages -3'

Caveats:
  - Quote the whole command so your local shell doesn't split/expand it.
  - Runs over the relay/ADB device shell; some commands need root or are blocked
    on cloud devices. A non-zero device exit surfaces as a failure.`
    )
    .action(async (command: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const beforeAction = await beginActionWait(
          connection,
          actionWaitOptionsFromCli(program.opts())
        );
        const result = await runWithAdbFallback("shell", relay, adb, (transport) =>
          transport.shell(command)
        );
        const settled = await settleAfterSuccess(result, beforeAction);
        if (program.opts().json) {
          console.log(JSON.stringify(settled));
          if (!settled.ok) process.exitCode = 1;
        } else if (settled.ok) {
          if (typeof settled.data === "string") {
            console.log(settled.data);
          } else if (settled.data !== undefined) {
            console.log(JSON.stringify(settled.data, null, 2));
          }
        } else {
          console.error("Shell failed:", settled.error);
          console.error(
            "Hint: quote the whole command; some commands need root or are blocked on cloud devices. Check connectivity with `handheld shell 'echo ok'`."
          );
          process.exit(1);
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("wait [seconds]", { hidden: true })
    .description("sleep for [seconds] (default 1) — a blind delay")
    .addHelpText(
      "after",
      `
  handheld wait        # sleep 1 second
  handheld wait 2.5    # sleep 2.5 seconds

Caveat: a blind sleep. Prefer condition-based waits — \`handheld wait-for stable\`
(UI quiet), \`wait-for text|ref <value>\`, or \`wait-for change\` — which return as
soon as the condition holds. Actions already settle by default.`
    )
    .action(async (seconds = "1") => {
      const ms = Math.max(0, Number(seconds) * 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (program.opts().json) console.log(JSON.stringify({ ok: true, waitedMs: ms }));
    });

  program
    .command("wait-for <condition> [value]", { hidden: true })
    .description("wait for a UI condition: stable | text <s> | ref <@eN|id=…> | change (--timeout ms)")
    .option("--timeout <ms>", "wait timeout in ms", parseIntOption, 5000)
    .addHelpText(
      "after",
      `
Conditions:
  stable          the UI goes quiet (no layout changes)
  text <value>    a node's label/value contains <value> (case-insensitive)
  ref <target>    a target resolves — @eN | id=… | label=… | text=…
  change          the screen differs from the last cached snapshot

Examples:
  handheld wait-for stable
  handheld wait-for text "Logged in" --timeout 8000
  handheld wait-for ref 'id=home_tab'

Caveats:
  - Polls by re-snapshotting until the condition holds or --timeout elapses; a
    timeout exits non-zero.
  - \`change\` compares against the LAST snapshot — take one (\`handheld snap\`)
    before the action you want to detect.`
    )
    .action(async (condition: string, value: string | undefined, opts) => {
      const { connection, deviceId } = getTransport(program);
      const normalized = condition.toLowerCase();
      if (!["stable", "text", "ref", "change"].includes(normalized)) {
        console.error(`Unknown wait-for condition "${condition}".`);
        console.error("Hint: use one of: stable | text <value> | ref <target> | change.");
        process.exit(1);
      }
      if ((normalized === "text" || normalized === "ref") && !value) {
        console.error(`\`handheld wait-for ${normalized}\` needs a value.`);
        console.error(
          normalized === "text"
            ? 'Hint: pass the text to wait for, e.g. `handheld wait-for text "Logged in"`.'
            : "Hint: pass a target to wait for, e.g. `handheld wait-for ref id=home_tab`."
        );
        process.exit(1);
      }
      const timeoutMs = Math.max(0, Number(opts.timeout));
      const startedAt = Date.now();
      if (normalized === "stable") {
        const tiny = await ensureTinyState(connection);
        const result = await waitTinyStable(tiny, { timeoutMs });
        // Honor Tiny's own verdict: `stable:false` means it sampled until the
        // device timeout without the UI ever going quiet. Reporting ok:true
        // there would mask a real timeout (mirrors the text/ref/change branch).
        const ok = result.stable !== false;
        const payload = { ok, result, waitedMs: Date.now() - startedAt };
        if (program.opts().json) {
          console.log(JSON.stringify(payload));
        } else if (!ok) {
          console.error(`Timed out waiting for stable UI`);
        }
        if (!ok) process.exitCode = 1;
        return;
      }
      const result = await waitForSnapshotCondition({
        condition: normalized,
        connection,
        deviceId,
        timeoutMs,
        value,
      });
      if (program.opts().json) {
        console.log(JSON.stringify(result));
      } else if (!result.ok) {
        console.error(result.error);
      }
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("scroll <direction>", { hidden: true })
    .description("scroll the screen: up | down | left | right (--duration ms)")
    .option("--duration <ms>", "swipe duration in ms", parseIntOption, 300)
    .addHelpText(
      "after",
      `
Computes a swipe across the screen center from the device size, so you don't
have to. Direction is the CONTENT direction (what you want to bring into view):
\`scroll down\` reveals content below; \`scroll up\` reveals content above.
  handheld scroll down       # reveal content further down the page
  handheld scroll down --duration 500

Caveats:
  - The default snap drops off-screen nodes; when you see "[N more below …]",
    \`scroll down\` then re-snap to bring them on-screen.
  - For a precise gesture (e.g. a small in-list drag) use \`handheld swipe\`.`
    )
    .action(async (direction: string, opts) => {
      if (!["up", "down", "left", "right"].includes(direction)) {
        console.error(`Unknown scroll direction "${direction}".`);
        console.error("Hint: use one of: up | down | left | right.");
        process.exit(1);
      }
      const { relay, adb, connection } = getTransport(program);
      try {
        const sizeResult = await runShell(relay, adb, screenSizeCommand());
        assertOk(sizeResult, "Screen size failed");
        const size = parseScreenSize(String(sizeResult.data ?? ""));
        if (!size) throw new Error("Could not read screen size");
        const swipe = scrollSwipe({
          direction: direction as "down" | "left" | "right" | "up",
          ...size,
        });
        await settleCommandResult(
          program,
          connection,
          () =>
            runWithAdbFallback("swipe", relay, adb, (transport) =>
              transport.swipe({ ...swipe, duration: opts.duration })
            ),
          "Scroll failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("list-apps")
    .alias("list_apps")
    .description("list launchable app packages [--system for every installed package]")
    .option("--system", "include all packages, not just launchable apps")
    .addHelpText(
      "after",
      `
Prints one package id per line — the exact value \`handheld open-app <package>\`
expects.
  handheld list-apps                  # launchable apps only
  handheld list-apps --system         # every installed package (incl. system)
  handheld list-apps --json           # JSON array (--json is a global flag)

Caveat: --system is a long list; filter with \`grep\` (e.g. \`handheld list-apps
--system | grep chrome\`).`
    )
    .action(async (opts) => {
      const { relay, adb } = getTransport(program);
      try {
        const { activities, packages } = await listPackagesAndActivities(
          relay,
          adb,
          Boolean(opts.system)
        );
        // Emit package ids (what `adb`/`pm list packages` returns) so the same
        // value feeds straight into `open-app <package>`. Non-system lists the
        // launchable packages; --system lists every installed package.
        const rows = opts.system
          ? packages
          : [
              ...new Set(launcherAppRows(activities, packages).map((app) => app.packageName)),
            ].sort();
        if (program.opts().json) {
          console.log(JSON.stringify({ ok: true, apps: rows }));
        } else {
          console.log(rows.join("\n"));
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("open-app <nameOrPackage>")
    .alias("open_app")
    .description("open an app by package id, built-in alias (chrome, settings, …), or package-like name")
    .addHelpText(
      "after",
      `
Resolves <nameOrPackage> against the installed apps, then launches it and waits
for its window so the next \`snap\` sees the app (not just System UI).
  handheld open-app com.android.chrome
  handheld open-app chrome             # built-in alias
  handheld open-app settings

Aliases: chrome, settings, gmail, maps, play/"play store", youtube, files.

Caveats:
  - Use \`handheld list-apps\` to find the exact package id when unsure.
  - This is the reliable way to switch apps — more so than \`recent\`, whose
    switcher animates and may not settle. Re-snap after the app opens.`
    )
    .action(async (nameOrPackage: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const app = await resolveInstalledApp(relay, adb, nameOrPackage);
        if (!app) {
          console.error(`App not found: ${nameOrPackage}`);
          console.error(
            "Hint: pass an installed package id (see `handheld list-apps`) or a built-in alias (chrome, settings, gmail, maps, play, youtube, files)."
          );
          process.exit(1);
        }
        await settleCommandResult(
          program,
          connection,
          async () => {
            const result = await runShell(relay, adb, startAppCommand(app));
            // Wait for the launched app's window to be capturable so the next
            // snapshot/ref lookup sees the app, not just System UI.
            if (result.ok) await waitForAppWindow(connection, app.packageName);
            return result;
          },
          "Open app failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("launch [target]")
    .description("launch a deep link / intent / component [--action] [--data <uri>] [--component] [--package]")
    .option("--action <action>", "intent action", "android.intent.action.VIEW")
    .option("--data <uri>", "intent data/deep link URI")
    .option("--component <component>", "component name, such as com.example/.MainActivity")
    .option("--package <packageName>", "limit intent resolution to a package")
    .addHelpText(
      "after",
      `
A bare [target] is taken as the intent data URI (deep link); --action defaults to
VIEW. Or target a component/package explicitly.
  handheld launch https://example.com           # open a URL (VIEW)
  handheld launch myapp://path/to/screen        # custom-scheme deep link
  handheld launch --component com.example/.MainActivity
  handheld launch --data 'geo:37.7,-122.4' --package com.google.android.apps.maps

Caveats:
  - \`am start\` exits 0 even when nothing resolves; this command parses the output
    so an unresolved intent reports a failure instead of a false success.
  - To just open an installed app by name, \`handheld open-app <pkg>\` is simpler.
  - Re-snap after launch; the screen (and refs) changed.`
    )
    .action(async (target: string | undefined, opts) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const command = launchTargetCommand({
          action: opts.action,
          component: opts.component,
          data: opts.data,
          packageName: opts.package,
          target,
        });
        await settleCommandResult(
          program,
          connection,
          async () => {
            const result = await runShell(relay, adb, command);
            // `am start` exits 0 even when the activity does not exist or the
            // intent can't be resolved — parse its output so a failed launch
            // reports ok:false instead of a dishonest success.
            if (result.ok && typeof result.data === "string") {
              const failure = amStartError(result.data);
              if (failure) return { ok: false, error: failure, data: result.data };
            }
            return result;
          },
          "Launch failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("current-app", { hidden: true })
    .description("print the foreground component (package/activity)")
    .addHelpText(
      "after",
      `
  handheld current-app          # prints e.g. com.android.settings/.Settings
  handheld current-app --json   # { packageName, activity, component, … }

Note: \`handheld snap\` already shows the foreground app/activity in its header,
so a separate call is rarely needed.`
    )
    .action(async () => {
      const { relay, adb } = getTransport(program);
      try {
        const result = await runShell(relay, adb, currentAppCommand());
        const current = result.ok && typeof result.data === "string"
          ? parseCurrentComponent(result.data)
          : null;
        if (program.opts().json) {
          console.log(JSON.stringify({
            ok: result.ok,
            packageName: current?.packageName ?? null,
            activity: current?.activity ?? null,
            component: current?.component ?? null,
            raw: result.data,
          }));
        } else if (current) {
          console.log(current.component ?? current.packageName ?? String(result.data));
        } else {
          outputResult(program, result, "Current app failed");
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("stop-app <nameOrPackage>", { hidden: true })
    .description("force-stop an app by package id, built-in alias, or package-like name")
    .addHelpText(
      "after",
      `
  handheld stop-app com.android.chrome
  handheld stop-app chrome          # built-in alias

Caveat: force-stops the process (like Settings > Force stop). Re-snap afterward;
the foreground app likely changed.`
    )
    .action(async (nameOrPackage: string) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const app = await resolveInstalledApp(relay, adb, nameOrPackage);
        if (!app) {
          console.error(`App not found: ${nameOrPackage}`);
          console.error(
            "Hint: pass an installed package id (see `handheld list-apps`) or a built-in alias (chrome, settings, gmail, maps, play, youtube, files)."
          );
          process.exit(1);
        }
        await settleCommandResult(
          program,
          connection,
          () => runShell(relay, adb, stopAppCommand(app.packageName)),
          "Stop app failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("gps <latitude> <longitude>", { hidden: true })
    .description("set the device's mock GPS location to `<latitude> <longitude>`")
    .addHelpText(
      "after",
      `
  handheld gps 37.7749 -122.4194        # San Francisco

Caveats:
  - Decimal degrees; latitude then longitude (note: lat first, unlike "lng,lat").
  - Requires a transport that supports mock location (cloud relay); not all
    devices honor it.`
    )
    .action(async (lat: string, lon: string) => {
      const { relay, adb } = getTransport(program);
      try {
        const transport = pickTransport("gps", relay, adb);
        const result = await transport.gps(Number(lat), Number(lon));
        outputResult(program, result, "GPS failed");
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("clipboard <action> [text]", { hidden: true })
    .description("get or set the device clipboard: `clipboard get` | `clipboard set <text>`")
    .addHelpText(
      "after",
      `
  handheld clipboard set "hello world"
  handheld clipboard get

Caveats:
  - \`set\` uses the Tiny helper's ClipboardManager (works on API 31+, where
    \`cmd clipboard set\` does not). \`copy\` is the friendlier alias for set.
  - \`get\` is restricted on API 29+ (foreground app / default IME only) and
    usually fails with a clear message rather than returning stale data.`
    )
    .action(async (action: string, text?: string) => {
      if (action !== "get" && action !== "set") {
        console.error(`Unknown clipboard action "${action}".`);
        console.error('Hint: use `handheld clipboard get` or `handheld clipboard set "<text>"`.');
        process.exit(1);
      }
      const { relay, adb, connection } = getTransport(program);
      try {
        const result =
          action === "set"
            ? await clipboardSetResilient(connection, relay, adb, text ?? "")
            : await clipboardGetResilient(connection, relay, adb);
        if (program.opts().json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok && action === "get") {
          console.log(result.data ?? "(empty)");
        } else if (!result.ok) {
          outputResult(program, result, "Clipboard failed");
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("copy <text...>")
    .description("copy text to the device clipboard (then `paste` into a field)")
    .addHelpText(
      "after",
      `
  handheld copy "hello world"          # set the device clipboard
  handheld copy multi word text        # unquoted words are joined with spaces

Caveats:
  - Sets the clipboard via the Tiny helper (works on API 31+). Pair with
    \`handheld paste\` to insert it into a focused field.
  - To put text directly into a field, \`handheld type "…"\` is usually simpler.`
    )
    .action(async (textParts: string[]) => {
      const text = textParts.join(" ");
      const { relay, adb, connection } = getTransport(program);
      try {
        outputResult(
          program,
          await clipboardSetResilient(connection, relay, adb, text),
          "Copy failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("paste [target]")
    .description("paste the clipboard into the focused field, or focus a target (@eN | id= | label=) first")
    .addHelpText(
      "after",
      `
  handheld paste                 # paste into the currently focused field
  handheld paste @e5             # focus the ref, then paste
  handheld paste 'id=search'

Caveats:
  - With no target and nothing focused, this fails ("No input field is focused")
    instead of pasting into the wrong screen — tap a field or pass a target.
  - Pastes the DEVICE clipboard (set it with \`handheld copy\`), not your host's.
  - @eN refs renumber on every screen change — re-snap or use a durable selector.`
    )
    .action(async (target: string | undefined) => {
      const { relay, adb, connection, deviceId } = getTransport(program);
      try {
        await settleCommandResult(
          program,
          connection,
          async () => {
            if (!target && !(await hasFocusedEditableField(connection.tiny))) {
              return {
                ok: false,
                error: "No input field is focused — tap a field first or pass a target ref.",
              };
            }
            await focusTarget({ adb, deviceId, relay, target });
            return await pasteClipboardText({ adb, relay });
          },
          "Paste failed"
        );
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("pull <remote> [local]", { hidden: true })
    .description("pull a file from the device to the host (ADB transport only)")
    .addHelpText(
      "after",
      `
  handheld pull /sdcard/Download/log.txt
  handheld pull /sdcard/screenshot.png ./shot.png   # [local] defaults to .

Caveat: ADB-only — not available on relay-only (cloud) connections. Connect with
\`handheld connect --local\` for a device that supports it.`
    )
    .action(async (remote: string, local?: string) => {
      const { adb } = getTransport(program);
      if (!adb) {
        console.error("Pull requires an ADB transport, which this connection doesn't have.");
        console.error(
          "Hint: reconnect a local device with `handheld connect --local` (relay-only cloud connections can't pull files)."
        );
        process.exit(1);
      }
      const result = await adb.pull(remote, local ?? ".");
      if (program.opts().json) console.log(JSON.stringify(result));
      else if (!result.ok) {
        console.error("Pull failed:", result.error);
        console.error(
          "Hint: check the remote path exists (`handheld shell 'ls <remote>'`) and is readable; the [local] destination dir must be writable."
        );
        process.exitCode = 1;
      }
    });

  const tinyCommand = program
    .command("tiny")
    .description("manage the bundled Tiny snapshot helper (subcommands: bootstrap, install, start)")
    .addHelpText(
      "after",
      `
Tiny is the on-device instrumentation that serves snapshots and input. \`connect\`
bootstraps it automatically; use these only to recover a broken helper.
  handheld tiny bootstrap          # upload + install + start (the usual fix)
  handheld tiny bootstrap --force  # reinstall after rebuilding Tiny
See \`handheld guide troubleshooting\` for "snapshot fails / Tiny unavailable".`
    );

  tinyCommand
    .command("bootstrap")
    .description("upload, install, and start Tiny through the active session [--force to reinstall]")
    .option("--force", "uninstall any existing Tiny first, then reinstall the bundled APK (use after rebuilding Tiny)")
    .addHelpText(
      "after",
      `
The one-shot fix when snapshots fail: uploads the bundled APK, installs it, and
starts the instrumentation (idempotent — reuses a healthy Tiny).
  handheld tiny bootstrap
  handheld tiny bootstrap --force   # force a clean uninstall + reinstall

Caveats:
  - Only one UiAutomation can be resident at a time; if another tool holds it
    (agent-device, a stray instrumentation), stop that first.
  - The first snapshot after a fresh install can take up to ~30s.`
    )
    .action(async (opts) => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const tiny = await ensureDeviceTiny({
          adb,
          api: () => new HandheldApiClient(),
          connection,
          force: opts.force === true,
          onProgress: program.opts().json || program.opts().quiet
            ? undefined
            : (message: string) => console.error(message),
          relay,
        });
        if (program.opts().json) {
          console.log(JSON.stringify({
            ok: true,
            port: TINY_DEVICE_PORT,
            tokenFile: tiny.tokenFile,
          }));
        } else {
          console.log("Tiny ready");
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  tinyCommand
    .command("install")
    .description("upload and install the bundled Tiny APK (does not start it)")
    .addHelpText(
      "after",
      `
  handheld tiny install

Caveat: installs only — run \`handheld tiny start\` afterward, or just use
\`handheld tiny bootstrap\`, which installs AND starts in one step.`
    )
    .action(async () => {
      const { relay, adb, connection } = getTransport(program);
      try {
        const api = new HandheldApiClient();
        const upload = await uploadSessionFile({
          api,
          customizeFilePath: TINY_REMOTE_APK,
          deviceId: connection.deviceId,
          filename: basename(bundledTinyApkPath()),
          localFile: bundledTinyApkPath(),
          sessionId: connection.sessionId,
        });
        await runShellString(
          relay,
          adb,
          tinyDeviceInstallCommand(TINY_REMOTE_APK),
          "Tiny install failed"
        );
        const result = {
          ok: true,
          path: upload.path ?? TINY_REMOTE_APK,
          taskId: upload.taskId ?? null,
          taskIds: upload.taskIds ?? [],
        };
        if (program.opts().json) console.log(JSON.stringify(result));
        else console.log(`Tiny installed at ${result.path}`);
      } finally {
        await disconnectRelay(relay);
      }
    });

  tinyCommand
    .command("start")
    .description("start the (already-installed) Tiny instrumentation and wait until it's ready")
    .addHelpText(
      "after",
      `
  handheld tiny start

Caveat: assumes the APK is already installed (\`handheld tiny install\` first), or
just use \`handheld tiny bootstrap\` to install + start together.`
    )
    .action(async () => {
      const { relay, adb } = getTransport(program);
      try {
        const tiny = ensureTinyToken();
        await runShellString(
          relay,
          adb,
          tinyDeviceStartCommand(tiny.token),
          "Tiny start failed"
        );
        const status = await waitForDeviceTiny({
          adb,
          relay,
          token: tiny.token,
        });
        if (program.opts().json) {
          console.log(JSON.stringify({ ok: true, status, tokenFile: tiny.tokenFile }));
        } else {
          console.log("Tiny ready");
        }
      } finally {
        await disconnectRelay(relay);
      }
    });

  program
    .command("upload <localFile> [remotePath]", { hidden: true })
    .description("upload a local file to the active Gateway session [--install] [--package] [--chmod] [--persist]")
    .option("--install", "install APK after upload")
    .option("--package <packageName>", "package name for APK installs")
    .option("--chmod <mode>", "chmod uploaded file after push")
    .option("--persist", "also save the upload to the file library")
    .option("--library-path <path>", "library path when --persist is used")
    .addHelpText(
      "after",
      `
Pushes a host file through the active Gateway session (cloud devices).
  handheld upload ./app.apk --install --package com.example.app
  handheld upload ./data.bin /sdcard/data.bin --chmod 644

Caveats:
  - Needs an active Gateway session (a cloud connect with an API key).
  - For a local ADB device, \`handheld install <path>\` pushes APKs directly.`
    )
    .action(async (localFile: string, remotePath: string | undefined, opts) => {
      try {
        const { connection, deviceId } = getTransport(program);
        const api = new HandheldApiClient();
        const result = await uploadSessionFile({
          api,
          autoInstall: opts.install,
          chmod: opts.chmod,
          customizeFilePath: remotePath,
          deviceId,
          libraryPath: opts.libraryPath,
          localFile,
          packageName: opts.package,
          persist: opts.persist,
          sessionId: connection.sessionId,
        });
        if (program.opts().json) console.log(JSON.stringify(result));
        else console.log(`Uploaded to ${result.path ?? "session"}`);
      } catch (err) {
        console.error("Upload failed:", (err as Error).message);
        console.error(
          "Hint: needs an active Gateway session (cloud connect with an API key) and a readable local file. For a local ADB device, use `handheld install <path>`."
        );
        process.exit(1);
      }
    });

  program
    .command("install <source>", { hidden: true })
    .description("install an APK from a URL or local path (ADB push, or session upload)")
    .addHelpText(
      "after",
      `
  handheld install ./app.apk                       # local path
  handheld install https://example.com/app.apk     # URL (uploaded + installed)

Caveat: a local path installs over ADB when available, else uploads through the
Gateway session. A URL is fetched and installed server-side via the session.`
    )
    .action(async (source: string) => {
      if (source.startsWith("http://") || source.startsWith("https://")) {
        const { deviceId } = getTransport(program);
        const api = new HandheldApiClient();
        const fileName = source.split("/").pop() ?? "app.apk";
        const result = await api.uploadUrl(deviceId, {
          url: source,
          fileName,
          autoInstall: true,
        });
        if (program.opts().json) console.log(JSON.stringify(result));
        else console.log("Install task submitted:", result.taskId ?? "ok");
      } else {
        const { adb, connection, deviceId } = getTransport(program);
        if (adb) {
          const result = await adb.install(source);
          if (program.opts().json) console.log(JSON.stringify(result));
          else if (!result.ok) {
            console.error("Install failed:", result.error);
            console.error(
              "Hint: confirm the path points to a valid APK; for a downgrade/reinstall, uninstall the existing package first (`handheld shell 'pm uninstall <pkg>'`)."
            );
            process.exitCode = 1;
          } else console.log("Installed.");
          return;
        }
        const api = new HandheldApiClient();
        const result = await uploadSessionFile({
          api,
          autoInstall: true,
          deviceId,
          localFile: source,
          packageName: basename(source).replace(/\.apk$/i, ""),
          sessionId: connection.sessionId,
        });
        if (program.opts().json) console.log(JSON.stringify(result));
        else console.log("Install task completed:", result.taskId ?? "ok");
      }
    });
}
