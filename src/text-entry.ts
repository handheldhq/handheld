import { isSnapshotTarget, normalizeSnapshotTarget } from "./device-actions.js";
import { loadLastSnapshot, resolveSnapshotRef } from "./snapshot.js";
import type { TinyState } from "./state.js";
import { getTinySnapshot, tinySetText } from "./tiny-helper.js";

/**
 * Whether a focused, editable field is present right now. Lets actions that
 * target "the focused field" (paste into focus, type with no ref) fail honestly
 * when nothing is focused instead of silently no-opping. Best-effort: if Tiny
 * can't be read, returns true rather than blocking an action that might work.
 */
export async function hasFocusedEditableField(tiny: TinyState | undefined): Promise<boolean> {
  if (!tiny) return true;
  try {
    const raw = await getTinySnapshot(tiny);
    const nodes = Array.isArray(raw.nodes)
      ? (raw.nodes as Array<Record<string, unknown>>)
      : [];
    return nodes.some((node) => node.focused === true && node.editable === true);
  } catch {
    return true;
  }
}

/**
 * Outcome of attempting text entry through Tiny semantic setText:
 * - `{ ok: true }`            setText succeeded.
 * - `{ ok: false, reason }`   setText reached Tiny but it rejected the request
 *                             (e.g. `target_not_found` — nothing focused).
 * - `null`                    setText could not be attempted (no stableId for a
 *                             ref, or Tiny errored/unavailable) — the caller
 *                             should fall back to key injection.
 */
export type TinyTypeResult = { ok: true } | { ok: false; reason: string } | null;

// Right after navigating to a new screen the target field often isn't focused
// for a few hundred ms (the Activity/IME is still coming up). Rather than fail
// the first time setText reports `target_not_found`, briefly retry so a field
// that is about to focus is caught — turning the race into a bounded wait.
const DEFAULT_FIELD_WAIT_MS = 1_200;
const FIELD_RETRY_INTERVAL_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Set text via Tiny's semantic setText (ACTION_SET_TEXT) — the deterministic
 * alternative to `adb input text` / relay key injection, which drops characters
 * into a field that has just gained focus (e.g. right after navigation).
 *
 * Resolves a snapshot ref to its stableId (the device auto-focuses it); a
 * missing target falls back to the device's focused field. While the target is
 * not yet present (`target_not_found`), retries until `waitForFieldMs` elapses.
 *
 * Replace (default) uses semantic ACTION_SET_TEXT. Append uses paste mode
 * (clipboard + ACTION_PASTE at the cursor) — semantic is replace-only, and
 * paste-append is deterministic where `adb input text` is not.
 */
export async function typeViaTinySetText(input: {
  append?: boolean;
  deviceId: string;
  target?: string;
  text: string;
  tiny: TinyState;
  waitForFieldMs?: number;
}): Promise<TinyTypeResult> {
  let stableId: string | undefined;
  if (input.target && isSnapshotTarget(input.target)) {
    const snapshot = loadLastSnapshot(input.deviceId);
    const node = snapshot
      ? resolveSnapshotRef(snapshot, normalizeSnapshotTarget(input.target))
      : null;
    if (!node?.stableId) return null;
    stableId = node.stableId;
  }
  const setTextOpts = input.append
    ? ({ mode: "paste", clear: "append" } as const)
    : ({ mode: "semantic", clear: "replace" } as const);
  const deadline = Date.now() + (input.waitForFieldMs ?? DEFAULT_FIELD_WAIT_MS);
  for (;;) {
    let result: Record<string, unknown>;
    try {
      result = await tinySetText(input.tiny, { ...setTextOpts, stableId, text: input.text });
    } catch {
      return null;
    }
    if (result.ok === true) return { ok: true };
    const reason = typeof result.reason === "string" ? result.reason : "set_text_failed";
    // Only "no target yet" is worth waiting on; any other rejection is terminal.
    if (reason !== "target_not_found" || Date.now() >= deadline) {
      return { ok: false, reason };
    }
    await sleep(FIELD_RETRY_INTERVAL_MS);
  }
}
