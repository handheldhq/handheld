import { spawn } from "node:child_process";
import type { Command } from "commander";
import { ApiError, HandheldApiClient } from "../api-client.js";
import {
  type Connection,
  getConnection,
  getRelayState,
  removeConnection,
  saveConnection,
  setConfig,
} from "../state.js";
import { getAuthorizationHeaders, getResolvedDevice } from "../auth.js";
import { spawnTunnelDaemon } from "../transport/adb/daemon.js";
import { execAdb } from "../transport/adb/tunnel.js";
import { spawnRelayDaemon } from "../transport/relay/daemon.js";
import { RelayClient } from "../transport/relay/client.js";
import { isStaleSessionError } from "../transport-errors.js";
import { startTinyHelper, type TinyHelperState } from "../tiny-helper.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldStartNewSession(args: {
  activeSession?: { status?: string } | null;
}): boolean {
  return args.activeSession?.status !== "active";
}

// Re-exported for connect's tests; the canonical definition lives in
// server-settle.ts alongside failedBeforeReachingDevice (so the relay command
// path can share it without a connect<->control import cycle).
export { isStaleSessionError };

type StartBlockedCode =
  | "SESSION_QUOTA_EXCEEDED"
  | "USAGE_BALANCE_EXHAUSTED"
  | "NO_POOL_EQUIPMENT"
  | "DEVICE_ERROR"
  | "CONFLICT";

export interface StartBlockedCopy {
  code: StartBlockedCode;
  message: string;
  nextSteps: string[];
}

export function startBlockedCopy(error: unknown): StartBlockedCopy | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.code;
  if (
    code !== "SESSION_QUOTA_EXCEEDED" &&
    code !== "USAGE_BALANCE_EXHAUSTED" &&
    code !== "NO_POOL_EQUIPMENT" &&
    code !== "DEVICE_ERROR" &&
    code !== "CONFLICT"
  ) {
    return null;
  }

  if (code === "SESSION_QUOTA_EXCEEDED") {
    return {
      code,
      message:
        "Concurrent session limit reached. Stop an active session or upgrade before starting another.",
      nextSteps: [
        "Run `handheld devices --status active` to find active sessions.",
        "Run `handheld disconnect <profile-id>` or stop a session in the dashboard, then retry.",
      ],
    };
  }

  if (code === "USAGE_BALANCE_EXHAUSTED") {
    return {
      code,
      message:
        "Free minutes and wallet balance are exhausted. Add credit or subscribe before starting new billable usage.",
      nextSteps: [
        "Open dashboard billing settings to add funds.",
        "Existing active sessions can still be stopped or saved before retrying.",
      ],
    };
  }

  if (code === "NO_POOL_EQUIPMENT") {
    return {
      code,
      message:
        "No pool hardware is available right now. Retry in a few minutes or claim a fresh device.",
      nextSteps: [
        "Wait briefly and retry — pool equipment frees up as other sessions end.",
        "Or run `handheld create` to claim a new device.",
      ],
    };
  }

  if (code === "DEVICE_ERROR") {
    return {
      code,
      message:
        "The Gateway couldn't reach the underlying device. Retry; if it persists, try a different profile.",
      nextSteps: [
        "Retry the same command after a few seconds.",
        "Run `handheld devices` to inspect device status and pick a healthy profile.",
      ],
    };
  }

  // CONFLICT
  return {
    code,
    message:
      "This profile is already starting (or stopping). Wait a moment and retry.",
    nextSteps: [
      "Run `handheld devices <id>` to inspect the in-flight session.",
      "Wait a few seconds for the current operation to settle, then retry.",
    ],
  };
}

