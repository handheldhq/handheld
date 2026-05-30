import type { Command } from "commander";
import { HandheldApiClient, type ProfileSnapshot, type SavedStateJob } from "../api-client.js";

export function registerSnapshotsCommand(program: Command): void {
  const snapshots = program
    .command("snapshots", { hidden: true })
    .description("list, capture, restore, and inspect profile saved-state snapshots");

  snapshots
    .command("list <profileId>")
    .description("list saved-state snapshots for a profile")
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
    .description("capture the profile's current saved-state head")
    .option("--idempotency-key <key>", "stable request id for retries")
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
    .description("restore the profile's latest saved-state head")
    .option("--equipment-id <id>", "explicit clean target equipment id")
    .option("--idempotency-key <key>", "stable request id for retries")
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
    .description("show a profile capture or restore job")
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
  process.exit(1);
}
