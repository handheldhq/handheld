# Handheld CLI — Adversarial Stress Test Report

**Date:** 2026-06-02
**Build under test:** `dist/cli.js` built from `master` @ `5e68417` (the 6 unpushed commits: lean CUA snap, durable selectors, in-CLI guide, richer help/error hints) via `pnpm build`.
**Goal:** Drive the `snap → act → verify` loop through complex, multi-step, real-world flows; find where it breaks; measure timings.

> This is a TEST pass. No behavior was changed and nothing was pushed. One stray contact and a few search queries were created on the emulator and discarded; no source edits were made.

---

## 1. Environment

- **Device:** `emulator-5558` (local Android emulator the user was watching). `emulator-5554` was present in `adb devices` but left untouched.
- **OS / hardware:** Android 13 / **API 33**, 1080×2400, `sdk_gphone64_arm64`. (Note: API 33, so the `uiautomator dump` fallback is *available* here — the API-36 "Tiny is the only path" risk was not in play.)
- **Network:** the emulator has **no external internet** (`DNS_PROBE_*` on every live URL). The live-Wikipedia heavy-DOM test was therefore replaced by a locally-served 600-link page reached over the emulator host alias `http://10.0.2.2:8799/`.
- **Repo health:** `npx tsc --noEmit` clean; `npx vitest run` → **138 passed / 2 skipped**, 20 files, exit 0.

---

## 2. What was exercised

All nine requested stress dimensions, plus an action-command smoke pass:

1. Deep navigation — Settings → Network & internet → Internet → AndroidWifi → Network details (4 levels) and back out.
2. Forms & text entry — focus by `id=`/`label=`/`@eN`, `type`, `--append`, `--submit`, non-ASCII/emoji, long-string, internal/leading/trailing spaces, search-as-you-type, keyboard collapse.
3. Long lists & scrolling — `[N more below]` hint, scroll direction semantics, reach bottom, deep-item-by-selector.
4. Webview-heavy — 800-node local page in Chrome; snap latency/size across flags; inline link taps by `label=`.
5. Ref staleness & recovery — stale `@eN` reuse, read-only `text=` rejection.
6. Rapid sequences / races — back-to-back taps, tap-immediately-after-nav, `--settle` vs `--no-settle`.
7. Multi-window — status bar, IME, AlertDialog.
8. Error paths — unresolvable target, never-connected, disconnected, Tiny down.
9. Known suspects — fold-straddling RecyclerView rows, pass-through containers, `--all` keyboard expansion, screenshot JPEG.

---

## 3. Timings

Warm = Tiny resident and the screen already settled. All on `emulator-5558`.

### Snapshot latency

| Scenario | Latency |
|---|---|
| `snap` warm — Settings home (108 nodes) | ~300 ms |
| `snap` warm — heavy webview (800 nodes) | ~810 ms (first after a11y populates ~1.35 s) |
| `snap -i` heavy | ~670 ms |
| `snap --all` heavy | ~750 ms |
| `snap --raw` heavy | ~1340 ms |
| `snap` self-heal after Tiny force-stop | ~3.2 s |
| `snap` cold (Tiny data cleared, process cold-start) | ~4.3 s |

### Actions

| Action | Latency |
|---|---|
| `tap`/`type` `--no-settle` | ~280 ms |
| `tap` + settle, light screen | 0.96–2.0 s |
| `back` + settle | 2.0–4.0 s |
| `type` + settle, typical warm search | ~510 ms |
| `type` + settle, **cold first search query** (worst case) | ~4.17 s (settle-dominated) |
| `screenshot` JPEG (default) | ~660 ms (344 KB) |
| `screenshot` PNG (`--format png`) | ~1.15 s (414 KB) |
| `connect --local` (Tiny APK already installed) | ~370 ms |
| End-to-end 10-step drill+back flow | ~15.5 s (settle-dominated) |

### Snapshot output size (the lean-format payoff)

| View | Settings home (108 nodes) | Heavy webview (800 nodes) |
|---|---|---|
| `snap` (default) | 18 lines / 1.3 KB | 73 lines / 2.8 KB |
| `snap -i` | 14 lines / 1.1 KB | 30 lines / 1.6 KB |
| `snap --offscreen` | 54 lines / 2.6 KB | 494 lines / 18.5 KB |
| `snap --all` | 110 lines / 5.3 KB | 802 lines / 39 KB |
| `snap --raw` | 3,504 lines / 95 KB | 25,493 lines / **670 KB** |

