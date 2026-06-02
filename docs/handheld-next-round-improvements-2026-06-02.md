# Handheld CLI — Next-Round Improvements (merged from two cloud gauntlets)

**Date:** 2026-06-02
**Inputs:** two independent fix-verification gauntlets run against `fea4b8d` ("harden agent loop H1/H2/H3/M2/L2"), both on **true cloud phones over the relay** (relay-only, no direct ADB), different targets:
- Gauntlet A (`jx76cmbmwsf58m4gwbyfzar8r587x9zb`, "fixverif-cloud") — source-traced; recovered notes in `/tmp/hh-cloud-gauntlet/pre-overwrite-doc-recovered.md`.
- Gauntlet B (`jx7629q6ndtp5fe7k3z83mn5wn87x6cz` + secondary) — isolated temp `$HOME`; report at `docs/handheld-fix-verification-cloud-2026-06-02.md`, evidence `/tmp/hh-cloud-gauntlet/*.txt`.

**Confidence convention:** **[CORROBORATED]** = both gauntlets independently reproduced it (high confidence). **[A]/[B]** = single-source.

> Both runs changed no CLI source. Repo health at time of testing: `tsc` clean, `vitest` 143 passed.

---

## Merged verdict table

| Fix | Merged verdict | Confidence | Next-round priority |
|-----|----------------|-----------|---------------------|
| H1 default routing | PARTIAL — clean `Not connected.` for no-record paths; **dead/stale connection record → unhandled crash** | [CORROBORATED] | **P0** |
| H2 stale refs | PARTIAL/REGRESSED — only `back/home/recent/menu` guarded; `open-app`, off-CLI nav, `press-key back`, `--no-settle` exploitable (exit 0 mis-tap, sometimes mis-navigates) | [CORROBORATED] | **P0** |
| M2 phantom buttons | PARTIAL — zero-height culled, but **real-bounds title-less culled row still renders & mis-opens** (tapped → Battery) | [CORROBORATED] (B reproduced tap→Battery; A saw transient variant) | **P1** |
| H3 sent-but-unsettled | HELD on the false-failure (no `Tap failed` recurred); warning branch unproven live; **latent send-vs-settle false-positive** | [CORROBORATED] (false-failure absent) + [A] (false-positive risk) | **P1** |
| L2 read-only hint | HELD | [CORROBORATED] | — |
| M1 whitespace trim | NOT CLEANLY RECONFIRMED — dirty local Tiny APK confound; fix appears in-progress in worktree | [CORROBORATED] | **P1 (verify+commit)** |
| push/pull on relay | CONFIRMED gap — `pull` ADB-only (clean error); `push` unregistered | [CORROBORATED] | **P2** |
| L1 stale-session prune | Unfixed; now *causes* the P0 crash | [CORROBORATED] | **P1** |

---

## P0 — H1: never let a stale/dead connection crash a command

**Problem.** With a connection *record* present in `connections.json` whose relay daemon/socket is dead (offline relay, daemon exited, machine slept, server-side session expired), any bare/`--device`/env command crashes:
```
node:events:487  throw er; // Unhandled 'error' event
Error: connect ENOENT …/.handheld/sockets/<id>.sock
    at PipeConnectWrap.afterConnect (node:net:1705:16)        EXIT 1, raw stack, no Hint
```
A malformed record (missing `adb`) instead throws `Cannot read properties of undefined (reading 'serial')`. **[CORROBORATED]** (A on `jx76cmbm`/`DEADdev123`, B on restored `jx73tk44…` offline relay). This is *worse* than the original "Session must be active" — it's an uncaught exception, the worst outcome for an autonomous loop.

