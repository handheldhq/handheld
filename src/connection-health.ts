import { existsSync, statSync } from "node:fs";
import {
  getConfig,
  getConnection,
  getConnections,
  getRelayState,
  removeConnection,
  type Connection,
} from "./state.js";

export type TargetSource = "cli" | "env" | "default" | "implicit";

export interface ConnectionHealth {
  adbAvailable: boolean;
  relayAvailable: boolean;
  reasons: string[];
  usable: boolean;
}

export interface ResolvedConnection {
  connection: Connection;
  health: ConnectionHealth;
  source: TargetSource;
  targetDeviceId: string;
}

export interface ConnectionResolutionError {
  health?: ConnectionHealth;
  reason: string;
  source: TargetSource;
  targetDeviceId?: string;
}

export type ConnectionResolution =
  | { ok: true; value: ResolvedConnection }
  | { error: ConnectionResolutionError; ok: false };

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function relaySocketProblem(socketPath: unknown): string | null {
  if (!hasText(socketPath)) return null;
  if (!existsSync(socketPath)) return "relay socket missing";
  try {
    if (!statSync(socketPath).isSocket()) return "relay socket invalid";
  } catch {
    return "relay socket missing";
  }
  return null;
}

function relayDaemonProblem(daemonPid: unknown): string | null {
  if (
    typeof daemonPid !== "number" ||
    !Number.isFinite(daemonPid) ||
    daemonPid <= 0
  ) {
    return null;
  }
  try {
    process.kill(daemonPid, 0);
    return null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return "relay daemon not running";
    }
    return null;
  }
}

export function inspectConnectionHealth(connection: Connection): ConnectionHealth {
  const reasons: string[] = [];
  const relayState = getRelayState(connection);
  const relaySocketIssue = relaySocketProblem(relayState.socketPath);
  const relayDaemonIssue = relayDaemonProblem(relayState.daemonPid);
  const relayAvailable = Boolean(
    relayState.connected &&
      hasText(relayState.relayUrl) &&
      !relaySocketIssue &&
      !relayDaemonIssue
  );
  const adbAvailable = hasText(connection.adb?.serial);

  if (!hasText(connection.deviceId)) reasons.push("missing deviceId");
  if (!hasText(connection.sessionId)) reasons.push("missing sessionId");
  if (relaySocketIssue) reasons.push(relaySocketIssue);
  if (relayDaemonIssue) reasons.push(relayDaemonIssue);
  if (!relayAvailable && !adbAvailable) {
    reasons.push("no usable relay or ADB transport");
  }

  const fatalReasons = reasons.filter((reason) => {
    return !(
      adbAvailable &&
      (reason === "relay socket missing" ||
        reason === "relay socket invalid" ||
        reason === "relay daemon not running")
    );
  });

  return {
    adbAvailable,
    relayAvailable,
    reasons,
    usable: fatalReasons.length === 0,
  };
}

export function resolveConnection(
  opts: { device?: string; envDevice?: string } = {}
): ConnectionResolution {
  const config = getConfig();
  const envDevice = opts.envDevice ?? process.env.HANDHELD_DEVICE;
  const explicitDevice = opts.device ?? envDevice ?? config.defaultDevice;
  const source: TargetSource = opts.device
    ? "cli"
    : envDevice
      ? "env"
      : config.defaultDevice
        ? "default"
        : "implicit";

  const connection = explicitDevice
    ? getConnection(explicitDevice)
    : getConnections()[0];

  if (!connection) {
    return {
      ok: false,
      error: {
        reason: explicitDevice
          ? "No saved connection for " + explicitDevice
          : "No saved connections",
        source,
        targetDeviceId: explicitDevice,
      },
    };
  }

  const health = inspectConnectionHealth(connection);
  if (!health.usable) {
    return {
      ok: false,
      error: {
        health,
        reason: health.reasons.join("; ") || "Connection is not usable",
        source,
        targetDeviceId: connection.deviceId,
      },
    };
  }

  return {
    ok: true,
    value: {
      connection,
      health,
      source,
      targetDeviceId: connection.deviceId,
    },
  };
}

export function pruneStaleConnections(): string[] {
  const pruned: string[] = [];
  for (const connection of getConnections()) {
    if (!inspectConnectionHealth(connection).usable) {
      pruned.push(connection.deviceId);
      removeConnection(connection.deviceId);
    }
  }
  return pruned;
}
