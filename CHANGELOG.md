# Changelog

## [Unreleased]

- `connect` now persists relay/ADB state before Tiny helper warmup, so follow-up commands keep working if Tiny startup fails or is interrupted.
- Relay refresh now updates the cached session id when Gateway rolls a device to a new active session, and upload/install paths resolve the active session instead of forcing stale local state.
- `connect --webrtc-only` now recycles an active Gateway session when its relay room has already gone inactive, instead of requiring a manual disconnect/reconnect.
- Cloud `connect` now checks/starts/installs the on-device Tiny helper even for relay-only WebRTC sessions, using the Gateway session upload path before snapshots/input need it.
- `status` accepts a positional device id (`handheld status <deviceId>`) in addition to the root `--device` option and `HANDHELD_DEVICE` env fallback.

- Release metadata now points at the public handheldhq/handheld repository, and the npm package ships the linked install/agent-space docs.
- The default Gateway API URL is now https://api.handheld.sh instead of the legacy api.mobileuse.dev host.

- `init --local` now honors `--local-serial`, then the root `--device` flag, then `HANDHELD_DEVICE` for device selection (mirrors `run` and the env the root `--device` flag documents) — a pinned device "just works" instead of erroring on multi-device.
- The multi-device "Multiple adb devices" error now names the command you ran: `init` points at `handheld init --local --local-serial <serial>` (was: always `handheld connect --local <serial>`, which `init` rejects as a positional arg). Docs (README + install.md local sections) now show `--local-serial` for the multi-device case.
- `status` (disconnected) hint now points local users at `handheld connect --local [serial]` instead of framing local adb as "advanced dev/CI only".
- Docs: clarify `current-app` prints `package/activity` in text mode (the `{packageName, activity, component}` object is `--json`-only); note that a focused field's typed text may surface as its title (not the `= "value"` slot) and that an empty focused field is filtered from the compact snapshot.

- `snap --offscreen`: when used, the footer now explains that off-screen list rows are recycled by Android (not in the tree) and points to `scroll` (more rows) and `--all` (folded structural containers) — `--offscreen` only un-culls in-tree below-fold nodes, which surprised agents expecting it to reveal a long list. Docs (README snapshot format) rewritten to set the right mental model: `--all` reveals the `shown/total` gap, `scroll` loads recycled rows.
- Docs: document `snap --screenshot-output <file>` next to `--screenshot` (which otherwise writes `handheld-screenshot-<ts>.jpg` to CWD); add `current-app` to the main Device control list.

- Fix: `@eN`/`id=`/`label=` targets no longer fail "stale" when only the layout drifted on the same screen (clock tick, async content, the settle tail of `--post-state`) — handheld re-resolves the target against a fresh snapshot by identity (stableId / selector) and dispatches against its current position; only a real navigation to a different screen still fails closed. This makes a `@eN` ref printed by a `--post-state` action resolve on the very next command.
- Fix: `--post-state` waits for the layout to actually settle before caching, so the snapshot (and refs) it prints match the live screen.
- Action commands that don't print a snapshot (`tap`, `open-app`, `back`/`home`/`recent`, `swipe`, `long-press`, …) now acknowledge success in text mode with `ok` (or `ok (no UI change)` for a detected no-op), so success is distinguishable from a silent failure. `--json`/`--post-state` output is unchanged.
- `snap --json` no longer embeds each node's verbose `raw` Tiny blob (~1KB/node); the normalized fields remain. Use `snap --raw` for the full unprocessed dump. The MCP `snap` tool is slimmed the same way (`raw: true` still returns the full document).
- `list-apps --json` now returns `[{package, label}]` objects (was bare package-id strings); `label` is a best-effort name (open-app alias or package leaf). Text mode is unchanged (one package id per line).
- Docs: note that the first local `connect --local` bootstraps the Tiny helper (~30s, one-time); enumerate the built-in `open-app` aliases; document the same-screen drift recovery for refs/selectors.
