import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the pure helpers real; stub only the network-backed Tiny calls.
vi.mock("./tiny-helper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tiny-helper.js")>();
  return {
    ...actual,
    getTinyStatus: vi.fn(),
    getTinySnapshot: vi.fn(),
    waitTinyChange: vi.fn(),
    waitTinyStable: vi.fn(),
  };
});

// Hermetic: no real cached-snapshot file read for the pre-action digest, and
// no real cache write — capture saveLastSnapshot to assert what gets cached.
vi.mock("./snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./snapshot.js")>();
  return { ...actual, loadLastSnapshot: vi.fn(() => null), saveLastSnapshot: vi.fn() };
});

import {
  beginActionWait,
  finishActionWait,
  layoutChanged,
  parseSettleMs,
} from "./action-wait.js";
import {
  getTinySnapshot,
  getTinyStatus,
  tinyRequestTimeoutMs,
  tinyWaitForStablePath,
  waitTinyChange,
  waitTinyStable,
} from "./tiny-helper.js";
import { loadLastSnapshot, saveLastSnapshot } from "./snapshot.js";
import type { Connection } from "./state.js";

const getTinyStatusMock = vi.mocked(getTinyStatus);
const getTinySnapshotMock = vi.mocked(getTinySnapshot);
const waitTinyChangeMock = vi.mocked(waitTinyChange);
const waitTinyStableMock = vi.mocked(waitTinyStable);
const loadLastSnapshotMock = vi.mocked(loadLastSnapshot);
const saveLastSnapshotMock = vi.mocked(saveLastSnapshot);

function baseline(layoutDigest: string): void {
  loadLastSnapshotMock.mockReturnValue({ layoutDigest } as never);
}

function connectionWithTiny(): Connection {
  return {
    deviceId: "emu",
    sessionId: "local",
    padCode: "",
    adb: { serial: "emulator-5554", sshPid: 0, tunnelPort: 0 },
    tiny: {
      baseUrl: "http://127.0.0.1:6792",
      port: 6792,
      status: "ready",
    },
    connectedAt: "1970-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  getTinyStatusMock.mockReset();
  getTinySnapshotMock.mockReset();
  waitTinyChangeMock.mockReset();
  waitTinyStableMock.mockReset();
  loadLastSnapshotMock.mockReset();
  loadLastSnapshotMock.mockReturnValue(null);
  saveLastSnapshotMock.mockReset();
  getTinyStatusMock.mockResolvedValue({ eventSeq: 5 });
});

