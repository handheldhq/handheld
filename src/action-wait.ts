import type { Connection, TinyState } from "./state.js";
import type { SnapshotOutput } from "./snapshot.js";
import {
  loadLastSnapshot,
  normalizeTinySnapshot,
  saveLastSnapshot,
  snapshotForOutput,
} from "./snapshot.js";
import {
  getTinySnapshot,
  getTinyStatus,
  waitTinyChange,
  waitTinyStable,
  type TinyChangeWaitOptions,
  type TinyStableWaitOptions,
} from "./tiny-helper.js";

// Transport-agnostic Tiny access for the settle path. Both direct HTTP
// (connection.tiny) and the relay/adb device-shell channel implement this, so
// beginActionWait/finishActionWait settle on a digest regardless of transport —
// not just when there's a direct Tiny endpoint.
export interface TinyReader {
  // False when the a11y event-counter probe (/status) is a costly extra
  // round-trip (the relay device-shell). beginActionWait then skips it and
  // settles on the filter-independent layout digest directly.
  eventCounterCheap: boolean;
  snapshot(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  waitChange(opts: TinyChangeWaitOptions): Promise<Record<string, unknown>>;
  waitStable(opts: TinyStableWaitOptions): Promise<Record<string, unknown>>;
}

/** Direct-HTTP Tiny reader (a forwarded local endpoint: emulator or ADB tunnel). */
export function directTinyReader(tiny: TinyState): TinyReader {
  return {
    eventCounterCheap: true,
    snapshot: () => getTinySnapshot(tiny),
    status: () => getTinyStatus(tiny),
    waitChange: (opts) => waitTinyChange(tiny, opts),
    waitStable: (opts) => waitTinyStable(tiny, opts),
  };
}

// Cap for the stability phase. This runs only after a change is confirmed, so
// it just rides out a transition's tail — it must not burn seconds on screens
// that never go fully quiet (text fields with a blinking cursor, live search
// suggestions, spinners), where the digest never lands two equal samples and
// the wait would otherwise run to timeout. Settle returns early (~200-300ms)
// on screens that do settle.
const DEFAULT_SETTLE_TIMEOUT_MS = 1_200;
const DEFAULT_FALLBACK_SLEEP_MS = 600;
const DEFAULT_QUIET_MS = 200;
const DEFAULT_SAMPLES = 2;
const DEFAULT_MIN_NODES = 1;
// How long to watch for the action's effect to begin before concluding it was
// a no-op. Real transitions record events within this window (often already by
// the time we ask), so they return early; only genuine no-ops pay the full
// window. Keeps settle from declaring "stable" on the pre-transition screen.
const DEFAULT_CHANGE_WINDOW_MS = 500;

export interface ActionWaitOptions {
  changeWindowMs?: number;
  enabled?: boolean;
  fallbackSleepMs?: number;
  minNodes?: number;
  // When true, capture the settled post-action snapshot and return it on the
  // result so callers don't need a separate `snap` round-trip.
  postState?: boolean;
  quietMs?: number;
  samples?: number;
  timeoutMs?: number;
}

export interface ActionWaitResult {
  backend: "tiny" | "sleep" | "none";
  // Did the action actually move the UI? Server-side settle (/v2/input?settle)
  // reports this directly; the client-side path conveys a no-op via reason.
  changed?: boolean;
  error?: string;
  ok: boolean;
  reason?: string;
  // The post-action snapshot, present only when `postState` was requested and
  // the capture succeeded. Settle helpers lift this to the result's top level.
  snapshot?: SnapshotOutput;
  stable?: boolean;
  waitedMs: number;
}

interface ActionWaitContext {
  changeWindowMs: number;
  deviceId?: string;
  fallbackSleepMs: number;
  minNodes: number;
  postState?: boolean;
  previousDigest?: string;
  quietMs: number;
  reader?: TinyReader;
  samples: number;
  since?: number;
  timeoutMs: number;
}

export function parseSettleMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("settle must be a non-negative number of milliseconds");
  }
  return Math.round(parsed);
}

export function actionWaitOptionsFromCli(opts: Record<string, unknown>): ActionWaitOptions {
  const settle = opts.settle;
  return {
    enabled: settle !== false,
    postState: opts.postState === true,
    timeoutMs: parseSettleMs(settle),
  };
}