function logConnectFailure(error: unknown, json: boolean): void {
  const blocked = startBlockedCopy(error);
  if (blocked) {
    if (json) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: blocked.code,
              message: blocked.message,
              nextSteps: blocked.nextSteps,
            },
          },
          null,
          2
        )
      );
    } else {
      console.error(`Connect failed: ${blocked.message}`);
      for (const step of blocked.nextSteps) console.error(`  - ${step}`);
    }
    return;
  }

  const msg = error instanceof Error ? error.message : JSON.stringify(error);
  if (json) {
    console.error(JSON.stringify({ ok: false, error: { message: msg } }, null, 2));
    return;
  }
  console.error("Connect failed:", msg);
  // Point at the recovery that matches the failure shape an agent is likely
  // hitting: auth for cloud, adb/Tiny for local, devices for a bad id.
  if (/api key|unauthor|401|403|sign in|log ?in/i.test(msg)) {
    console.error("Hint: authenticate first — `handheld login` (or set HANDHELD_API_KEY). Local devices need no key: `handheld connect --local`.");
  } else if (/adb|emulator|usb|device state|not found/i.test(msg)) {
    console.error("Hint: check `adb devices` — start an emulator or authorize USB debugging, then pass the serial: `handheld connect --local <serial>`.");
  } else {
    console.error("Hint: run `handheld devices` to confirm the device id, or `handheld status` to inspect existing connections.");
  }
}

function isLocalDevApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function openUrl(url: string): boolean {
  const isWin = process.platform === "win32";
  const command = isWin
    ? "cmd"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function discardLocalConnection(conn: Connection): void {
  if (conn.adb.sshPid) {
    try {
      process.kill(conn.adb.sshPid, "SIGTERM");
    } catch {}
  }

  if (conn.relay?.daemonPid) {
    try {
      process.kill(conn.relay.daemonPid, "SIGTERM");
    } catch {}
  }

  const tunnels = (globalThis as any).__muTunnels as
    | Map<string, { close: () => void }>
    | undefined;
  if (tunnels?.has(conn.deviceId)) {
    try {
      tunnels.get(conn.deviceId)!.close();
    } catch {}
    tunnels.delete(conn.deviceId);
  }

  const adbSerial = conn.adb?.serial;
  if (adbSerial) {
    try {
      execAdb(["disconnect", adbSerial]);
    } catch {}
  }

  removeConnection(conn.deviceId);
}

export interface ConnectDeviceOptions {
  adbOnly?: boolean;
  api?: HandheldApiClient;
  deviceId: string;
  headed?: boolean;
  json?: boolean;
  // Per-device relay bridge-token lifetime (ms). Pins this device's sessions to
  // a longer TTL than the 1h default; persisted on the connection so refreshes
  // reuse it. Capped gateway-side.
  sessionTtlMs?: number;
  startTiny?: boolean;
  webrtcOnly?: boolean;
  withAdb?: boolean;
}

export interface ConnectDeviceResult {
  adb: { serial: string; tunnelPort: number };
  deviceId: string;
  relay: {
    connected: boolean;
    relayUrl: string;
    viewerUrl?: string;
  };
  sessionId: string;
  tiny?: TinyHelperState;
}

function printConnectProgress(json: boolean, message: string): void {
  if (!json) process.stdout.write(message);
}

function printConnectLine(json: boolean, message: string): void {
  if (!json) console.log(message);
}

function isRetryableStartError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "DEVICE_BUSY" ||
      error.code === "DEVICE_ERROR" ||
      error.status === 409 ||
      error.status >= 500 ||
      /maintenance|维护中/i.test(error.message))
  );
}

async function startDeviceWithRetries(
  api: HandheldApiClient,
  deviceId: string,
  opts: { enableAdb: boolean; enableH5: boolean }
): ReturnType<HandheldApiClient["startDevice"]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await api.startDevice(deviceId, opts);
    } catch (error) {
      lastError = error;
      if (!isRetryableStartError(error)) {
        throw error;
      }
      if (opts.enableAdb && opts.enableH5) {
        return await api.startDevice(deviceId, {
          enableAdb: false,
          enableH5: true,
        });
      }
      if (attempt === 3) {
        throw error;
      }
      await sleep(5000);
    }
  }
  throw lastError;
}

