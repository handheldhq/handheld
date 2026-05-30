import type { ActionWaitResult } from "./action-wait.js";
import {
  normalizeTinySnapshot,
  saveLastSnapshot,
  snapshotForOutput,
  type SnapshotOutput,
} from "./snapshot.js";
import type { Connection } from "./state.js";
import { tinyInput, type TinyInputOptions } from "./tiny-helper.js";

/**
 * Did a transport/HTTP failure happen *before* the op could reach the device?
 * Only then is re-dispatching the op safe (it never executed). Connection-setup
 * / "no transport" errors qualify; a post-send timeout/abort does not. Lives
 * here so the gesture-settle path and control.ts's adb fallback share one
 * definition (control.ts re-exports it for its tests).
 */
export function failedBeforeReachingDevice(error: string | undefined): boolean {
  if (!error) return false;
  // "invalid live token" / relay session-auth rejections happen at the relay
  // before the command reaches the device — the op never ran, so re-dispatch
  // (or client fallback) is safe.
  return /ECONNREFUSED|connection refused|not connected|no .*transport|relay (?:daemon )?(?:not|un|down)|daemon not running|ENOENT|EPIPE|socket hang up|connect ETIMEDOUT|invalid live token|session.*not active/i.test(
    error
  );
}

export interface ServerSettleOptions {
  enabled?: boolean;
  postState?: boolean;
  timeoutMs?: number;
}

export interface ServerSettleResult {
  ok: boolean;
  error?: string;
  snapshot?: SnapshotOutput;
  wait?: ActionWaitResult;
}

// Transport for the input-with-settle request. Default is a direct HTTP fetch
// to connection.tiny; the relay/adb path injects a sender that POSTs the same
// body over the device-shell channel (curl on-device -> Tiny localhost), so the
// settle logic + #5 no-double-fire handling stay in one place.
export type TinyInputSender = (input: TinyInputOptions) => Promise<Record<string, unknown>>;

/**
 * Try Tiny's server-side input-with-settle (/v2/input with settle:true): Tiny
 * injects the gesture AND settles on the filter-independent layoutDigest in one
 * round-trip — immune to the client-abort-under-load race a separate
 * dispatch+client-wait hits. Returns a settled result on success, or `null` to
 * signal "fall back to the client dispatch+wait path": when Tiny is absent,
 * settle is disabled, the helper lacks /input (old build), or the call failed
 * *before* the gesture executed. A post-injection timeout is NOT a fall-back —
 * the gesture may have already run on-device, and re-dispatching double-fires
 * it (#5); that surfaces as an error result instead.
 */
export async function tryServerSettle(
  connection: Connection,
  gesture: TinyInputOptions,
  opts: ServerSettleOptions,
  send?: TinyInputSender
): Promise<ServerSettleResult | null> {
  const tiny = connection.tiny;
  if (opts.enabled === false) return null;
  // Need either a direct Tiny endpoint or a device-shell sender (relay/adb).
  if (!send && !tiny) return null;

  const full: TinyInputOptions = {
    ...gesture,
    settle: true,
    ...(opts.timeoutMs !== undefined ? { settleTimeoutMs: opts.timeoutMs } : {}),
  };
  let resp: Record<string, unknown>;
  try {
    resp = send ? await send(full) : await tinyInput(tiny!, full);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Old helper (no /input route) or never reached the device — the gesture did
    // not execute, so the client path is a safe first attempt.
    if (/HTTP 404|not found/i.test(msg) || failedBeforeReachingDevice(msg)) return null;
    // Ambiguous (timeout/abort after the body was sent): may have executed. Do
    // NOT re-dispatch — surface an honest error instead (#5).
    return { ok: false, error: msg };
  }
  // inject rejected (bad args / 403 auth): gesture did not run; client path can
  // safely retry (and reclaim on 403).
  if (resp.ok !== true) return null;

  const settle = resp.settle && typeof resp.settle === "object"
    ? (resp.settle as Record<string, unknown>)
    : {};
  const result: ServerSettleResult = {
    ok: true,
    wait: {
      backend: "tiny",
      ok: true,
      reason: typeof settle.reason === "string" ? settle.reason : undefined,
      stable: settle.stable !== false,
      waitedMs: 0,
    },
  };
  // Cache the settled snapshot so ref-based follow-ups resolve against the
  // post-action screen; surface it when post-state was requested.
  const rawSnap = resp.snapshot;
  if (rawSnap && typeof rawSnap === "object" && connection.deviceId) {
    try {
      const snapshot = normalizeTinySnapshot({
        deviceId: connection.deviceId,
        raw: rawSnap as Record<string, unknown>,
      });
      saveLastSnapshot(snapshot);
      if (opts.postState) {
        result.snapshot = snapshotForOutput(snapshot, { interactive: true });
      }
    } catch {
      // snapshot shaping is best-effort — the gesture already succeeded
    }
  }
  return result;
}
