import type { Command } from "commander";
import { getAuthorizationHeaders } from "../auth.js";
import {
  getConfig,
  getConnections,
  getRelayState,
  removeConnection,
  type Connection,
  type HandheldConfig,
} from "../state.js";
import {
  inspectConnectionHealth,
  resolveConnection,
  type ConnectionHealth,
} from "../connection-health.js";
import { maskApiKey, maskUrl } from "../redact.js";
import { probePort } from "../transport/adb/tunnel.js";
import { RelayClient } from "../transport/relay/client.js";
import { requestRelayDaemon } from "../transport/relay/daemon.js";

interface ConnectionStatus {
  adb: {
    port: number;
    serial: string;
    tunnelAlive: boolean;
  };
  connectedAt: string;
  deviceId: string;
  health: ConnectionHealth;
  relay: {
    relayStatus: Awaited<ReturnType<RelayClient["getStatus"]>> | null;
    url: string;
  };
  sessionId: string;
}

interface InternalConnectionStatus extends ConnectionStatus {
  relayProbeFailed: boolean;
}

function relayStateForDisplay(relay: ReturnType<typeof getRelayState>): ReturnType<typeof getRelayState> {
  return {
    ...relay,
    relayUrl: relay.relayUrl ? maskUrl(relay.relayUrl) : "",
    viewerUrl: relay.viewerUrl ? maskUrl(relay.viewerUrl) : undefined,
  };
}

export function configForDisplay(config: HandheldConfig): HandheldConfig {
  return {
    ...config,
    apiKey: config.apiKey ? maskApiKey(config.apiKey) : undefined,
  };
}

function authorizationHeaders(): Record<string, string> | null {
  try {
    return getAuthorizationHeaders();
  } catch {
    return null;
  }
}

async function statusForConnection(
  conn: Connection,
  authHeaders: Record<string, string> | null,
  opts: { health?: ConnectionHealth; probeRelay?: boolean } = {}
): Promise<InternalConnectionStatus> {
  const tunnelAlive = conn.adb?.tunnelPort
    ? await probePort(conn.adb.tunnelPort)
    : false;

  const relayState = getRelayState(conn);
  const health = opts.health ?? inspectConnectionHealth(conn);
  const probeRelay = opts.probeRelay ?? true;
  let relayStatus: Awaited<ReturnType<RelayClient["getStatus"]>> | null = null;
  let relayProbeFailed = false;
  if (probeRelay && health.relayAvailable && relayState.socketPath) {
    try {
      const response = await requestRelayDaemon(
        relayState.socketPath,
        { action: "status" },
        { timeoutMs: 1500 }
      );
      if (response.ok && response.data && typeof response.data === "object") {
        relayStatus = response.data as Awaited<ReturnType<RelayClient["getStatus"]>>;
      } else {
        relayProbeFailed = true;
      }
    } catch {
      relayStatus = null;
      relayProbeFailed = true;
    }
  } else if (
    probeRelay &&
    health.relayAvailable &&
    relayState.relayUrl &&
    authHeaders
  ) {
    const relay = new RelayClient(relayState.relayUrl, authHeaders);
    try {
      relayStatus = await relay.getStatus();
    } catch {
      relayStatus = null;
      relayProbeFailed = true;
    } finally {
      await relay.disconnect();
    }
  }

  return {
    adb: {
      port: conn.adb?.tunnelPort ?? 0,
      serial: conn.adb?.serial ?? "",
      tunnelAlive,
    },
    connectedAt: conn.connectedAt,
    deviceId: conn.deviceId,
    health,
    relay: {
      relayStatus,
      url: relayState.relayUrl ? maskUrl(relayState.relayUrl) : "",
    },
    relayProbeFailed,
    sessionId: conn.sessionId,
  };
}

function healthWithRelayProbeFailure(health: ConnectionHealth): ConnectionHealth {
  const reasons = health.reasons.includes("relay probe failed")
    ? [...health.reasons]
    : [...health.reasons, "relay probe failed"];
  if (!health.adbAvailable && !reasons.includes("no usable relay or ADB transport")) {
    reasons.push("no usable relay or ADB transport");
  }
  return {
    ...health,
    relayAvailable: false,
    reasons,
    usable: health.adbAvailable,
  };
}

function publicStatus(status: InternalConnectionStatus): ConnectionStatus {
  const { relayProbeFailed: _relayProbeFailed, ...rest } = status;
  return rest;
}