export async function beginActionWait(
  connection: Connection | null | undefined,
  opts: ActionWaitOptions = {},
  reader?: TinyReader
): Promise<ActionWaitContext | null> {
  if (opts.enabled === false || opts.timeoutMs === 0) return null;

  const context: ActionWaitContext = {
    changeWindowMs: opts.changeWindowMs ?? DEFAULT_CHANGE_WINDOW_MS,
    deviceId: connection?.deviceId,
    fallbackSleepMs: opts.fallbackSleepMs ?? DEFAULT_FALLBACK_SLEEP_MS,
    minNodes: opts.minNodes ?? DEFAULT_MIN_NODES,
    postState: opts.postState,
    quietMs: opts.quietMs ?? DEFAULT_QUIET_MS,
    samples: opts.samples ?? DEFAULT_SAMPLES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
  };

  // An explicit reader (relay/adb device-shell) wins; otherwise build a direct
  // reader from connection.tiny. No reader at all => the sleep fallback.
  const r = reader ?? (connection?.tiny ? directTinyReader(connection.tiny) : undefined);
  if (!r) return context;

  // Pre-action baseline from the last snapshot the CLI cached (typically the
  // `snap` the caller just took). Lets the stability phase require the screen to
  // actually differ from before the action, so settle doesn't return on the
  // pre-transition screen when a tap opens a new Activity (R1), and lets us
  // confirm a "no a11y event" report is a real no-op (digest-diff, #2). We use
  // the *layout* digest: filter-independent, so it's comparable no matter what
  // filter the cached snapshot used (#1) — the action/tree digests are not. It
  // also masks volatile content (clocks) like actionDigest (R8). Free local
  // read; absent (older snapshot / no cache) disables the gate (no regression).
  let previousDigest: string | undefined;
  try {
    previousDigest = connection?.deviceId
      ? loadLastSnapshot(connection.deviceId)?.layoutDigest
      : undefined;
  } catch {
    previousDigest = undefined;
  }

  // The a11y event counter is the fast no-op signal, but probing it (/status) is
  // an extra round-trip. Over the relay device-shell that's expensive, so skip
  // it (since=undefined) and settle on the layout digest; do it only for cheap
  // (direct) readers.
  if (!r.eventCounterCheap) {
    return { ...context, previousDigest, reader: r };
  }
  try {
    const status = await r.status();
    const eventSeq = status.eventSeq;
    return {
      ...context,
      previousDigest,
      reader: r,
      since: typeof eventSeq === "number" ? eventSeq : undefined,
    };
  } catch {
    // /status failed — keep the reader; the digest settle below can still run
    // (and fall back to sleep if the reader is genuinely unreachable).
    return { ...context, previousDigest, reader: r };
  }
}

export async function finishActionWait(
  context: ActionWaitContext | null
): Promise<ActionWaitResult | undefined> {
  if (!context) return undefined;
  const wait = await computeWait(context);
  // Post-state is best-effort: the action already succeeded, so a failed
  // snapshot capture must not turn the result into a failure — just omit it.
  if (!context.postState || !context.reader || !context.deviceId) return wait;
  try {
    return { ...wait, snapshot: await capturePostStateSnapshot(context.reader, context.deviceId) };
  } catch {
    return wait;
  }
}

async function capturePostStateSnapshot(
  reader: TinyReader,
  deviceId: string
): Promise<SnapshotOutput> {
  const raw = await reader.snapshot();
  const snapshot = normalizeTinySnapshot({ deviceId, raw });
  // Refresh the cached snapshot so subsequent ref-based actions resolve against
  // the post-action screen, not the pre-action one.
  saveLastSnapshot(snapshot);
  // Keep read-only text in the post-action snapshot (results/errors/headings the
  // caller verifies against); `interactive: true` would drop it.
  return snapshotForOutput(snapshot, { interactive: false });
}

/**
 * Did the layout digest move off the pre-action baseline? A change is confirmed
 * only when both digests are present and differ — a missing/empty digest (older
 * snapshot, failed capture) yields `false` so we never manufacture a false
 * change. Pure + exported for tests.
 */