export async function connectDevice(
  opts: ConnectDeviceOptions
): Promise<ConnectDeviceResult> {
  const resolvedDevice = opts.deviceId;
  const api = opts.api ?? new HandheldApiClient();
  const json = !!opts.json;
  const prefersRelayOnlyForLocalDev =
    !opts.adbOnly &&
    !opts.webrtcOnly &&
    !opts.withAdb &&
    isLocalDevApiUrl(api.getBaseUrl());

  const wantsRelay = !opts.adbOnly;
  const wantsAdb = opts.adbOnly
    ? true
    : opts.webrtcOnly
      ? false
      : opts.withAdb
        ? true
        : !prefersRelayOnlyForLocalDev;

  const existing = getConnection(resolvedDevice);
  if (existing) {
    const relayState = getRelayState(existing);
    if (relayState.connected && relayState.relayUrl) {
      try {
        const relay = new RelayClient(
          relayState.relayUrl,
          getAuthorizationHeaders()
        );
        try {
          const status = await relay.getStatus();
          if (status.active) {
            const existingAdbSerial = existing.adb?.serial ?? "";
            const existingAdbTunnelPort = existing.adb?.tunnelPort ?? 0;
            const hasAdb = !wantsAdb || !!existingAdbSerial;
            const hasRelayDaemon =
              !wantsRelay ||
              process.platform === "win32" ||
              !!existing.relay?.socketPath;
            if (hasAdb && hasRelayDaemon) {
              let tinyState = existing.tiny;
              if (existingAdbSerial && opts.startTiny !== false && !tinyState) {
                try {
                  printConnectProgress(json, "Tiny helper... ");
                  tinyState = await startTinyHelper({
                    serial: existingAdbSerial,
                  });
                  saveConnection({
                    ...existing,
                    connectedAt: new Date().toISOString(),
                    tiny: tinyState,
                  });
                  printConnectLine(json, "ok");
                } catch (err) {
                  printConnectLine(
                    json,
                    `skipped (${(err as Error).message})`
                  );
                }
              }
              if (opts.headed && relayState.viewerUrl) {
                openUrl(relayState.viewerUrl);
              }
              return {
                adb: {
                  serial: existingAdbSerial,
                  tunnelPort: existingAdbTunnelPort,
                },
                deviceId: resolvedDevice,
                relay: {
                  connected: relayState.connected,
                  relayUrl: relayState.relayUrl,
                  viewerUrl: relayState.viewerUrl,
                },
                sessionId: existing.sessionId,
                tiny: tinyState,
              };
            }
          }
        } finally {
          await relay.disconnect();
        }
      } catch {
        discardLocalConnection(existing);
      }
    } else {
      discardLocalConnection(existing);
    }
  }

  if (prefersRelayOnlyForLocalDev) {
    printConnectLine(
      json,
      "Local Gateway detected; preferring relay-only dev connect. Pass --with-adb to also bootstrap ADB."
    );
  }

  const liveDetail = await api.getDevice(resolvedDevice).catch(() => null);

  let startResult: Awaited<ReturnType<typeof api.startDevice>> | null = null;
  let sessionId =
    liveDetail?.activeSession?.status === "active"
      ? liveDetail.activeSession.sessionId
      : "";

  const activeSession = liveDetail?.activeSession;

  if (shouldStartNewSession({ activeSession })) {
    printConnectProgress(json, "Starting session... ");
    startResult = await startDeviceWithRetries(api, resolvedDevice, {
      enableAdb: wantsAdb,
      enableH5: wantsRelay,
    });
    printConnectLine(json, "ok");
    sessionId = startResult.sessionId;
  } else {
    const missing: string[] = [];
    if (wantsRelay && !activeSession?.h5Enabled) missing.push("relay");
    if (wantsAdb && !activeSession?.adbEnabled) missing.push("ADB");
    printConnectLine(
      json,
      missing.length > 0
        ? `Reusing active session; enabling ${missing.join(" + ")}`
        : "Reusing active session"
    );
  }

  let relayState = {
    connected: false,
    daemonPid: undefined as number | undefined,
    relayUrl: "",
    socketPath: undefined as string | undefined,
    viewerUrl: undefined as string | undefined,
  };
  let adbState = { serial: "", sshPid: 0, tunnelPort: 0 };

  const runRelayConnect = async (): Promise<typeof relayState> => {
    const relayInfo = await api.getDeviceRelayInfo(resolvedDevice, { ttlMs: opts.sessionTtlMs });
    const relayUrl = relayInfo.relayUrl;
    const relay = new RelayClient(relayUrl, getAuthorizationHeaders());
    try {
      await relay.connect();
    } finally {
      await relay.disconnect();
    }
    printConnectLine(json, "ok");
    const next = {
      connected: true,
      daemonPid: undefined as number | undefined,
      relayUrl,
      socketPath: undefined as string | undefined,
      viewerUrl: startResult?.h5?.viewerUrl
        ? startResult.h5.viewerUrl
        : relayInfo.h5?.viewerUrl
          ? relayInfo.h5.viewerUrl
          : liveDetail?.activeSession?.h5?.viewerUrl
            ? api.resolveUrl(liveDetail.activeSession.h5.viewerUrl)
            : undefined,
    };
    if (process.platform !== "win32") {
      try {
        printConnectProgress(json, "Relay daemon... ");
        const daemon = await spawnRelayDaemon({ deviceId: resolvedDevice, relayUrl });
        next.daemonPid = daemon.pid;
        next.socketPath = daemon.socketPath;
        printConnectLine(json, "ok");
      } catch (err) {
        printConnectLine(json, `failed (${(err as Error).message})`);
      }
    }
    return next;
  };

  if (!opts.adbOnly) {
    printConnectProgress(json, "Connecting relay... ");
    try {
      relayState = await runRelayConnect();
    } catch (err) {
      // A reused "active" session whose relay/live token has desynced or expired
      // would dead-end here (and previously forced spinning up a new device).
      // Stop the stale session and mint a fresh one on the SAME device, retry.
      if (!startResult && isStaleSessionError((err as Error).message)) {
        printConnectLine(json, "stale session — re-minting");
        try {
          await api.stopDevice(resolvedDevice);
        } catch {}
        try {
          startResult = await startDeviceWithRetries(api, resolvedDevice, {
            enableAdb: wantsAdb,
            enableH5: wantsRelay,
          });
          sessionId = startResult.sessionId;
          printConnectProgress(json, "Connecting relay (fresh session)... ");
          relayState = await runRelayConnect();
        } catch (err2) {
          printConnectLine(json, `failed (${(err2 as Error).message})`);
          if (opts.webrtcOnly) throw err2;
        }
      } else {
        printConnectLine(json, `failed (${(err as Error).message})`);
        if (opts.webrtcOnly) throw err;
      }
    }
  }

  if (!opts.webrtcOnly) {
    let adb = startResult?.adb;
    if ((!adb?.sshCommand || !adb?.key || !adb?.tunnel) && wantsAdb && sessionId) {
      printConnectProgress(json, "Enabling ADB on active session... ");
      try {
        adb = await api.recoverSessionAdb(sessionId);
        printConnectLine(
          json,
          adb?.sshCommand && adb?.key && adb?.tunnel ? "ok" : "unavailable"
        );
      } catch (err) {
        printConnectLine(json, `failed (${(err as Error).message})`);
        if (opts.adbOnly) throw err;
        adb = undefined;
      }
    }
    if (adb?.sshCommand && adb?.key && adb?.tunnel) {
      try {
        printConnectProgress(json, "Setting up ADB tunnel... ");
        let tunnel: Awaited<ReturnType<typeof spawnTunnelDaemon>>;
        try {
          tunnel = await spawnTunnelDaemon({
            deviceId: resolvedDevice,
            sshPassword: adb.key,
            tunnel: adb.tunnel,
          });
        } catch (firstError) {
          if (!sessionId) throw firstError;
          printConnectProgress(json, "recovering provider ADB... ");
          adb = await api.recoverSessionAdb(sessionId);
          if (!adb?.sshCommand || !adb.key || !adb.tunnel) {
            throw firstError;
          }
          tunnel = await spawnTunnelDaemon({
            deviceId: resolvedDevice,
            sshPassword: adb.key,
            tunnel: adb.tunnel,
          });
        }

        adbState = {
          serial: tunnel.adbSerial,
          sshPid: tunnel.pid,
          tunnelPort: tunnel.localPort,
        };
        printConnectLine(json, "ok");
      } catch (err) {
        printConnectLine(json, `failed (${(err as Error).message})`);
        if (opts.adbOnly) throw err;
      }
    } else {
      printConnectLine(json, "ADB: not available for this device");
    }
  }

  if (!relayState.connected && !adbState.serial) {
    throw new Error("No transport became available for this device");
  }

  let tinyState: TinyHelperState | undefined;
  if (adbState.serial && opts.startTiny !== false) {
    try {
      printConnectProgress(json, "Tiny helper... ");
      tinyState = await startTinyHelper({ serial: adbState.serial });
      printConnectLine(json, "ok");
    } catch (err) {
      printConnectLine(json, `skipped (${(err as Error).message})`);
    }
  }

  saveConnection({
    deviceId: resolvedDevice,
    sessionId,
    padCode: startResult?.h5?.padCode ?? liveDetail?.activeSession?.padCode ?? "",
    relay: relayState,
    adb: adbState,
    connectedAt: new Date().toISOString(),
    tiny: tinyState,
    ...(opts.sessionTtlMs ? { sessionTtlMs: opts.sessionTtlMs } : {}),
  });
  // Make the just-connected device the default so bare commands target it.
  setConfig({ defaultDevice: resolvedDevice });

  if (opts.headed && relayState.viewerUrl) {
    openUrl(relayState.viewerUrl);
  }

  return {
    adb: {
      serial: adbState.serial,
      tunnelPort: adbState.tunnelPort,
    },
    deviceId: resolvedDevice,
    relay: {
      connected: relayState.connected,
      relayUrl: relayState.relayUrl,
      viewerUrl: relayState.viewerUrl,
    },
    sessionId,
    tiny: tinyState,
  };
}

