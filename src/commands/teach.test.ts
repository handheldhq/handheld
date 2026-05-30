import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTeachId,
  findTrajectoryBundle,
  ingestBundle,
  type TeachEnvelope,
} from "./teach.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "teach-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildTeachId", () => {
  it("is a timestamp-slug-hex id derived from the objective", () => {
    const id = buildTeachId("Add a payee!!", new Date("2026-05-30T04:05:06.000Z"));
    expect(id).toMatch(/^20260530T040506Z-add-a-payee-[0-9a-f]{6}$/);
  });
});

describe("findTrajectoryBundle", () => {
  it("finds a mu-trajectory zip newer than since, ignoring others", () => {
    const dir = tmp();
    const now = Date.now();
    writeFileSync(join(dir, "mu-trajectory-dev1-1.zip"), "z");
    writeFileSync(join(dir, "unrelated.zip"), "z");
    writeFileSync(join(dir, "notes.txt"), "z");
    const found = findTrajectoryBundle({ dir, sinceMs: now - 60_000 });
    expect(found).toBe(join(dir, "mu-trajectory-dev1-1.zip"));
  });

  it("ignores bundles older than the session start", () => {
    const dir = tmp();
    const old = join(dir, "mu-trajectory-old.zip");
    writeFileSync(old, "z");
    const past = (Date.now() - 600_000) / 1000;
    utimesSync(old, past, past);
    // sinceMs is well after the file's mtime → not a match
    expect(findTrajectoryBundle({ dir, sinceMs: Date.now() })).toBeNull();
  });

  it("prefers a bundle whose name matches the deviceId", () => {
    const dir = tmp();
    const since = Date.now() - 60_000;
    // other device is newer, but the device-matching one should win
    writeFileSync(join(dir, "mu-trajectory-other-2.zip"), "z");
    writeFileSync(join(dir, "mu-trajectory-jx7abc-1.zip"), "z");
    const found = findTrajectoryBundle({ dir, sinceMs: since, deviceId: "jx7abc" });
    expect(found).toBe(join(dir, "mu-trajectory-jx7abc-1.zip"));
  });

  it("returns null when the dir is missing or has no bundle", () => {
    expect(findTrajectoryBundle({ dir: join(tmp(), "nope"), sinceMs: 0 })).toBeNull();
    expect(findTrajectoryBundle({ dir: tmp(), sinceMs: 0 })).toBeNull();
  });
});

describe("ingestBundle", () => {
  it("copies the bundle into the teach dir and marks the envelope ready", () => {
    const dir = tmp();
    const teachDir = join(dir, "session");
    mkdirSync(teachDir, { recursive: true });
    const src = join(dir, "mu-trajectory-dev1-1.zip");
    writeFileSync(src, "PK-fake-zip");
    const envelopePath = join(teachDir, "envelope.json");
    const env: TeachEnvelope = {
      schema: "handheld.teach.envelope.v1",
      teachId: "t1",
      objective: "demo",
      package: null,
      deviceId: "dev1",
      viewerUrl: "https://viewer",
      status: "waiting",
      createdAt: new Date().toISOString(),
      capturedAt: null,
      dir: teachDir,
      bundleZip: null,
      bundleDir: null,
      trajectoryPath: null,
    };
    writeFileSync(envelopePath, JSON.stringify(env));

    const out = ingestBundle({ envelopePath, env, sourceZip: src });

    expect(out.status).toBe("ready");
    expect(out.capturedAt).toBeTruthy();
    expect(out.bundleZip).toBe(join(teachDir, "bundle.zip"));
    expect(existsSync(join(teachDir, "bundle.zip"))).toBe(true);
    // The persisted envelope reflects the ready state.
    const persisted = JSON.parse(readFileSync(envelopePath, "utf-8")) as TeachEnvelope;
    expect(persisted.status).toBe("ready");
  });
});
