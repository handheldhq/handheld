import type { Command } from "commander";
import { HandheldApiClient, type ProfileSnapshot, type SavedStateJob } from "../api-client.js";

export function registerSnapshotsCommand(program: Command): void {
  const snapshots = program
    .command("snapshots", { hidden: true })
    .description(
      "manage Gateway PROFILE saved-state snapshots (disk-image state heads) — not UI/screen snapshots (that's `snap`)"
    )
    .addHelpText(
      "after",
      `
Profile saved-state snapshots are persisted disk-image state heads for a cloud
profile (capture/restore). For an on-screen UI tree, use \`handheld snap\` instead.

Subcommands:
  handheld snapshots list <profileId>
  handheld snapshots capture <profileId> [--idempotency-key <key>]
  handheld snapshots restore <profileId> [--equipment-id <id>] [--idempotency-key <key>]
  handheld snapshots job <profileId> <jobId>

Caveats:
  - All subcommands hit the Gateway and need an API key (\`handheld login\` / HANDHELD_API_KEY).
  - capture/restore are async and return a job — poll it with \`handheld snapshots job <profileId> <jobId>\`.`
    );

  snapshots
    .command("list <profileId>")
    .description("list a profile's saved-state snapshots (state heads), newest first")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld snapshots list <profileId> [--json]

Examples:
  handheld snapshots list prof_abc123
  handheld snapshots list prof_abc123 --json

Caveats:
  - <profileId> is a Gateway profile id (see \`handheld devices\`), and the command needs an API key.
  - This lists saved disk-state heads, not UI snapshots — for a screen tree use \`handheld snap\`.`
    )
    .action(async (profileId: string) => {
      const json = program.opts().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.listProfileSnapshots(profileId);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printSnapshots(result.snapshots);
      } catch (err) {
        fail(err);
      }
    });

  snapshots
    .command("capture <profileId>")
    .description("capture the profile's current saved-state head (async job; ~minutes for a full disk image)")
    .option("--idempotency-key <key>", "stable request id for retries")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld snapshots capture <profileId> [--idempotency-key <key>]

Examples:
  handheld snapshots capture prof_abc123
  handheld snapshots capture prof_abc123 --idempotency-key cap-2026-06-01

Caveats:
  - Needs an API key; <profileId> is a Gateway profile id from \`handheld devices\`.
  - Async — returns a job. Poll \`handheld snapshots job <profileId> <jobId>\`; a full disk-image capture takes minutes.
  - Pass --idempotency-key so a retry reuses the in-flight request instead of starting a second capture.`
    )
    .action(async (profileId: string, opts: { idempotencyKey?: string }) => {
      const json = program.opts().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.captureProfileSnapshot(profileId, {
          idempotencyKey: opts.idempotencyKey,
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printJob(result.job);
      } catch (err) {
        fail(err);
      }
    });

  snapshots
    .command("restore <profileId>")
    .description("restore the profile's latest saved-state head onto clean equipment (async job; ~minutes)")
    .option("--equipment-id <id>", "explicit clean target equipment id")
    .option("--idempotency-key <key>", "stable request id for retries")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld snapshots restore <profileId> [--equipment-id <id>] [--idempotency-key <key>]

Examples:
  handheld snapshots restore prof_abc123
  handheld snapshots restore prof_abc123 --equipment-id eq_xyz789

Caveats:
  - Needs an API key; <profileId> is a Gateway profile id from \`handheld devices\`.
  - Restores the LATEST captured head — run \`handheld snapshots list <profileId>\` first to confirm what that is.
  - Async — returns a job; poll \`handheld snapshots job <profileId> <jobId>\`. A full disk-image restore takes minutes.
  - Omit --equipment-id to let the Gateway pick a clean target; pass it to pin a specific one.`
    )
    .action(
      async (
        profileId: string,
        opts: { equipmentId?: string; idempotencyKey?: string },
      ) => {
        const json = program.opts().json;
        try {
          const api = new HandheldApiClient();
          const result = await api.restoreProfileSnapshot(profileId, {
            equipmentId: opts.equipmentId,
            idempotencyKey: opts.idempotencyKey,
          });
          if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          printJob(result.job);
          if (result.restore?.snapshotId) {
            console.log(`Snapshot: ${result.restore.snapshotId}`);
          }
        } catch (err) {
          fail(err);
        }
      },
    );

  snapshots
    .command("job <profileId> <jobId>")
    .description("poll a saved-state capture or restore job by id")
    .addHelpText(
      "after",
      `
Arg grammar:
  handheld snapshots job <profileId> <jobId>

Examples:
  handheld snapshots job prof_abc123 job_def456

Caveats:
  - Needs an API key. The <jobId> is the one returned by \`handheld snapshots capture\`/\`restore\`.
  - Re-run to poll: status moves through pending/running to a terminal state.`
    )
    .action(async (profileId: string, jobId: string) => {
      const json = program.opts().json;
      try {
        const api = new HandheldApiClient();
        const result = await api.getProfileSavedStateJob(profileId, jobId);
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printJob(result.job);
      } catch (err) {
        fail(err);
      }
    });
}

function printSnapshots(rows: ProfileSnapshot[]): void {
  if (rows.length === 0) {
    console.log("No snapshots found.");
    return;
  }
  console.log(
    `${"SNAPSHOT ID".padEnd(24)} ${"CREATED".padEnd(18)} ${"SIZE".padEnd(10)} ${"SESSION"}`
  );
  console.log("-".repeat(80));
  for (const snapshot of rows) {
    console.log(
      `${snapshot.id.padEnd(24)} ${formatTime(snapshot.createdAt).padEnd(18)} ${formatBytes(snapshot.sizeBytes).padEnd(10)} ${snapshot.sessionId ?? "-"}`
    );
  }
}

function printJob(job: SavedStateJob & { reusedRequest?: boolean }): void {
  console.log(`Job:     ${job.id}`);
  console.log(`Kind:    ${job.kind}`);
  console.log(`Status:  ${job.status}`);
  if (job.profileId) console.log(`Profile: ${job.profileId}`);
  if (job.reusedRequest) console.log("Replay:  reused idempotent request");
  if (job.updatedAt) console.log(`Updated: ${formatTime(job.updatedAt)}`);
}

function formatTime(ms?: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toISOString();
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return "-";
  const mb = value / 1_000_000;
  if (mb < 1000) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

function fail(err: unknown): never {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  console.error("Hint: needs an API key (`handheld login`); confirm the profileId with `handheld devices`. For an on-screen UI tree use `handheld snap`, not `snapshots`.");
  process.exit(1);
}
