import type { Command } from "commander";
import { HandheldApiClient } from "../api-client.js";

export function registerDevicesCommand(program: Command): void {
  const devices = program
    .command("devices")
    .description("list cloud phone profiles/devices (needs an API key); --status <state> to filter")
    .option("--status <status>", "filter by status (running, stopped, etc.)")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld devices [--status <state>] [--json]
  handheld devices reboot <deviceId> [--idempotency-key <key>]

Examples:
  handheld devices                       # list every cloud profile and its status
  handheld devices --status running      # only running devices
  handheld devices reboot prof_abc123    # enqueue a hardware reboot job

Caveats:
  - Lists CLOUD phones via the Gateway — needs an API key (\`handheld login\` or HANDHELD_API_KEY). It does not list local adb devices; for those use \`adb devices\`.
  - The first column is the profile/device id you pass to \`handheld connect <deviceId>\`.
  - \`reboot\` is async: it returns a jobId; the device cycles out of 'running' briefly.`
    )
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
        console.error("Hint: this command needs an API key — run `handheld login` (or set HANDHELD_API_KEY). For local devices use `adb devices` instead.");
        process.exit(1);
      }
    });

  devices
    .command("reboot")
    .description("enqueue an async hardware reboot job for a Gateway profile/device (returns a jobId)")
    .argument("<deviceId>", "profile/device ID to reboot")
    .option("--idempotency-key <key>", "idempotency key for safe retries")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld devices reboot <deviceId> [--idempotency-key <key>]

Examples:
  handheld devices reboot prof_abc123
  handheld devices reboot prof_abc123 --idempotency-key reboot-2026-06-01

Caveats:
  - Needs an API key. The deviceId is a profile id from \`handheld devices\`, not a local adb serial.
  - Reboot is async — it returns a jobId and status; poll \`handheld devices\` for the device to come back.
  - Pass --idempotency-key so a retried reboot doesn't enqueue a second job.`
    )
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
        console.error("Hint: needs an API key (`handheld login`); confirm the deviceId with `handheld devices` (it must be a Gateway profile id, not an adb serial).");
        process.exit(1);
      }
    });
}
