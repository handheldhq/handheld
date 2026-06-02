# Handheld CLI - Fix-Verification Gauntlet (Cloud Relay)

Date: 2026-06-02

Build under test: `dist/cli.js` built from `master` at/after `fea4b8d` with `pnpm build`. CLI source was not modified during this gauntlet. Caveat: the worktree still contains a dirty locally rebuilt Tiny APK from the earlier M1 whitespace fix, so M1 is not a clean `fea4b8d` Tiny baseline.

Cloud target policy: the busy target `jx76cmbmwsf58m4gwbyfzar8r587x9zb` was not used after the user correction. All target-specific evidence below is from replacement cloud targets.

Primary target: `jx7629q6ndtp5fe7k3z83mn5wn87x6cz`

- Session: `k578bks9t61hhy9r47g0xxz0wn87x6np`
- Connect result: `Relay: connected`, `ADB: not available for this device`
- Status result: `Relay: ready`, `ADB: none (dead)`
- Transport: true cloud phone over relay only, not local emulator and not direct ADB

Secondary target used only for H1 multi-device routing: `jx73tk44mvkwc4yenh9xdttghs87v4af`

- Session: `k57drnavay0smnz1dkqf3mz42x87w153`
- Connect result: `Relay: connected`, `ADB: not available for this device`
- Disconnected after H1 multi-device/stale-session checks

Config isolation: all connection/default-device abuse used temp home `/tmp/hh-cloud-gauntlet-home-Kht3uT`, not the shared `~/.handheld`.

Raw evidence logs: `/tmp/hh-cloud-gauntlet/*.txt`.

## Verdict Summary

| ID | Verdict | Short result |
| --- | --- | --- |
| H1 default-device routing | PARTIAL / REGRESSED edge | Happy path, precedence, no-connections, and direct disconnect held. A manually restored stale stopped cloud session with offline relay caused an unhandled `ENOENT` socket error instead of clean `Not connected.` |
| H2 stale refs | PARTIAL / REGRESSED | Fixed for `back`, `home`, `recent`, `menu`; still exploitable for `open-app`, off-CLI `shell am start`, `press-key back`, and `--no-settle`. |
| H3 sent-but-unsettled | PARTIAL | Stopwatch and Camera fired actions with exit 0 and no false `Tap failed`; I could not force the exact `Action sent; settle inconclusive` branch on available cloud surfaces. |
| M2 phantom buttons | PARTIAL / REGRESSED variant | Zero-height default-list phantoms were not found in the scan, but a real-bounds title-less Settings row still renders and opens Battery. |
| L2 read-only selector hint | HELD | Read-only `text=` target produced the tailored hint, not the refs-renumber hint. |
| M1 Tiny whitespace trim | NOT CLEANLY RECONFIRMED | The dirty local Tiny APK preserved leading/trailing spaces over relay; that invalidates a clean known-deferred M1 check for `fea4b8d`. |
| Cloud push/pull gap | CONFIRMED | `pull` fails ADB-only on relay. `push` is not registered in this build and errors as an unknown/too-many-args path. |

## H1 - Default-Device Routing

Verdict: PARTIAL / REGRESSED edge.

Held:

- `connect jx7629q6ndtp5fe7k3z83mn5wn87x6cz` set `config.default-device` to the primary device.
- Bare `snap` used that default and returned the primary launcher snapshot.
- With two live cloud relay devices, precedence held:
  - config default primary + `HANDHELD_DEVICE=secondary` -> bare `snap` hit the secondary Settings screen.
  - `--device primary` beat `HANDHELD_DEVICE=secondary`.
  - `--device secondary` beat `HANDHELD_DEVICE=primary`.
- No connection file + default device produced:
  - `Not connected. Hint: run handheld connect --local ... or handheld connect <device-id> ...`
- Bogus `HANDHELD_DEVICE` produced the same clean `Not connected.` hint.
- Direct `disconnect jx7629...` followed by bare `snap` produced clean `Not connected.` and `status` showed no active connections.

Regressed edge:

After disconnecting the secondary cloud target, I manually restored its stale temp connection entry to model a dead session still present in `status`.

```text
jx73tk44mvkwc4yenh9xdttghs87v4af
  Session: k57drnavay0smnz1dkqf3mz42x87w153
  Relay:   offline
  ADB:     none (dead)
```

With `default-device=jx73tk44mvkwc4yenh9xdttghs87v4af`, bare `snap --bounds` exited 1 with an unhandled Node socket error:

