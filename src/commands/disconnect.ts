import type { Command } from "commander";
import { getConfig, getConnection, getConnections, removeConnection, setConfig } from "../state.js";
import { execAdb } from "../transport/adb/tunnel.js";
import { HandheldApiClient } from "../api-client.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pick which connection a bare `disconnect` targets. An explicit serial (the
 * positional arg or `--device`) always wins. Otherwise we only auto-resolve the
 * sole attached connection — with several attached we require an explicit serial
 * rather than guessing (or silently tearing down a configured default-device).
 */
export function resolveDisconnectTarget(
  explicit: string | undefined,
  deviceIds: string[]
): { deviceId: string } | { error: string } {
  if (explicit) return { deviceId: explicit };
  if (deviceIds.length === 1) return { deviceId: deviceIds[0]! };
  if (deviceIds.length === 0) return { error: "Not connected to any device." };
  return {
    error: `Multiple devices connected (${deviceIds.join(
      ", "
    )}). Pass one: handheld disconnect <device-id>`,
  };
}

export function registerDisconnectCommand(program: Command): void {
  program
    .command("disconnect [deviceId]")
    .description("tear down a connection (--all for every device); local: drops the forward, cloud: also stops the session")
    .option("--all", "disconnect from all devices")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld disconnect [deviceId]   # bare form auto-resolves the sole connection
  handheld disconnect --all        # tear down every attached device

Examples:
  handheld disconnect              # one device attached: tears it down
  handheld disconnect prof_abc123  # name the device when several are attached
  handheld disconnect --all        # disconnect everything

Caveats:
  - A bare \`disconnect\` only auto-picks when exactly one device is attached; with several, pass a deviceId or --all.
  - Local connections tear down on this host only (drop the Tiny forward); they never call the Gateway, so no API key is needed.
  - Cloud connections also stop the Gateway session — that requires a valid API key.
  - See currently attached devices with \`handheld status\`.`
    )
    .action(async (deviceId?: string, opts?: { all?: boolean }) => {
      const json = program.opts().json;
      if (opts?.all) {
        const connections = getConnections();
        const failures: Array<{ deviceId: string; error: unknown }> = [];
        let disconnected = 0;
        for (const conn of connections) {
          try {
            await teardown(conn.deviceId);
            disconnected += 1;
          } catch (error) {
            failures.push({ deviceId: conn.deviceId, error });
          }
        }
        if (failures.length > 0) {
          if (json) {
            console.log(JSON.stringify({
              disconnected,
              failures: failures.map((failure) => ({
                deviceId: failure.deviceId,
                error: errorMessage(failure.error),
              })),
              ok: false,
              total: connections.length,
            }));
          } else {
            for (const failure of failures) {
              console.error(
                `Failed to disconnect ${failure.deviceId}: ${errorMessage(failure.error)}`
              );
            }
            console.error(
              `Disconnected from ${disconnected} of ${connections.length} device(s).`
            );
          }
          process.exit(1);
        }
        if (json) {
          console.log(JSON.stringify({
            disconnected: connections.length,
            failures: [],
            ok: true,
            total: connections.length,
          }));
        } else {
          console.log(`Disconnected from ${connections.length} device(s).`);
        }
        return;
      }

      // Require an explicit serial UNLESS exactly one device is attached. A bare
      // `disconnect` auto-resolves only the sole connection (symmetric with an
      // auto-picked `connect --local`); with several attached we refuse to guess.
      const explicit = deviceId ?? (program.opts().device as string | undefined);
      const target = resolveDisconnectTarget(
        explicit,
        getConnections().map((c) => c.deviceId)
      );
      if ("error" in target) {
        if (json) console.log(JSON.stringify({ error: target.error, ok: false }));
        else {
          console.error(target.error);
          console.error("Hint: run `handheld status` to list attached connections, then pass a deviceId or use `handheld disconnect --all`.");
        }
        process.exit(1);
      }
      const resolvedDevice = target.deviceId;

      const conn = getConnection(resolvedDevice);
      if (!conn) {
        if (json) console.log(JSON.stringify({
          deviceId: resolvedDevice,
          error: `Not connected to ${resolvedDevice}`,
          ok: false,
        }));
        else {
          console.error(`Not connected to ${resolvedDevice}`);
          console.error("Hint: run `handheld status` to see attached devices; this one already has no live connection (nothing to tear down).");
        }
        process.exit(1);
      }

      try {
        await teardown(resolvedDevice);
      } catch (error) {
        if (json) {
          console.log(JSON.stringify({
            deviceId: resolvedDevice,
            error: errorMessage(error),
            ok: false,
          }));
        } else {
          console.error(`Failed to disconnect ${resolvedDevice}: ${errorMessage(error)}`);
          console.error("Hint: the local teardown still ran; retry, or stop the session in the dashboard if the Gateway call failed.");
        }
        process.exit(1);
      }
      if (json) console.log(JSON.stringify({ deviceId: resolvedDevice, ok: true }));
      else console.log(`Disconnected from ${resolvedDevice}`);
    });
}

export async function teardown(deviceId: string): Promise<void> {
  const conn = getConnection(deviceId);
  if (!conn) return;

  // If this was the default device, clear it so bare commands afterward report a
  // clean "Not connected." instead of resolving to a stale/removed connection.
  if (getConfig().defaultDevice === deviceId) setConfig({ defaultDevice: undefined });

  if (conn.adb?.sshPid) {
    try {
      process.kill(conn.adb.sshPid, "SIGTERM");
    } catch {}
  }

  if (conn.relay?.daemonPid) {
    try {
      process.kill(conn.relay.daemonPid, "SIGTERM");
    } catch {}
  }

  // Close in-process SSH tunnel if it exists
  const tunnels = (globalThis as any).__muTunnels as Map<string, { close: () => void }> | undefined;
  if (tunnels?.has(deviceId)) {
    tunnels.get(deviceId)!.close();
    tunnels.delete(deviceId);
  }

  // A local connection owns no Gateway session and no SSH-tunneled adb device:
  // just drop the Tiny port-forward and the saved connection. Calling the
  // Gateway here would needlessly require an API key and fail (no such device).
  const adbSerial = conn.adb?.serial;
  const adbTunnelPort = conn.adb?.tunnelPort ?? 0;
  if (conn.local) {
    if (adbSerial && adbTunnelPort) {
      try {
        execAdb(["-s", adbSerial, "forward", "--remove", `tcp:${adbTunnelPort}`]);
      } catch {}
    }
    removeConnection(deviceId);
    return;
  }

  // Disconnect adb
  if (adbSerial) {
    try { execAdb(["disconnect", adbSerial]); } catch {}
  }

  const api = new HandheldApiClient();
  await api.stopDevice(deviceId);

  removeConnection(deviceId);
}
