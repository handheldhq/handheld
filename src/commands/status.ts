import type { Command } from "commander";
import { getAuthorizationHeaders } from "../auth.js";
import { getConnections, getRelayState } from "../state.js";
import { probePort } from "../transport/adb/tunnel.js";
import { RelayClient } from "../transport/relay/client.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("show active connections and transport health (relay + ADB liveness per device)")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld status [--json]

Examples:
  handheld status          # per-device: session, relay ready/offline, ADB serial + tunnel liveness
  handheld status --json   # same, structured (probes the relay live)

Caveats:
  - Reads locally saved connections — no API key needed. Empty output means nothing is attached: run \`handheld connect\`.
  - "Relay: offline" or ADB "(dead)" means the transport dropped; reconnect with \`handheld connect <deviceId>\` (or \`--local\`).`
    )
    .action(async () => {
      const json = program.opts().json;
      const connections = getConnections();

      if (connections.length === 0) {
        if (json) console.log(JSON.stringify({ connections: [] }));
        else {
          console.log("No active connections.");
          console.log("Hint: attach a cloud phone with `handheld connect <device-id>`, or a local adb device with `handheld connect --local`.");
        }
        return;
      }

      const statuses = await Promise.all(
        connections.map(async (conn) => {
          const tunnelAlive = conn.adb.tunnelPort
            ? await probePort(conn.adb.tunnelPort)
            : false;

          const relayState = getRelayState(conn);
          let relayStatus: Awaited<ReturnType<RelayClient["getStatus"]>> | null = null;
          if (relayState.connected && relayState.relayUrl) {
            const relay = new RelayClient(
              relayState.relayUrl,
              getAuthorizationHeaders()
            );
            try {
              relayStatus = await relay.getStatus();
            } catch {
              relayStatus = null;
            } finally {
              await relay.disconnect();
            }
          }

          return {
            connectedAt: conn.connectedAt,
            deviceId: conn.deviceId,
            relay: {
              relayStatus,
              url: relayState.relayUrl,
            },
            sessionId: conn.sessionId,
            adb: {
              port: conn.adb.tunnelPort,
              serial: conn.adb.serial,
              tunnelAlive,
            },
          };
        })
      );

      if (json) {
        console.log(JSON.stringify({ connections: statuses }, null, 2));
      } else {
        for (const status of statuses) {
          console.log(`${status.deviceId}`);
          console.log(`  Session: ${status.sessionId}`);
          console.log(`  Since:   ${status.connectedAt}`);
          console.log(
            `  Relay:   ${status.relay.relayStatus?.active ? "ready" : "offline"}`
          );
          console.log(
            `  ADB:     ${status.adb.serial || "none"} ${status.adb.tunnelAlive ? "(alive)" : "(dead)"}`
          );
        }
      }
    });
}