```text
Error: connect ENOENT /tmp/hh-cloud-gauntlet-home-Kht3uT/.handheld/sockets/jx73tk44mvkwc4yenh9xdttghs87v4af.sock
Emitted 'error' event on Interface instance
```

I did not reproduce the old gateway `Session must be active` leak, but this still violates the clean no-live-session requirement. The stale/offline relay path should collapse to the same `Not connected.` + hint surface.

Additional H1 oddity:

- If `default-device` is bogus while another live connection exists, bare `snap` silently falls back to the first live connection instead of failing on the bogus default. This is not a no-live-session path, but it weakens the expected default-device routing semantics.

Evidence: `/tmp/hh-cloud-gauntlet/h1-gauntlet.txt`, `/tmp/hh-cloud-gauntlet/h1-disconnect-primary.txt`.

## H2 - Stale Snapshot Refs

Verdict: PARTIAL / REGRESSED.

Held for the fixed command set:

```text
snap Settings -> back   -> tap @e9 => exit 1, No cached snapshot; run snap first
snap Settings -> home   -> tap @e9 => exit 1, No cached snapshot; run snap first
snap Settings -> recent -> tap @e9 => exit 1, No cached snapshot; run snap first
snap Settings -> menu   -> tap @e9 => exit 1, No cached snapshot; run snap first
```

The cache file was removed after each of those commands.

Regressions and gaps:

1. `open-app` still leaves stale cache.

```text
home
snap              # cache activity com.android.launcher3.Launcher, @e9 = Settings
open-app settings # live screen changes; cache remains launcher
tap @e9           # exit 0, blind stale-coordinate tap
```

On the replacement target, stale `@e9` opened a Settings subpage (Notifications in this run), proving this is not just a no-op.

2. Off-CLI screen change still leaves stale cache.

```text
shell "am start -a android.settings.SETTINGS"
snap              # cache activity com.android.settings.homepage.SettingsHomepageActivity
shell "am start -a android.settings.BLUETOOTH_SETTINGS"
tap @e9           # exit 0, no foreground/signature check
```

The post-state showed the Bluetooth/Connected Devices screen. This directly confirms the brief's predicted hole: app self-navigation, async screen replacement, deep links, dialogs, or any other non-cache-aware screen change can leave `@eN` stale and still tappable with exit 0.

3. `press-key back` is not equivalent to `back`.

```text
snap subpage cache
press-key back
tap @e2           # exit 0 against stale subpage ref after returning
```

The dedicated `back` clears cache; `press-key back` does not.

4. `--no-settle` keeps the stale pre-action cache.

```text
snap Settings home
--no-settle tap @e9  # navigates to Connected devices, exit 0
tap @e9              # exit 0 using stale Settings-home ref
```

Evidence: `/tmp/hh-cloud-gauntlet/h2-gauntlet.txt`, `/tmp/hh-cloud-gauntlet/h2-tail-gauntlet.txt`, `/tmp/hh-cloud-gauntlet/h2-nosettle-clean.txt`.

## H3 - Sent But Unsettled

Verdict: PARTIAL.

What held:

- DeskClock Stopwatch:
  - `tap Start` with `--settle 500 --post-state` fired and returned exit 0 with `Pause` visible.
  - `tap Pause` with `--settle 1 --post-state` fired and returned exit 0 with `Start` visible.
  - No fired action reported `Tap failed`.
- Camera preview:
  - After first-run setup, `tap shutter` with `--settle 1 --post-state` fired and returned exit 0.
  - Post-state showed the thumbnail control appeared, so the shutter action really happened.
  - No false positive `settle inconclusive` was observed where the gesture did not fire.

What I could not force:

- I did not get the exact `Action sent; settle inconclusive - re-snap to verify` warning on the available cloud surfaces, even with `--settle 0` or `--settle 1`.
- Chrome was unusable for the web-page hammer because it opened to a first-run activity with a zero-node snapshot.
- The alternate Browser package did not take foreground for the `data:` launch attempts.

So the false-failure part of H3 held under relay timing, but the warning branch itself remains unproven in this run.

Evidence: `/tmp/hh-cloud-gauntlet/h3-stopwatch.txt`, `/tmp/hh-cloud-gauntlet/h3-stopwatch-fresh.txt`.

## M2 - Phantom / Title-Less Buttons

Verdict: PARTIAL / REGRESSED variant.

Held in the broad default-snapshot scan:

