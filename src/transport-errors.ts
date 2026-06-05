// Pure transport-error predicates. Kept dependency-free (no state/tiny-helper
// imports) so connect.ts, control.ts, and server-settle.ts can all share them
// without dragging heavy modules into each other's graphs (which would break
// tests that mock ../state.js).

/**
 * A relay/live session the provider reports "active" but whose bridge/live token
 * has expired or whose uuid desynced ("live token expired", uuid mismatch,
 * "session already exited"). The connect flow re-mints a fresh session; the
 * relay command path refreshes the bridge token in place and retries.
 */
export function isStaleSessionError(error: string | undefined): boolean {
  if (!error) return false;
  // Relay WS upgrade rejections surface only the HTTP status via the `ws` lib
  // ("Unexpected server response: 401/400") — an expired/invalid bridge token
  // looks exactly like this. Connect-time rejection means the command never
  // reached the device, so a refresh + retry is safe (idempotent).
  if (/unexpected server response:\s*40[0-3]\b/i.test(error)) return true;
  return /uuid|绑定|不一致|invalid live token|live token expired|session (?:has |is )?(?:already )?(?:exited|expired|ended|not active|invalid)|live token|already exited/i.test(
    error
  );
}
