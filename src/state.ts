import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.handheld/ directory structure
const HANDHELD_HOME = join(homedir(), ".handheld");
const CONFIG_PATH = join(HANDHELD_HOME, "config.json");
const CONNECTIONS_PATH = join(HANDHELD_HOME, "connections.json");
const KEYS_DIR = join(HANDHELD_HOME, "keys");
const SOCKETS_DIR = join(HANDHELD_HOME, "sockets");
const BIN_DIR = join(HANDHELD_HOME, "bin");
const RUNS_DIR = join(HANDHELD_HOME, "runs");

export interface HandheldConfig {
  apiKey?: string;
  apiUrl?: string;
  defaultDevice?: string;
  output?: "table" | "json" | "quiet";
}

/**
 * Legacy pre-relay connection state kept for backward compatibility with
 * existing `~/.handheld/connections.json` entries. New connections should use
 * `relay`, not `webrtc`.
 */
export interface WebRTCState {
  bridgeUrl: string;
  connected: boolean;
  pid: number;
  relayUrl: string;
  rtt?: number;
}

export interface RelayState {
  connected: boolean;
  relayUrl: string;
  viewerUrl?: string;
  daemonPid?: number;
  socketPath?: string;
}

export interface AdbState {
  serial: string;
  sshPid: number;
  tunnelPort: number;
}

export interface TinyState {
  baseUrl: string;
  port: number;
  status: string;
  tokenFile: string;
}

export interface Connection {
  deviceId: string;
  sessionId: string;
  padCode: string;
  relay?: RelayState;
  webrtc?: WebRTCState;
  adb: AdbState;
  tiny?: TinyState;
  connectedAt: string;
  sessionExpiresAt?: string;
  // A locally-attached adb device/emulator (`connect --local`) rather than a
  // Gateway cloud phone. Local connections never call the Gateway API, so
  // teardown skips `stopDevice` and control commands need no API key.
  local?: boolean;
  // Per-device bridge-token lifetime (ms) requested via `--session-ttl`. Carried
  // into getDeviceRelayInfo (initial + auto-refresh) so this device's relay
  // sessions live longer than the 1h default. Capped gateway-side.
  sessionTtlMs?: number;
}

export function getRelayState(connection: Connection): RelayState {
  if (connection.relay) {
    return connection.relay;
  }

  if (connection.webrtc) {
    return {
      connected: connection.webrtc.connected,
      daemonPid: undefined,
      relayUrl: connection.webrtc.relayUrl,
      socketPath: undefined,
      viewerUrl: connection.webrtc.bridgeUrl || undefined,
    };
  }

  return {
    connected: false,
    relayUrl: "",
  };
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Best-effort chmod. Some filesystems and platforms (notably Windows) reject
 * or ignore POSIX mode changes; a failure here must never break a command.
 */
function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, mode);
  } catch {
    // ignore: best-effort permission repair
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  // Repair pre-existing dirs created under a looser umask.
  chmodIfExists(dir, DIR_MODE);
}

let permissionsRepaired = false;

/**
 * Tighten permissions on any pre-existing secrets in ~/.handheld. This runs on read
 * and write paths so config/connections/keys written before the chmod-on-write
 * behavior (or under a loose umask) are repaired, not only newly written files.
 *
 * The full scan runs at most once per process: pre-existing loose perms only
 * need fixing once at startup, and every later write sets its own mode via
 * `writeFileSync({ mode })` / `ensureDir`, so repeated read/write calls do not
 * need to re-scan `keys/`.
 */
function repairExistingPermissions(): void {
  if (permissionsRepaired) return;
  permissionsRepaired = true;
  chmodIfExists(HANDHELD_HOME, DIR_MODE);
  chmodIfExists(KEYS_DIR, DIR_MODE);
  chmodIfExists(SOCKETS_DIR, DIR_MODE);
  chmodIfExists(BIN_DIR, DIR_MODE);
  chmodIfExists(RUNS_DIR, DIR_MODE);
  chmodIfExists(CONFIG_PATH, FILE_MODE);
  chmodIfExists(CONNECTIONS_PATH, FILE_MODE);
  if (existsSync(KEYS_DIR)) {
    try {
      for (const entry of readdirSync(KEYS_DIR, { withFileTypes: true })) {
        const mode = entry.isDirectory() ? DIR_MODE : FILE_MODE;
        chmodIfExists(join(KEYS_DIR, entry.name), mode);
      }
    } catch {
      // ignore: best-effort permission repair
    }
  }
}

function ensureMuHome(): void {
  ensureDir(HANDHELD_HOME);
  ensureDir(KEYS_DIR);
  ensureDir(SOCKETS_DIR);
  ensureDir(BIN_DIR);
  ensureDir(RUNS_DIR);
  repairExistingPermissions();
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureMuHome();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
}

// Config
export function getConfig(): HandheldConfig {
  repairExistingPermissions();
  return readJson<HandheldConfig>(CONFIG_PATH, {});
}

export function setConfig(updates: Partial<HandheldConfig>): HandheldConfig {
  const config = { ...getConfig(), ...updates };
  writeJson(CONFIG_PATH, config);
  return config;
}

// Connections
export function getConnections(): Connection[] {
  repairExistingPermissions();
  return readJson<Connection[]>(CONNECTIONS_PATH, []);
}

export function getConnection(deviceId: string): Connection | undefined {
  return getConnections().find((c) => c.deviceId === deviceId);
}

export function getActiveConnection(): Connection | undefined {
  const config = getConfig();
  const connections = getConnections();
  if (config.defaultDevice) {
    return connections.find((c) => c.deviceId === config.defaultDevice);
  }
  return connections[0];
}

export function saveConnection(conn: Connection): void {
  const connections = getConnections().filter(
    (c) => c.deviceId !== conn.deviceId
  );
  connections.push(conn);
  writeJson(CONNECTIONS_PATH, connections);
}

export function removeConnection(deviceId: string): void {
  const connections = getConnections().filter(
    (c) => c.deviceId !== deviceId
  );
  writeJson(CONNECTIONS_PATH, connections);
}

// SSH keys
export function saveKey(deviceId: string, key: string): string {
  ensureMuHome();
  const keyPath = join(KEYS_DIR, `${deviceId}.key`);
  writeFileSync(keyPath, key + "\n", { mode: FILE_MODE });
  chmodSync(keyPath, FILE_MODE);
  return keyPath;
}

export function getKeyPath(deviceId: string): string {
  const keyPath = join(KEYS_DIR, `${deviceId}.key`);
  chmodIfExists(keyPath, FILE_MODE);
  return keyPath;
}

// Paths
export function getSocketPath(deviceId: string): string {
  ensureMuHome();
  return join(SOCKETS_DIR, `${deviceId}.sock`);
}

export function getBinDir(): string {
  ensureMuHome();
  return BIN_DIR;
}

export function getRunsDir(): string {
  ensureMuHome();
  return RUNS_DIR;
}

export { HANDHELD_HOME, KEYS_DIR, SOCKETS_DIR, BIN_DIR, RUNS_DIR };
