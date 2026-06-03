# Changelog

## [Unreleased]

- `snap --offscreen`: when used, the footer now explains that off-screen list rows are recycled by Android (not in the tree) and points to `scroll` (more rows) and `--all` (folded structural containers) — `--offscreen` only un-culls in-tree below-fold nodes, which surprised agents expecting it to reveal a long list. Docs (README snapshot format) rewritten to set the right mental model: `--all` reveals the `shown/total` gap, `scroll` loads recycled rows.
- Docs: document `snap --screenshot-output <file>` next to `--screenshot` (which otherwise writes `handheld-screenshot-<ts>.jpg` to CWD); add `current-app` to the main Device control list.

- Fix: `@eN`/`id=`/`label=` targets no longer fail "stale" when only the layout drifted on the same screen (clock tick, async content, the settle tail of `--post-state`) — handheld re-resolves the target against a fresh snapshot by identity (stableId / selector) and dispatches against its current position; only a real navigation to a different screen still fails closed. This makes a `@eN` ref printed by a `--post-state` action resolve on the very next command.
- Fix: `--post-state` waits for the layout to actually settle before caching, so the snapshot (and refs) it prints match the live screen.
- Action commands that don't print a snapshot (`tap`, `open-app`, `back`/`home`/`recent`, `swipe`, `long-press`, …) now acknowledge success in text mode with `ok` (or `ok (no UI change)` for a detected no-op), so success is distinguishable from a silent failure. `--json`/`--post-state` output is unchanged.
- `snap --json` no longer embeds each node's verbose `raw` Tiny blob (~1KB/node); the normalized fields remain. Use `snap --raw` for the full unprocessed dump. The MCP `snap` tool is slimmed the same way (`raw: true` still returns the full document).
- `list-apps --json` now returns `[{package, label}]` objects (was bare package-id strings); `label` is a best-effort name (open-app alias or package leaf). Text mode is unchanged (one package id per line).
- Docs: note that the first local `connect --local` bootstraps the Tiny helper (~30s, one-time); enumerate the built-in `open-app` aliases; document the same-screen drift recovery for refs/selectors.
