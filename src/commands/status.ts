import type { Command } from "commander";
import { getAuthorizationHeaders } from "../auth.js";
import { getConnections, getRelayState } from "../state.js";
import { probePort } from "../transport/adb/tunnel.js";
import { RelayClient } from "../transport/relay/client.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("show active connections and transport health")
    .action(async () => {
      const json = program.opts().json;
      const connections = getConnections();

      if (connections.length === 0) {
        if (json) console.log(JSON.stringify({ connections: [] }));
        else console.log("No active connections. Run `handheld connect <device-id>` first.");
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