- Settings offset 1: clean
- Settings offset 2: clean
- Launcher home: clean
- Launcher app drawer: clean
- Launcher app drawer after scroll: clean
- Play Store initial screen: clean

Regressed variant found immediately in Settings offset 0:

```text
- @e18 Button [actions=[press] bounds=0,1241,720,1280]
[26 more below - scroll: "Battery", "65% - Until 13:00", "Storage", ...]
```

This is not zero-height and not a harmless phantom. It is a real partially visible Settings row whose title/subtitle were culled. Tapping it exited 0 and opened Battery:

```text
tap @e18 -> Battery screen with "65 %", "Battery usage", "Battery Saver", ...
```

That is exactly the unfixed variant the brief asked for: title-less button with real bounds, misleading because the label exists just below the viewport/culling boundary.

Additional off-screen/all-mode note:

- DeskClock `snap --all --bounds` exposed off-screen zero-width/title-less controls such as `@e33 Button [id=stopwatch_time_wrapper actions=[press] bounds=1584,433,1584,865]`. This was in `--all`, not the default list scan, but it is another sign that off-screen geometry remains easy to expose as actionable noise.

Evidence: `/tmp/hh-cloud-gauntlet/m2-settings-titleless.txt`, `/tmp/hh-cloud-gauntlet/m2-scan.txt`.

## L2 - Read-Only Selector Hint

Verdict: HELD.

Repro:

```text
open-app com.android.deskclock
snap
tap "text=TUE, JUN 2"
```

Result:

```text
EXIT=1
Target "text=TUE, JUN 2" did not resolve to a tappable node.
Hint: no actionable node matched - it may have matched only read-only text (not a tap target) or nothing. Re-snap and target a node that shows a ref + actions=[...].
```

This is the expected read-only hint, not the stale-ref/renumbering hint.

Evidence: `/tmp/hh-cloud-gauntlet/l2-readonly.txt`.

## M1 - Tiny Whitespace Trim

Verdict: NOT CLEANLY RECONFIRMED.

The replacement target received the locally bundled Tiny helper during first `snap`. The worktree's `assets/tiny-snapshot-helper.apk` is dirty from the earlier local M1 fix, so this test no longer represents the `fea4b8d` deferred Tiny behavior.

Observed over relay with Settings search:

```text
type "     LEAD     "
snap --raw
"label": "     LEAD     "
"value": "     LEAD     "
```

So this run proves the dirty local Tiny APK preserves whitespace over the relay. It does not prove that the upstream/deferred Tiny APK has been fixed.

Evidence: `/tmp/hh-cloud-gauntlet/m1-whitespace.txt`.

## Cloud Push/Pull Gap

Verdict: CONFIRMED.

`push` result:

```text
node dist/cli.js --device jx7629... push /tmp/hh-cloud-gauntlet/push-source.txt /sdcard/Download/hh-cloud-gauntlet.txt
EXIT=1
error: too many arguments. Expected 0 arguments but got 3.
```

`push --help` fell back to root help, so `push` appears unregistered or not wired in this build.

`pull` result:

```text
node dist/cli.js --device jx7629... pull /sdcard/Download/hh-cloud-gauntlet.txt /tmp/hh-cloud-gauntlet/pulled.txt
EXIT=1
Pull requires an ADB transport, which this connection doesn't have.
Hint: reconnect a local device with `handheld connect --local` (relay-only cloud connections can't pull files).
```

This matches the maintainer's scoped gap for relay-only cloud devices.

Evidence: `/tmp/hh-cloud-gauntlet/push-pull-gap.txt`.

## New / Incidental Breakage

- H1 stale offline relay socket path crashes as unhandled `ENOENT`; this should be normalized to `Not connected.`
- H2 is still vulnerable to any screen change outside the small set of cache-clearing nav commands. The fix needs a foreground/activity/window signature guard at ref-resolution time, not only command-name cache clears.
- M2 still renders real-bounds title-less actionable rows at viewport culling boundaries.
- One combined H2 harness run left a local `--no-settle tap` process stuck; I killed only that local test harness PID. A clean re-run of the same no-settle scenario completed and reproduced the stale-cache exit-0 issue.
- Chrome first-run produced a zero-node snapshot; Browser `data:` launch did not foreground. This limited H3 web-page/video hammering on this target.

## Verification

```text
pnpm build
npx vitest run
```

Result: build passed; Vitest passed 143 tests with 2 skipped.

No behavior changes were made during this cloud gauntlet. The existing dirty Tiny whitespace files remain from the earlier M1 fix work and are called out above.