describe("post-action settle waits", () => {
  it("parses settle milliseconds", () => {
    expect(parseSettleMs(undefined)).toBeUndefined();
    expect(parseSettleMs("250")).toBe(250);
    expect(parseSettleMs(0)).toBe(0);
    expect(() => parseSettleMs("-1")).toThrow("settle");
  });

  it("builds Tiny stable wait query params", () => {
    expect(tinyWaitForStablePath({
      minNodes: 1,
      quietMs: 150,
      samples: 2,
      since: 42,
      timeoutMs: 1_500,
    })).toBe("/v2/waitForStable?minNodes=1&quietMs=150&samples=2&since=42&timeoutMs=1500");
  });

  it("serializes change-gating params when requested", () => {
    expect(tinyWaitForStablePath({ since: 42, minEvents: 1, requireDigestChange: true }))
      .toBe("/v2/waitForStable?minEvents=1&since=42&requireDigestChange=true");
  });

  it("serializes the layout digest kind for filter-independent settling", () => {
    expect(tinyWaitForStablePath({ since: 42, digest: "layout", requireDigestChange: true }))
      .toBe("/v2/waitForStable?since=42&requireDigestChange=true&digest=layout");
  });

  it("layoutChanged is true only when both digests are present and differ", () => {
    expect(layoutChanged("a", "b")).toBe(true);
    expect(layoutChanged("a", "a")).toBe(false);
    expect(layoutChanged(undefined, "b")).toBe(false);
    expect(layoutChanged("a", undefined)).toBe(false);
    expect(layoutChanged("a", "")).toBe(false);
    expect(layoutChanged("", "b")).toBe(false);
    expect(layoutChanged("a", 123)).toBe(false);
  });

  it("waits comfortably longer than the device timeout (F2)", () => {
    // Old budget was timeoutMs + 1000, which aborted under load. Must exceed
    // anything the device-side wait could take.
    expect(tinyRequestTimeoutMs({ timeoutMs: 1_500 })).toBeGreaterThanOrEqual(5_000);
    expect(tinyRequestTimeoutMs({ requestTimeoutMs: 42 })).toBe(42);
  });

  it("falls back to a short sleep when Tiny is unavailable", async () => {
    const beforeAction = await beginActionWait(null, {
      fallbackSleepMs: 1,
      timeoutMs: 10,
    });
    await expect(finishActionWait(beforeAction)).resolves.toMatchObject({
      backend: "sleep",
      ok: true,
      reason: "fallback",
    });
  });

  // F1: settle must not conclude on the pre-transition screen. When the action
  // moved the UI, it has to wait for stability, not return immediately.
  it("waits for stability after a change instead of returning on the old screen", async () => {
    waitTinyChangeMock.mockResolvedValue({ changed: true });
    waitTinyStableMock.mockResolvedValue({ stable: true, reason: "samples" });

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    const result = await finishActionWait(before);

    expect(waitTinyChangeMock).toHaveBeenCalledOnce();
    expect(waitTinyStableMock).toHaveBeenCalledOnce();
    // The stable wait must be anchored to the pre-action baseline.
    expect(waitTinyStableMock.mock.calls[0]?.[1]).toMatchObject({ since: 5 });
    expect(result).toMatchObject({ backend: "tiny", stable: true, reason: "samples" });
  });

  // F1: genuine no-ops short-circuit without a full stable wait.
  it("short-circuits when the action changed nothing", async () => {
    waitTinyChangeMock.mockResolvedValue({ changed: false });

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    const result = await finishActionWait(before);

    expect(result).toMatchObject({ backend: "tiny", reason: "no-change", stable: true });
    expect(waitTinyStableMock).not.toHaveBeenCalled();
  });

  // #2: the a11y event counter is silent for apps that emit no a11y scroll/nav
  // events. "no events" must NOT be trusted as "no change" — confirm against the
  // filter-independent layout digest.
  it("does not declare a no-op when the event counter is silent but the layout digest moved", async () => {
    baseline("PRE");
    waitTinyChangeMock.mockResolvedValue({ changed: false });
    getTinySnapshotMock.mockResolvedValue({ layoutDigest: "POST" }); // really changed
    waitTinyStableMock.mockResolvedValue({ stable: true, reason: "quiet" });

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    const result = await finishActionWait(before);

    expect(getTinySnapshotMock).toHaveBeenCalledOnce(); // confirmed via layout digest
    expect(waitTinyStableMock).toHaveBeenCalledOnce(); // fell through to settle
    expect(result).toMatchObject({ backend: "tiny", reason: "quiet" });
  });

  // #2: a genuine no-op — no events AND the layout digest still matches.
  it("declares a no-op only when the layout digest also matches the baseline", async () => {
    baseline("PRE");
    waitTinyChangeMock.mockResolvedValue({ changed: false });
    getTinySnapshotMock.mockResolvedValue({ layoutDigest: "PRE" }); // unchanged

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    const result = await finishActionWait(before);

    expect(result).toMatchObject({ backend: "tiny", reason: "no-change", stable: true });
    expect(waitTinyStableMock).not.toHaveBeenCalled();
  });

  // #1: phase-3 re-settles on the *layout* digest (filter-independent) when the
  // fast settle landed on the pre-action screen.
  it("re-settles on the layout digest when the fast settle landed on the pre-action screen", async () => {
    baseline("PRE");
    waitTinyChangeMock.mockResolvedValue({ changed: true });
    waitTinyStableMock
      .mockResolvedValueOnce({ stable: true, reason: "quiet", layoutDigest: "PRE" }) // stale
      .mockResolvedValueOnce({ stable: true, reason: "samples", layoutDigest: "POST" });

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    await finishActionWait(before);

    expect(waitTinyStableMock).toHaveBeenCalledTimes(2);
    expect(waitTinyStableMock.mock.calls[1]?.[1]).toMatchObject({
      digest: "layout",
      previousDigest: "PRE",
      requireDigestChange: true,
    });
  });

  // Re-audit fix: --post-state must cache the SETTLED snapshot. The settle can
  // declare "stable" during a brief lull while a screen is still rendering async
  // content (storage sizes, search results), so a single capture here can store a
  // transient layoutDigest that no longer matches the screen by the next command
  // — which then fail-closes the printed refs as stale. capturePostStateSnapshot
  // must confirm the layout stopped moving before caching what it prints.
  it("post-state caches the settled snapshot, not a transient pre-settle digest", async () => {
    baseline("PRE");
    waitTinyChangeMock.mockResolvedValue({ changed: true });
    waitTinyStableMock.mockResolvedValue({ stable: true, reason: "samples", layoutDigest: "POST" });
    const node = {
      role: "button",
      text: "Navigate up",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      hittable: true,
    };
    // First post-state read is mid-render (TRANSIENT); the screen then settles.
    getTinySnapshotMock
      .mockResolvedValueOnce({ nodes: [node], layoutDigest: "TRANSIENT", component: "p/A", activity: "A" })
      .mockResolvedValue({ nodes: [node], layoutDigest: "SETTLED", component: "p/A", activity: "A" });

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1, postState: true });
    const result = await finishActionWait(before);

    expect(saveLastSnapshotMock).toHaveBeenCalledOnce();
    const cached = saveLastSnapshotMock.mock.calls[0]?.[0] as { layoutDigest?: string };
    expect(cached.layoutDigest).toBe("SETTLED");
    expect(result?.snapshot).toBeDefined();
  });

  // F2: an aborted/timed-out wait is not "tiny-unavailable".
  it("labels an aborted wait as a timeout, not Tiny being unavailable", async () => {
    waitTinyChangeMock.mockResolvedValue({ changed: true });
    const abort = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    waitTinyStableMock.mockRejectedValue(abort);

    const before = await beginActionWait(connectionWithTiny(), { fallbackSleepMs: 1 });
    const result = await finishActionWait(before);

    expect(result).toMatchObject({ backend: "sleep", ok: true, reason: "wait-timeout" });
    expect(result?.reason).not.toBe("tiny-unavailable");
  });
});