export function layoutChanged(baseline: string | undefined, current: unknown): boolean {
  return (
    typeof baseline === "string" && baseline.length > 0 &&
    typeof current === "string" && current.length > 0 &&
    current !== baseline
  );
}

/**
 * Confirm a real change against the filter-independent layout digest. Used when
 * the a11y event counter reports nothing (it is silent for apps that emit no
 * a11y scroll/nav events): a fresh snapshot whose layout digest differs from the
 * baseline means the screen really moved. Best-effort: any failure → false.
 */
async function layoutDiffersFromBaseline(context: ActionWaitContext): Promise<boolean> {
  if (!context.previousDigest || !context.reader) return false;
  try {
    const raw = await context.reader.snapshot();
    return layoutChanged(context.previousDigest, raw.layoutDigest);
  } catch {
    return false;
  }
}

async function computeWait(
  context: ActionWaitContext
): Promise<ActionWaitResult> {
  const startedAt = Date.now();

  if (context.reader) {
    try {
      // Phase 1: confirm the action actually moved the UI before settling, so
      // waitForStable doesn't report the *pre-transition* screen as stable
      // during the lull before an animation starts (F1). The a11y event counter
      // is the fast signal — but it's SILENT for apps that don't emit a11y
      // scroll/nav events, so "no events" alone is not "no change" (#2). When it
      // reports no events, confirm against the filter-independent layout digest
      // before declaring a no-op; only a digest that also matches the baseline
      // is a true no-op.
      if (context.since !== undefined) {
        const change = await context.reader.waitChange({
          since: context.since,
          timeoutMs: context.changeWindowMs,
        });
        if (change.changed === false && !(await layoutDiffersFromBaseline(context))) {
          return {
            backend: "tiny",
            changed: false,
            ok: true,
            reason: "no-change",
            stable: true,
            waitedMs: Date.now() - startedAt,
          };
        }
      }

      // Phase 2: the screen is moving — wait for it to settle (fast path: no
      // digest requirement, so dynamic pages that render progressively don't
      // get punished).
      let stable = await context.reader.waitStable({
        minNodes: context.minNodes,
        quietMs: context.quietMs,
        samples: context.samples,
        since: context.since,
        timeoutMs: context.timeoutMs,
      });

      // Phase 3 (only if the fast settle landed on the *pre-action* screen):
      // wait specifically for the digest to differ from before the action.
      // Gates on the *layout* digest — filter-independent, so this compare can't
      // drift across snapshots taken with different filters (#1) — and masks
      // volatile content so it still settles (R8). Skipped on normal
      // navigations where the new screen already shows.
      if (
        context.previousDigest &&
        typeof stable.layoutDigest === "string" &&
        stable.layoutDigest === context.previousDigest
      ) {
        stable = await context.reader.waitStable({
          digest: "layout",
          minNodes: context.minNodes,
          previousDigest: context.previousDigest,
          quietMs: context.quietMs,
          requireDigestChange: true,
          samples: context.samples,
          since: context.since,
          timeoutMs: context.timeoutMs,
        });
      }
      return {
        backend: "tiny",
        changed: typeof stable.digestChanged === "boolean" ? stable.digestChanged : undefined,
        ok: stable.stable !== false,
        reason: typeof stable.reason === "string" ? stable.reason : undefined,
        stable: stable.stable !== false,
        waitedMs: Date.now() - startedAt,
      };
    } catch (err) {
      await sleep(context.fallbackSleepMs);
      return {
        backend: "sleep",
        error: (err as Error).message,
        ok: true,
        // The wait request failed — most often because the device-side settle
        // overran the client abort budget under load, not because Tiny is gone.
        // Don't mislabel it as "tiny-unavailable" (F2).
        reason: isAbortError(err) ? "wait-timeout" : "tiny-error",
        waitedMs: Date.now() - startedAt,
      };
    }
  }

  await sleep(context.fallbackSleepMs);
  return {
    backend: "sleep",
    ok: true,
    reason: "fallback",
    waitedMs: Date.now() - startedAt,
  };
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "AbortError" || name === "TimeoutError") return true;
  return typeof message === "string" && /abort/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
