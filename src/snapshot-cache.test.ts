import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotDocument } from "./snapshot.js";

describe("cached snapshot foreground signatures", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "handheld-snapshot-cache-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  function snapshotWithIncompleteSignature(): SnapshotDocument {
    return {
      activity: "com.android.settings.Settings",
      backend: "tiny",
      bundleId: "com.android.settings",
      capturedAt: new Date(0).toISOString(),
      component: "com.android.settings/com.android.settings.Settings",
      deviceId: "device-1",
      eventSeq: 42,
      foregroundSignature: {
        bundleId: "com.android.settings",
        eventSeq: 42,
        layoutDigest: "layout-1",
      },
      layoutDigest: "layout-1",
      nodes: [],
      raw: {},
    };
  }

  it("restamps saved snapshots after foreground component fallback fills the top-level fields", async () => {
    const { compareForegroundSignatures, loadLastSnapshot, saveLastSnapshot } = await import(
      "./snapshot.js"
    );
    const snapshot = snapshotWithIncompleteSignature();

    saveLastSnapshot(snapshot);

    expect(snapshot.foregroundSignature).toEqual({
      activity: "com.android.settings.Settings",
      bundleId: "com.android.settings",
      component: "com.android.settings/com.android.settings.Settings",
      eventSeq: 42,
      layoutDigest: "layout-1",
    });
    const saved = JSON.parse(
      readFileSync(join(home, ".handheld", "snapshots", "device-1.json"), "utf8")
    ) as SnapshotDocument;
    expect(saved.foregroundSignature).toEqual(snapshot.foregroundSignature);

    const loaded = loadLastSnapshot("device-1");
    expect(
      compareForegroundSignatures({
        cached: loaded?.foregroundSignature,
        live: {
          component: "com.android.settings/com.android.settings.Settings",
          eventSeq: 43,
          layoutDigest: "layout-1",
        },
      })
    ).toEqual({ ok: true });
  });

  it("heals older caches whose foregroundSignature is present but missing component", async () => {
    const snapshotDir = join(home, ".handheld", "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "device-1.json"),
      JSON.stringify(snapshotWithIncompleteSignature(), null, 2) + "\n"
    );

    const { loadLastSnapshot } = await import("./snapshot.js");

    expect(loadLastSnapshot("device-1")?.foregroundSignature).toEqual({
      activity: "com.android.settings.Settings",
      bundleId: "com.android.settings",
      component: "com.android.settings/com.android.settings.Settings",
      eventSeq: 42,
      layoutDigest: "layout-1",
    });
  });
});