function commandJson(program: Command, opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json ?? program.opts().json);
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("show active connections and transport health (relay + ADB liveness per device)")
    .option("--json", "output as JSON")
    .option("--prune", "remove saved connections with no usable relay or ADB transport")
    .addHelpText(
      "after",
      [
        "",
        "Arg grammar:",
        "  handheld status [--json] [--prune]",
        "",
        "Examples:",
        "  handheld status          # per-device: session, relay ready/offline, ADB serial + tunnel liveness",
        "  handheld status --json   # same, structured (probes the relay live when auth is available)",
        "  handheld status --prune  # remove stale local connection records",
        "",
        "Caveats:",
        "  - Reads locally saved connections. Empty output means nothing is attached: run handheld init.",
        "  - Relay offline or ADB dead means the transport dropped; run handheld init to refresh the default cloud path.",
      ].join("\n")
    )
    .action(async (opts: { json?: boolean; prune?: boolean } = {}) => {
      const json = commandJson(program, opts);
      const connections = getConnections();

      if (connections.length === 0) {
        if (json) console.log(JSON.stringify({ connections: [], pruned: [] }));
        else {
          console.log("No active connections.");
          console.log("Hint: run handheld init to claim/connect a trial cloud phone and scaffold this project.");
          console.log("Existing cloud profiles reconnect with handheld connect <device-id>; for a local adb device/emulator use handheld connect --local [serial].");
        }
        return;
      }

      const pruned: string[] = [];
      const authHeaders = authorizationHeaders();
      const statuses = await Promise.all(
        connections.map(async (conn) => {
          const health = inspectConnectionHealth(conn);
          const shouldPrune = Boolean(opts.prune && !health.usable);
          if (shouldPrune) {
            removeConnection(conn.deviceId);
            pruned.push(conn.deviceId);
          }
          const status = await statusForConnection(conn, authHeaders, {
            health,
            probeRelay: !shouldPrune,
          });
          if (
            opts.prune &&
            !shouldPrune &&
            status.relayProbeFailed &&
            !status.health.adbAvailable
          ) {
            removeConnection(conn.deviceId);
            pruned.push(conn.deviceId);
            return {
              ...publicStatus(status),
              health: healthWithRelayProbeFailure(status.health),
            };
          }
          return publicStatus(status);
        })
      );

      if (json) {
        console.log(JSON.stringify({ connections: statuses, pruned }, null, 2));
        return;
      }

      if (pruned.length > 0) {
        console.log("Pruned stale connections: " + pruned.join(", "));
      }
      for (const status of statuses) {
        console.log(status.deviceId);
        console.log("  Session: " + status.sessionId);
        console.log("  Since:   " + status.connectedAt);
        console.log(
          "  Relay:   " + (status.relay.relayStatus?.active ? "ready" : "offline")
        );
        console.log(
          "  ADB:     " + (status.adb.serial || "none") + " " + (status.adb.tunnelAlive ? "(alive)" : "(dead)")
        );
        if (!status.health.usable) {
          console.log("  Health:  stale (" + status.health.reasons.join("; ") + ")");
        }
      }
    });

  program
    .command("doctor")
    .description("diagnose config, target selection, relay, ADB, Tiny, and stale-prune readiness")
    .option("--json", "output as JSON")
    .addHelpText(
      "after",
      [
        "",
        "Arg grammar:",
        "  handheld doctor [--json]",
        "",
        "Examples:",
        "  handheld doctor          # secret-safe diagnostic summary",
        "  handheld doctor --json   # structured diagnostic output",
        "",
        "Caveats:",
        "  - API keys are masked. This command does not mutate state; use handheld status --prune to remove stale records.",
      ].join("\n")
    )
    .action((opts: { json?: boolean } = {}) => {
      const json = commandJson(program, opts);
      const config = getConfig();
      const resolution = resolveConnection({
        device: program.opts().device as string | undefined,
      });
      const connections = getConnections().map((connection) => ({
        deviceId: connection.deviceId,
        health: inspectConnectionHealth(connection),
        local: Boolean(connection.local),
        relay: relayStateForDisplay(getRelayState(connection)),
        sessionId: connection.sessionId,
        tiny: connection.tiny ?? null,
      }));
      const report = {
        config: configForDisplay(config),
        connections,
        target: resolution.ok
          ? {
              deviceId: resolution.value.targetDeviceId,
              health: resolution.value.health,
              ok: true,
              source: resolution.value.source,
            }
          : {
              error: resolution.error.reason,
              health: resolution.error.health,
              ok: false,
              source: resolution.error.source,
              targetDeviceId: resolution.error.targetDeviceId,
            },
      };

      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log("Config:");
      console.log("  API URL: " + (report.config.apiUrl ?? "not set"));
      console.log("  API key: " + (report.config.apiKey ?? "not set"));
      console.log("  Default device: " + (report.config.defaultDevice ?? "not set"));
      console.log("Target:");
      if (report.target.ok) {
        console.log("  " + report.target.deviceId + " (" + report.target.source + ", usable)");
      } else {
        console.log("  not connected: " + report.target.error);
      }
      console.log("Connections: " + connections.length);
      for (const connection of connections) {
        const reasons = connection.health.reasons.length
          ? " (" + connection.health.reasons.join("; ") + ")"
          : "";
        console.log(
          "  " + connection.deviceId + ": " + (connection.health.usable ? "usable" : "stale") + reasons
        );
      }
    });
}
