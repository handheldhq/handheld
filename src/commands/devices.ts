import type { Command } from "commander";
import { HandheldApiClient } from "../api-client.js";

export function registerDevicesCommand(program: Command): void {
  const devices = program
    .command("devices")
    .description("list available cloud phone devices")
    .option("--status <status>", "filter by status (running, stopped, etc.)")
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.listDevices();
        const rawDevices = result.devices ?? [];

        const normalized = rawDevices.map((entry: any) => {
          const dev = entry.device ?? entry;
          return {
            activeSessionId: dev.activeSessionId ?? dev.activeSession?.id ?? null,
            deviceId: dev.deviceId ?? dev.profileId ?? dev.id ?? "",
            status: dev.status ?? "",
            displayName: dev.displayName ?? "",
            session: entry.activeSession ?? null,
          };
        });

        const filtered = opts.status
          ? normalized.filter((d: any) => d.status === opts.status)
          : normalized;

        if (json) {
          console.log(JSON.stringify(filtered, null, 2));
        } else {
          if (filtered.length === 0) {
            console.log("No devices found.");
            return;
          }
          console.log(
            `${"PROFILE ID".padEnd(22)} ${"STATUS".padEnd(12)} ${"SESSION".padEnd(22)} ${"NAME"}`
          );
          console.log("-".repeat(80));
          for (const d of filtered) {
            console.log(
              `${d.deviceId.padEnd(22)} ${d.status.padEnd(12)} ${(d.activeSessionId || "-").padEnd(22)} ${d.displayName || ""}`
            );
          }
        }
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });

  devices
    .command("reboot")
    .description("enqueue a hardware reboot job for a Gateway profile/device")
    .argument("<deviceId>", "profile/device ID to reboot")
    .option("--idempotency-key <key>", "idempotency key for safe retries")
    .action(async (deviceId: string, opts: { idempotencyKey?: string }) => {
      const json = program.opts().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.rebootDevice(deviceId, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Reboot job: ${result.jobId} (${result.status})`);
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }
    });
}