**Takeaway:** the lean default is ~75× smaller than `--raw` on a light screen and **~236× smaller** on a heavy webview. Agents must never run `--raw`/`--json` on a heavy page — it is a context killer. The default format is the right tool and holds up well under load.

---

## 4. Findings (by severity)

Severity legend: **HIGH** = silent wrong result / breaks the documented path; **MEDIUM** = data fidelity or misleading output with a workaround; **LOW** = cosmetic/UX.

### HIGH

#### H1 — Bare commands (the documented loop) hit a hint-less "Session must be active" error; `connect --local` doesn't make the device the default
The guide's CORE LOOP is `connect → snap → … → disconnect` with **no `--device`**. But `connect --local emulator-5558` does **not** set the default device, and the default-device resolution path routes through a **cloud-session code path** that demands an active session.

Isolated root cause (same device, same disconnected state, different routing):
```
node dist/cli.js --device emulator-5558 snap   # exit 1: "Not connected." + recovery Hint   ✓
node dist/cli.js snap                            # exit 1: "Getting Tiny installed… / Session
                                                 #          must be active before runtime commands"  ✗  no Hint
```
So whenever the configured default isn't a live session — a stale cloud default, or a just-disconnected local device — the **bare** command (exactly what the guide tells agents to run) yields the worst, hint-less, cloud-flavored error. The explicit `--device` path is correct.

- **Repro of the first-contact failure:** with `config.defaultDevice` pointing anywhere else, `connect --local emulator-5558` reports success, then `snap` prints `Session must be active before runtime commands` and exits 1.
- **Fix:** route default-device resolution identically to `--device` — check the live session and emit `Not connected.` + Hint when none, instead of assuming cloud. One fix covers both symptoms.
- **Workaround:** `handheld config set default-device <serial>` after connect, or pass `--device` on every call.

#### H2 — Stale `@eN` ref silently mis-taps wrong coordinates after an off-CLI screen change
A stale ref whose *number no longer exists* errors cleanly (good). But a stale ref that still has a number resolves against the on-disk cached snapshot's **stored coordinates** and taps blindly — no check that the cached screen still matches the live foreground. `back` (and presumably any non-snap navigation) does **not** invalidate the cache.

Airtight, coordinate-level repro:
```
open-app settings
tap 'label=Network & internet'        # screen B
snap --bounds                          # @e48 "VPN" bounds=0,1783,1080,1989 (center ~540,1886)
back                                   # back to Settings home — cache STILL = screen B
tap @e48                                # exit 0
snap                                   # landed on BATTERY ("100 %"), not VPN
```
On the home screen, y≈1886 falls inside "Battery" (0,1694,1080,1925), so the tap opened Battery. **Exit 0, no warning, wrong screen.**

- **Why it matters:** a silent wrong action with a success exit code is the worst failure mode for an autonomous loop. Docs say "never act on a stale ref," but there is zero guard.
- **Fix:** stamp each cached snapshot with the foreground activity/window signature (the daemon already reads it) and refuse `tap @eN` with a Hint when the live foreground diverges. Push agents toward `id=`/`label=` selectors, which re-resolve and fail safe (see PASS P2).

#### H3 — Successful taps report "Tap failed: This operation was aborted" (exit 1) on continuously-repainting screens
On any screen whose `layoutDigest` never stabilizes (webviews, spinners, video, live content), the server-side input-with-settle round-trip outlives the client abort budget. Per `src/server-settle.ts:82-85`, a post-send abort is deliberately not re-dispatched (to avoid a double-fire) and is surfaced as **"Tap failed: This operation was aborted"** + exit 1 — even though the gesture already executed.

Airtight proof the tap fired anyway (button with a visible click counter, served locally):
```
snap            # - Text "NOT-CLICKED"
tap 'label=PRESS ME'
   → Tap failed: This operation was aborted     EXIT 1
snap            # - Text "CLICKED-1"   ← the tap DID fire
```
Reproducibility: ~2 of 3 settle-taps abort on the 800-node page; `--no-settle` succeeded 3/3 (the abort is purely in the settle).