function printConnectResult(
  result: ConnectDeviceResult,
  json: boolean
): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          deviceId: result.deviceId,
          sessionId: result.sessionId,
          relay: {
            connected: result.relay.connected,
            url: result.relay.relayUrl,
          },
          adb: {
            serial: result.adb.serial,
            tunnelPort: result.adb.tunnelPort,
          },
          tiny: result.tiny
            ? {
                baseUrl: result.tiny.baseUrl,
                port: result.tiny.port,
                status: result.tiny.status,
              }
            : null,
          viewer: result.relay.viewerUrl
            ? { url: result.relay.viewerUrl }
            : null,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\nConnected to ${result.deviceId}`);
  console.log(`  Session: ${result.sessionId}`);
  if (result.relay.connected) {
    console.log("  Relay:  connected");
  }
  if (result.adb.serial) {
    console.log(`  ADB:    ${result.adb.serial}`);
  }
  if (result.tiny) {
    console.log(`  Tiny:   ${result.tiny.baseUrl}`);
  }
  if (result.relay.viewerUrl) {
    console.log(`  Viewer: ${result.relay.viewerUrl}`);
  }
}

// --- Local adb attach (`connect --local`) ----------------------------------
// A local connection is a controller for an adb device/emulator that's already
// reachable on this host. It never talks to the Gateway: no session, no relay,
// no tunnel, no API key. We just bootstrap Tiny over adb (the same path the
// harness uses) and persist a relay-less Connection marked `local: true`.

export interface AdbDeviceLine {
  serial: string;
  state: string;
}

export interface ConnectLocalResult {
  adb: { serial: string; tunnelPort: number };
  deviceId: string;
  tiny?: TinyHelperState;
}

/** Parse `adb devices -l` into {serial, state} rows. */
export function parseAdbDevices(output: string): AdbDeviceLine[] {
  const rows: AdbDeviceLine[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices")) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (serial) rows.push({ serial, state: state ?? "" });
  }
  return rows;
}

/**
 * Pick the adb serial to attach to. With an explicit `requested` serial, it
 * must exist and be in `device` state. Otherwise auto-select when exactly one
 * device is ready (mirrors the harness's single-device convenience); error
 * clearly on zero or many so the caller passes one.
 */
export function resolveLocalSerial(
  devices: AdbDeviceLine[],
  requested?: string
): { serial: string } | { error: string } {
  if (requested) {
    const match = devices.find((d) => d.serial === requested);
    if (!match) {
      const known = devices.map((d) => d.serial).join(", ") || "none";
      return { error: `adb device "${requested}" not found (connected: ${known})` };
    }
    if (match.state !== "device") {
      return {
        error: `adb device "${requested}" is "${match.state}", not "device" — authorize USB debugging / wait for boot`,
      };
    }
    return { serial: requested };
  }
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 1) return { serial: ready[0]!.serial };
  if (ready.length === 0) {
    return {
      error:
        "No adb device in 'device' state. Start an emulator or plug in a device and authorize USB debugging.",
    };
  }
  return {
    error: `Multiple adb devices (${ready
      .map((d) => d.serial)
      .join(", ")}). Pass one: handheld connect --local <serial>`,
  };
}

function listAdbDevices(): AdbDeviceLine[] {
  return parseAdbDevices(execAdb(["devices", "-l"]));
}

export async function connectLocalDevice(opts: {
  json?: boolean;
  serial?: string;
  startTiny?: boolean;
}): Promise<ConnectLocalResult> {
  const json = !!opts.json;
  const resolution = resolveLocalSerial(listAdbDevices(), opts.serial);
  if ("error" in resolution) throw new Error(resolution.error);
  const serial = resolution.serial;

  let tiny: TinyHelperState | undefined;
  if (opts.startTiny !== false) {
    try {
      printConnectProgress(json, "Tiny helper... ");
      tiny = await startTinyHelper({ serial });
      printConnectLine(json, "ok");
    } catch (err) {
      // Tiny is best-effort: snapshots fall back to the device path, and the
      // user can retry with `handheld tiny bootstrap`.
      printConnectLine(json, `skipped (${(err as Error).message})`);
    }
  }

  const tunnelPort = tiny?.port ?? 0;
  saveConnection({
    adb: { serial, sshPid: 0, tunnelPort },
    connectedAt: new Date().toISOString(),
    deviceId: serial,
    local: true,
    padCode: "",
    relay: { connected: false, relayUrl: "" },
    sessionId: "local",
    tiny,
  });
  // Make the just-connected device the default so the documented bare loop
  // (`connect → snap → …`, no --device) targets it instead of a stale default.
  setConfig({ defaultDevice: serial });

  return { adb: { serial, tunnelPort }, deviceId: serial, tiny };
}

function printLocalConnectResult(result: ConnectLocalResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  console.log(`Connected (local): ${result.deviceId}`);
  console.log(`  ADB:    ${result.adb.serial}`);
  if (result.tiny) {
    console.log(`  Tiny:   ${result.tiny.baseUrl}`);
  } else {
    console.log("  Tiny:   not started (snapshots use the device path)");
  }
}

export function registerConnectCommand(program: Command): void {
  program
    .command("connect [deviceId]")
    .description(
      "connect a device: cloud phone (relay + ADB dual transport, needs API key) or --local [serial] adb device (no key)"
    )
    .option("--headed", "open a browser window with the remote device viewer")
    .option(
      "--local",
      "attach to a local adb device/emulator directly (no Gateway, no API key); optional [deviceId] selects the serial"
    )
    .option("--adb-only", "skip relay, only set up ADB tunnel")
    .option(
      "--with-adb",
      "when using a local dev worker, also set up ADB instead of preferring relay-only"
    )
    .option("--no-tiny", "skip Tiny helper startup after ADB connects")
    .option("--webrtc-only", "deprecated alias for relay-only mode")
    .option(
      "--session-ttl <hours>",
      "relay session lifetime in hours for this device (default 1; capped server-side)",
      parseFloat
    )
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld connect <deviceId> [--headed] [--adb-only] [--with-adb] [--no-tiny] [--session-ttl <hours>]
  handheld connect --local [serial] [--no-tiny]

Examples:
  handheld init                                  # first run: claim/connect a trial cloud phone
  handheld connect prof_abc123                   # cloud phone: start/reuse a session, relay + ADB
  handheld connect prof_abc123 --headed          # cloud phone + open the live viewer in a browser
  handheld connect --local                       # local dev: attach one ready adb device/emulator
  handheld connect --local emulator-5554         # local dev: name the serial (see: adb devices)

Caveats:
  - Cloud is the default product path. Use \`handheld init\` to claim/connect the first trial phone.
  - Cloud reconnect <deviceId> needs an API key — run \`handheld login\` (or set HANDHELD_API_KEY) first.
  - \`--local [serial]\` is for local dev/CI; it needs \`adb\` on PATH and a device in 'device' state (see: adb devices); it never calls the Gateway.
  - Both paths bootstrap the on-device Tiny helper for snapshots/input; pass --no-tiny to skip it.
  - With several adb devices attached, \`--local\` requires an explicit [serial]; with one it auto-picks.
  - Tear down with \`handheld disconnect\` (local: drops the forward; cloud: also stops the Gateway session).`
    )
    .action(
      async (
        deviceId?: string,
        opts?: {
          headed?: boolean;
          local?: boolean;
          adbOnly?: boolean;
          webrtcOnly?: boolean;
          withAdb?: boolean;
          tiny?: boolean;
          sessionTtl?: number;
        }
      ) => {
        const json = program.opts().json;

        if (opts?.local) {
          try {
            const result = await connectLocalDevice({
              json,
              serial: deviceId ?? program.opts().device,
              startTiny: opts.tiny,
            });
            printLocalConnectResult(result, json);
          } catch (err) {
            logConnectFailure(err, json);
            process.exit(1);
          }
          return;
        }

        const resolvedDevice = getResolvedDevice(deviceId ?? program.opts().device);
        if (!resolvedDevice) {
          console.error(
            "No device specified. Pass a device ID or set default: handheld config set default-device <id>"
          );
          console.error(
            "Hint: run `handheld connect --help` to choose cloud or local. First-run cloud setup is `handheld init`; existing cloud devices are listed by `handheld devices`."
          );
          process.exit(1);
        }

        try {
          const result = await connectDevice({
            adbOnly: opts?.adbOnly,
            deviceId: resolvedDevice,
            headed: opts?.headed,
            json,
            ...(opts?.sessionTtl && opts.sessionTtl > 0
              ? { sessionTtlMs: Math.round(opts.sessionTtl * 60 * 60 * 1000) }
              : {}),
            startTiny: opts?.tiny,
            webrtcOnly: opts?.webrtcOnly,
            withAdb: opts?.withAdb,
          });
          printConnectResult(result, json);
        } catch (err) {
          logConnectFailure(err, json);
          process.exit(1);
        }
      }
    );
}