**What already HELD (don't regress):** `connect` sets `config.default-device`; `disconnect` clears it; the bare loop targets the default over relay; precedence `--device > HANDHELD_DEVICE > config.default-device`; no-record paths give the clean `Not connected.` + Hint; the old gateway leak is gone. **[CORROBORATED]**

**Root cause** (`src/commands/control.ts:180-206`): no `--device`/env ⇒ `getActiveConnection()` returns the lingering dead record; `relayState.connected && socketPath` ⇒ `new RelayDaemonTransport(socketPath)` ⇒ `requestRelayDaemon(socketPath)` (line 119) connects the dead socket and the socket's `'error'` event is **never caught**; `conn.adb.serial` (line 199) throws if `adb` is absent.

**Fix.**
1. Wrap the daemon-socket connect (`requestRelayDaemon`/`RelayDaemonTransport`) — on `ENOENT`/`ECONNREFUSED`/connect failure, treat the connection as not-live: emit the standard `Not connected.` + Hint and exit 1 (no stack trace).
2. Validate socket liveness before trusting persisted `relay.connected` (stat the `.sock`, or attempt-and-catch), and **prune** the dead record (ties into L1).
3. Guard `conn.adb?.serial` (and any other record-shape assumptions) so a malformed record degrades to `Not connected.`, not a TypeError.
4. **Decide semantics for a bogus explicit default with another live connection** — today bare `snap` silently falls back to the first live connection [B]. Prefer: an *explicitly set* default that resolves to no live session should fail clean, not silently retarget.

**Acceptance.** Unit/integration: a `connections.json` whose `socketPath` points to a missing `.sock` (and one missing `adb`) ⇒ bare, `--device`, and `HANDHELD_DEVICE` all produce `Not connected.` + Hint, exit 1, **zero** stack traces. Live: restore a stopped cloud session's record ⇒ clean error.

---

## P0 — H2: replace name-scoped cache-clear with a foreground-signature guard

**Problem.** The fix clears the cache only for `back/home/recent/recents/menu`. Every other screen change leaves the cache stale and `tap @eN` acts on stale coordinates with **exit 0, no warning** — and it genuinely mis-navigates, not just no-ops. **[CORROBORATED]** vectors:
- `open-app <pkg>` → stale `@e9` opened a wrong Settings subpage [B], blind tap at stale coords [A].
- **Off-CLI** change (`shell am start …`, modeling app self-nav / async load / deep link / dialog auto-dismiss / notification) → stale tap, no foreground check [A][B]. *This is the brief's priority hole.*
- `press-key back` ≠ `back` (former doesn't clear cache) [A][B].
- `--no-settle` navigating gesture leaves the pre-action cache [A][B].

**Why the current fix is incomplete (mechanic, [A]):** settling gestures auto-recache the post-action snapshot (`server-settle.ts:128`, `action-wait.ts:208`), so `tap→tap` is incidentally safe — but anything with no settle (off-CLI, `--no-settle`) or no cache hook (`open-app`, `launch`, `press-key`) is not. A name-based guard can never cover off-CLI changes.

**Fix.** Stamp each cached snapshot with a **foreground signature** (Tiny already returns `activity`; add package + top window/task id). At `@eN` resolution, compare the cached signature to the live foreground (one cheap Tiny read, or piggyback on the next snapshot/status); on divergence, **refuse** `@eN` with `Hint: screen changed since last snap — run snap first (or use an id=/label= selector)`. This subsumes and replaces the per-command `clearLastSnapshot` calls. Keep `id=`/`label=` as the fail-safe path and nudge agents toward them in the guide.

**Acceptance.** Each of {`open-app`, off-CLI `am start`, `press-key back`, `--no-settle` nav} followed by `tap @eN` ⇒ exit 1 fail-safe with the screen-changed hint; `id=`/`label=` still resolve on the live screen; the `tap→tap` settling path still works without a spurious refusal.

---

## P1 — M2: don't render real-bounds title-less actionable rows

**Problem.** Zero-height phantoms are culled (HELD), but a **partially-visible row whose title/subtitle were culled** still renders as an actionable, title-less button — and tapping it navigates. **[CORROBORATED]** (B: `@e18 Button [actions=[press] bounds=0,1241,720,1280]` → tap opened **Battery**, the label sat just below the cull boundary; A: transient 11px `@e24`). Also `--all` exposes zero-width off-screen actionable controls (e.g. deskclock `@e33 …bounds=1584,433,1584,865`) [B].

**Fix.** When a row's title-bearing children are culled but the parent button retains on-screen bounds, **hoist the title** from the culled children so it renders `@eN Button "Battery" …`; OR cull the parent too when its title is unavailable / its center lies outside the scrollable viewport. Never surface an actionable row with no title in the default view. Apply the same zero-area guard to width as to height (the `--all` zero-width case).

**Acceptance.** Scroll Settings to fold-straddle offsets repeatedly ⇒ no title-less actionable row in the default snap (each row is either titled or culled); tapping the bottom-most visible row hits what its title says.

---

## P1 — H3: disambiguate send-time vs settle-time abort; prove the warning branch

**Problem 1 (latent false-positive, [A], source).** `server-settle.ts:92` reports **any** `AbortError`/`TimeoutError`/`/timeout/` as "gesture WAS sent → `settleInconclusive` (exit 0)". `failedBeforeReachingDevice()` (line 85) only catches *known* pre-device failures. A generic abort while the request is in flight **before the device executes the gesture** is misreported as a successful "sent" gesture. Over a high-latency/degraded relay (sessions died mid-run in both gauntlets) this is exactly when a *send* stalls — i.e. when the gesture is least likely to have fired.

**Problem 2 (observability, [CORROBORATED]).** Neither gauntlet could force the `Action sent; settle inconclusive — re-snap to verify` branch live (the 6 s client margin over the 1200 ms settle absorbed relay latency; Chrome a11y bounds are throttled so webview animation didn't churn the device-side digest). The false-failure regression is gone — but the new branch is only proven by unit test, not on-device.

**Fix.** Have the device-side `/input` return a distinct **inject-ack** (gesture-fired timestamp) separate from the settle result, so the client can tell `fired-but-unsettled` (→ `settleInconclusive`, exit 0) from `never-acked` (→ safe to fall back to the client dispatch path, or report not-sent). Add a deterministic test surface (e.g. a Tiny test endpoint or a known never-settling activity) to exercise the warning branch on-device in CI/gauntlet.

**Acceptance.** A send aborted before device inject is **not** reported as sent; a settle-only abort after a confirmed inject yields `settleInconclusive` exit 0 with no double-fire; the warning string is reproduced at least once on a real device.

---

## P1 — L1 → enable stale-session pruning (prerequisite for clean P0)

**Problem.** Dead cloud sessions linger in `status`/`connections.json` for days with no prune path **[CORROBORATED]**; these stale records are precisely what triggers the P0 crash.

**Fix.** Add `handheld status --prune` (or `disconnect --stale`/auto-prune on resolve) that drops records whose relay socket is unreachable and whose session is stopped server-side. Auto-prune-on-resolve also closes P0.

**Acceptance.** After a session dies, `status --prune` removes it; subsequent bare commands give clean `Not connected.`

---

## P1 — M1: verify and commit the in-progress Tiny whitespace fix

**Problem.** The worktree is dirty with a locally-rebuilt Tiny (`assets/tiny-snapshot-helper.apk`, `android/.../SetTextService.java`). Both gauntlets saw whitespace **preserved**, but that reflects the *already-fixed local* Tiny, **not** the `fea4b8d` deferred baseline — so M1 is **not cleanly reconfirmed** [CORROBORATED]. The deferred fix may effectively be done but uncommitted.

**Fix.** On a clean committed Tiny baseline, confirm the original trim repros; confirm the `SetTextService.java` change fixes leading/trailing trim (internal already preserved); commit the APK + source together; then re-run the M1 check against the committed build.

**Acceptance.** Clean-baseline Tiny reproduces the trim; post-fix Tiny preserves leading/trailing/internal whitespace via `setText` over relay; APK and source committed in one change.

---

## P2 — push/pull on relay-only cloud

**Problem.** `pull` is ADB-only → clean exit-1 + hint on relay; `push` is unregistered (`too many arguments`) **[CORROBORATED]**. Maintainer is scoping a gateway file route separately.

**Fix.** Register `push`; route both `push`/`pull` through the gateway file mechanism when on a relay-only connection; keep the ADB fast path for local. Until then, keep the current clean error (don't crash).

**Acceptance.** `push`/`pull` succeed on a relay-only cloud device via the gateway; local stays ADB.

---

## P2 — Snapshot robustness over relay

- **Transient `Unterminated string in JSON at position 4096`** on a busy/repainting screen, not reproducible [A] — likely a chunked-relay reassembly race; a parse failure silently leaves a stale cache (feeds H2). Harden chunk reassembly; on parse failure, retry rather than leave stale cache.
- **Intermittent partial/empty snapshots on continuously-relayouting webviews** [A], cascading into `id=`/`@eN` resolution failures. Add a "snapshot looked partial/empty" signal (or auto-retry-until-nonempty) so agents don't act on a truncated tree.

---

## Methodology for the next gauntlet (carry forward)

1. **Isolate state:** run all connection/default-device abuse under a temp `$HOME` (as Gauntlet B did), never the shared `~/.handheld`.
2. **Clean Tiny baseline:** ensure `assets/tiny-snapshot-helper.apk` is committed/clean before any M1 check; otherwise M1 results are invalid.
3. **Respect target constraints:** don't drive a target the user flags as busy.
4. **For H3:** pre-stage a deterministic never-settling device surface (a Tiny test mode or a known activity) — synthetic webview churn does not move the device-side `layoutDigest`.
5. **Capture exit codes without pipe artifacts** (`cmd >out 2>&1; echo $?`, not `cmd | tail`).

---

## Suggested sequencing

1. **P0 H1 crash-proofing** + **L1 prune** (same area; ship together — stops uncaught crashes immediately).
2. **P0 H2 signature guard** (highest-leverage correctness fix for the agent loop).
3. **P1 M2 title hoist/cull**, **P1 M1 commit**, **P1 H3 inject-ack**.
4. **P2** push/pull gateway route + snapshot robustness.