- **Consequences:** false negative (success reported as failure); retry-on-failure → **double-fire** (verified: 3 tap commands → CLICKED-3) — the exact double-fire the logic tries to prevent, now *caused* by the misleading error. The error also has **no `Hint:` line**, unlike the other structured errors.
- **Fix:** distinguish "action failed" from "action sent, settle inconclusive." On a post-send settle abort the gesture is known-sent — report `tap sent; settle timed out (screen still changing) — re-snap to verify` with exit 0 (or a distinct non-error code). The client-dispatch fallback already maps abort→`wait-timeout` gracefully (`action-wait.ts:324-326`); the server-settle path should match.

### MEDIUM

#### M1 — Leading/trailing whitespace is silently stripped from typed text
`type` (both replace and `--append`) drops leading and trailing spaces before they reach the device. **Internal whitespace is preserved.** Verified on two apps + screenshot, so it is not an app-level InputFilter.

```
# Contacts → Create contact → First name
type '@e42' "     LEAD"        # 5 leading spaces
snap --json | grep value       # "value":"LEAD"    (spaces gone; screenshot confirms flush-left)

type "AAA"; type 'id=…' " BBB" --append   →   field = "AAABBB"   (expected "AAA BBB")
```
`src/text-entry.ts` passes the text through untrimmed and `control.ts:1702-1704` joins argv with `" "` (preserves a single arg's spaces), so the strip is in the device-side Tiny `setText`/paste handler. Internal spaces surviving means it's a `trim()`, not whitespace-collapse.

- **Impact:** silent corruption when spacing is intentional (passwords, append-joining a space-separated token, deliberate indentation). A verify against the (also-trimmed) snapshot won't reveal the intent drift.
- Evidence: `docs/assets/stress-2026-06-02/F4a-leading-space-stripped.png`.

#### M2 — Fold-straddling RecyclerView row rendered as a title-less, zero-height, un-tappable Button
On the Settings home list, the last "on-screen" actionable node is:
```
- @e57 Button [actions=[press]]       # lean snap shows NO title
   bounds=0,2387,1080,2387             # zero height, y=2387, BELOW the scroll viewport (ends 2337)
```
`--all` reveals `@e57` is the **"Display"** row (children `Image`, `Text "Display"`, `Text "Dark theme…"`). Three problems from one node:
1. **Title-less noise** — the real title ("Display") was culled with the off-screen children and never hoisted to the parent button.
2. **No-op tap with success exit** — `tap @e57` → exit 0 but does not navigate; its center (540, 2387) is below the visible area, so the tap lands in dead space.
3. **Un-targetable + duplicated** — `tap 'label=Display'` → exit 1 "did not resolve" (label culled), yet "Display" also appears in the `[25 more below — scroll: "Display", …]` hint. The same row is both a title-less on-screen button and the first off-screen hint item.

- **Fix:** cull nodes that are zero-height or whose center is outside the scrollable viewport (treat as off-screen), or hoist the title from culled children so it reads `@e57 Button "Display"` and stays tappable. The correct agent action (`scroll down` first) isn't signaled today.

### LOW

- **L1** — `status` lists 3 stale cloud sessions (`Relay: offline / ADB: none (dead)`) lingering for days, with no obvious prune command. Noise.
- **L2** — Read-only `text=`/`label=` targets are correctly rejected (good), but the Hint is the generic "refs renumber… use a durable id=/label=/text= selector" — misleading when you *were* using `text=`. A truer Hint: "matched a read-only/non-actionable node."
- **L3** — Observed once, not reproducible: `tap 'label=Network & internet'` returned exit 0 without navigating while Settings was resumed atop Chrome/Contacts in a busy task stack. Clean `force-stop`+relaunch always navigates. Flagged for a maintainer; possible resume-frame/settle-cache interaction.
- **L4** — `@e21 Button` (child of `search_action_bar`) and similar single-child pass-through containers are shown as actionable; lower impact than M2 since the real target (`@e20`) is labeled.

---

## 5. What works well (PASS)

- **P1 — Lean snap format.** Massive, well-behaved compression (§3). `▶` focused marker, `[other window · pkg]` grouping (systemui, IME), `[keyboard open · … (~N keys)]` collapse with a `--all` expansion to real key nodes (`@e45 Button "q" [id=key_pos_0_0]`), `[N more below — scroll: …]` off-screen hint — all correct.
- **P2 — Durable selectors fail SAFE.** Tapping `label=Internet` before re-snapping correctly errors ("did not resolve") instead of mis-tapping — the safe counterpart to H2. `id=`/`label=`/`text=` resolve actionable nodes and reject read-only text.
- **P3 — Scrolling.** `scroll down` reveals below, `up` reveals above, the `[N more below]` count decrements and clears at the bottom; deep-item-by-selector works after scrolling.
- **P4 — Text fidelity (except M1).** Non-ASCII/emoji exact (`Café ☕ naïve 日本語 🚀`); long strings have **no dropped chars** (atomic `setText`, so fast typing is safe); internal multi-spaces preserved; search-as-you-type populates live.
- **P5 — Resilience.** Tiny self-heals on the next snap after a force-stop (~3.2 s); never-connected devices and missing fields produce clean errors with recovery Hints (`paste` with nothing focused is a model example).
- **P6 — Webview support.** Inline web links/buttons are addressable by `label=`; webview content surfaces once Chrome builds its (lazy) a11y tree — re-snap/wait, as the guide already advises.
- **P7 — Action surface.** `tap`/`long_press`/`double_tap`/`swipe`/`scroll`/`press_key`/`back`/`home`/`copy`/`paste`/`open-app` all exit 0 and behave; AlertDialog buttons are inline and actionable by `id=`.

### Not verified on this device
- **System runtime-permission dialog** (`permissioncontroller`): couldn't be triggered (Chrome geolocation errored without prompting; system apps pre-granted; no internet). Dialog handling is validated via AlertDialog + window grouping, but the dedicated permission-window grouping case is unconfirmed.
- **`recent`/app-switcher** snapshots: returned the underlying app, not the overview — matches the documented "may not settle" gotcha. Use `open-app` to switch (verified reliable).
- **Live 500–600+ node web page** over real internet: substituted with a local 800-node page (no emulator internet).

---

## 6. Prioritized recommendations

1. **Fix default-device routing (H1).** Make bare commands resolve and error exactly like `--device`: emit `Not connected.` + Hint when no live session, and have `connect --local` set the default device (or auto-target the single connected local device). This unblocks the *documented* loop and removes the worst error message. Highest leverage.
2. **Guard stale `@eN` taps (H2).** Stamp snapshots with the foreground activity/window signature; refuse `tap @eN` with a Hint when the live foreground diverges. Lead snap output with, or nudge toward, `id=`/`label=` selectors.
3. **Stop reporting sent-but-unsettled taps as failures (H3).** On a post-send settle abort, return success with a "settle inconclusive — re-snap" note (and a `Hint:`), not "Tap failed" + exit 1. Prevents false negatives and retry-induced double-fires on every web/animated screen.
4. **Don't silently trim typed whitespace (M1).** Either preserve leading/trailing spaces end-to-end or document the trim explicitly; at minimum make append composition (`"AAA" + " BBB"`) faithful.
5. **Clean up fold-straddling rows (M2).** Cull zero-height / below-viewport nodes or hoist their titles, so the lean snap never shows a title-less button that no-ops on tap.
6. **Polish (L1–L4):** add a `status --prune`/cleanup for dead sessions; tailor the not-actionable Hint; consider collapsing single-child pass-through buttons.

---

## 7. Summary

The core `snap → act → verify` loop is fast and the lean snapshot format is excellent — ~300 ms snaps, 75–236× smaller than raw, with a clear, well-structured tree (focused marker, window grouping, keyboard collapse, off-screen hints). Durable selectors fail safe, text fidelity is strong (UTF-8/emoji/long strings), Tiny self-heals, and most error paths carry actionable Hints. Typecheck is clean and 138 tests pass.

Three HIGH issues undercut autonomous reliability, and all three share a theme — **a real action or state is misreported with a success/known exit code, or the documented path lands on the wrong code path**:
- **H1**: the documented bare-command loop hits a hint-less cloud-session error whenever the default isn't live (root-caused to default-device routing).
- **H2**: a stale `@eN` silently taps wrong coordinates with exit 0 (no foreground guard).
- **H3**: successful taps on web/animated screens report "Tap failed" + exit 1, inviting double-fires.

Plus two MEDIUM fidelity/clarity issues (M1 whitespace trim, M2 zero-height phantom button). None are crashes; all are about an agent being told something that isn't true. Fixing H1–H3 — especially making misreported states honest and routing default commands like explicit ones — would materially harden the agent loop.

*Evidence and raw logs collected under `/tmp/hh-stress/` during the run; key screenshots in `docs/assets/stress-2026-06-02/`.*
