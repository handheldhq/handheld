# handheld

CLI for Handheld cloud phone control through Gateway profiles, sessions, file
push, and live transports. Cross-platform (macOS, Linux, Windows).

> **Agents:** read [`install.md`](install.md) first — it orients you on install,
> connecting to a cloud or local device, and the snapshot → act loop. This README is
> the full command reference.

## Install

```bash
npm install -g handheld
```

## Quickstart

```bash
npx handheld i
```

`handheld i` opens a browser login, stores the issued API key in
`~/.handheld/config.json`, starts a trial cloud phone when available, connects relay
and ADB transports, starts the bundled Tiny helper when a device command path is available, and
redirects the approval tab to that phone's live device view.

**Already have a key? `init` runs headlessly — no browser.** When an API key is
already available (the `HANDHELD_API_KEY` env var, or a prior
`handheld config set api-key`), `handheld init` skips the browser sign-in and
provisions the trial phone directly with that key. This is the CI / agent path:

```bash
export HANDHELD_API_KEY=<your-api-key>
handheld init                 # creates + connects a device, no CLI auth prompt
# or set it once in config instead of the env var:
handheld config set api-key <your-api-key>
handheld config set api-url <your-api-url>
handheld init
```

## Profiles And Sessions

```bash
handheld create                         # alias for init
handheld devices                        # list Gateway profiles/devices
handheld connect <profile-id>           # start/reuse a session when transports exist
handheld status                         # check connection health
handheld disconnect                     # tear down
```

Internally, device-named commands now use Gateway-native profiles and sessions.
The old command names remain as aliases so existing scripts do not have to
rename everything in one step.

Live relay/H5 viewer and CLI device-code auth now use Gateway-native
profile/session routes. `handheld connect` starts or reuses a Gateway session and does
not silently fall back to old Cloud API relay routes.

## Local devices (no Gateway, no API key)

`handheld` is also a plain controller for a local adb device or emulator — no
cloud phone, no session, no API key required. Use it for local development,
CI on an emulator, or driving a physical device you've plugged in.

```bash
handheld connect --local                 # auto-pick the one ready adb device
handheld connect --local emulator-5554   # or name the serial (`adb devices`)
handheld connect --local --no-tiny       # skip the Tiny helper bootstrap
handheld snap -i                         # control commands work with no key
handheld tap @e7
handheld disconnect                      # tears down locally; never calls the Gateway
```

`connect --local` attaches over adb, bootstraps the Tiny helper on-device (the
same path the [handheld-harness](https://github.com/) uses — they share one
Tiny instance via a fixed token), and saves a relay-less connection marked
`local`. Every control/observation command (`snap`, `tap`, `type`, `swipe`,
`shell`, `screenshot`, …) runs without an API key; a key is only needed for
Gateway operations that provision or list **cloud** phones (`init`, `create`,
`devices`, cloud `connect`). Requires `adb` on PATH.

## Device control

```bash
handheld snap -i                        # compact view: actionable refs (@e1, ...) + readable text
handheld snap -i --screenshot           # refs plus a PNG screenshot file
handheld tap 540 960                    # tap at coordinates
handheld tap @e2                        # tap cached snapshot ref
handheld tap 'id=search_action_bar'     # durable selector: tap by resource-id
handheld tap 'label=Network & internet' # tap by visible name (id=/label=/text= also work on type/fill/long_press/…)
handheld long_press @e2                 # long press cached snapshot ref
handheld long_press 540 960             # long press at coordinates
handheld double_tap @e2                 # double tap a ref
handheld swipe 540 400 540 1200         # swipe gesture
handheld type "hello world"             # set the focused field (replaces existing text)
handheld type @e5 "hello world"         # set @e5 to the text
handheld type @e5 "hello world" --append  # append instead of replacing
handheld list_apps                      # list launchable app packages
handheld open_app settings              # open by package, alias, or package-like name
handheld launch "https://example.com"   # deep link / intent
handheld launch com.example/.Main       # explicit component
handheld copy "copied text"             # set clipboard
handheld paste @e5                      # focus then paste
handheld press_key back                 # key name or Android keycode
handheld back                           # Android back
handheld home                           # Android home
handheld recent                         # Android recent apps
handheld shell "pm list packages"       # run shell command
```

### Snapshot format

`snap` prints a compact, agent-facing tree: structural containers are collapsed,
off-screen nodes are dropped (with a scroll hint), and only the foreground
window's nodes appear inline — other windows (status bar, nav bar, keyboard) are
grouped or summarized below. Use `--all` for the full uncollapsed tree,
`--offscreen` to keep below-the-fold nodes, and `--raw`/`--json` for the complete
structured node list (every field, never culled).

```
Snapshot com.android.settings [com.android.settings.homepage.SettingsHomepageActivity] (18/116 nodes, backend=tiny)
- @e18 Button "Search Settings" [id=search_action_bar actions=[press]]
- @e21 ScrollView [id=main_content_scrollable_container actions=[scroll]]
  - @e33 Button "Network & internet" subtitle="Mobile, Wi‑Fi, hotspot" [actions=[press]]
  - @e67 Button "Storage" subtitle="45% used - 4.38 GB free" [actions=[press]]
  [22 more below — scroll: "Battery", "100%", "System", …]
▶ @e149 TextField "wifi" [id=open_search_view_edit_text focused actions=[press,long_press,set_value]]
- Text "No results for wifi"
[keyboard open · com.google.android.inputmethod.latin (~40 keys) — use `type`; --all to show keys]
```

Line grammar:

    {indent}{bullet} @eN Role "title" subtitle="…" = "value" [id=… focused disabled checked actions=[…]]

- **bullet** — `-`, or **`▶`** when the node is focused (also flagged `focused`).
- **`@eN`** — actionable ref, cached to disk between invocations (pass it to
  `tap`/`type`/…). Read-only text renders **without** a ref (`- Text "…"`):
  visible to read, not a target.
- **Role** — TitleCase role: `Button`, `TextField`, `Text`, `ScrollView`,
  `List`, `CheckBox`, `Switch`, `Image`, `Group`, …
- **`"title"`** — the element's name: its own contentDescription, else a tappable
  row's `…:id/title` child (else the first child text).
- **`subtitle="…"`** — the secondary line, from a `…:id/summary` child (else the
  second child text). Only on tappable rows.
- **`= "value"`** — the node's current text (e.g. an editable field's contents).
- **`[ … ]`** — `id=` (resource-id, package prefix stripped), state flags
  (`focused`, `disabled`, `checked`/`unchecked`, `selected`), and **`actions=[…]`**
  = what you can do here: `press`, `long_press`, `set_value`, `toggle`, `scroll`.
- **`[other window · pkg]`** — nodes belonging to a different window than the
  foreground activity. **`[keyboard open · …]`** — the IME, collapsed to one line
  (the keys are rarely tap targets — use `type`; pass `--all` to expand them).

Refs are invalidated by anything that changes the screen — re-`snap` after a
tap, scroll, navigation, or async update before using refs again. The `id=` and
`"title"` shown on actionable nodes double as **durable selectors**: `tap
id=search_action_bar`, `tap 'label=Network & internet'`, or `type 'label=Notes'
"hi"` resolve against the last snapshot but survive the `@eN` renumbering that
happens when the tree shuffles (`id=` matches the full or package-stripped
resource-id; `label=`/`text=` match the name/value, case-insensitive; the
actionable node wins when several match).

Compatibility commands remain available for existing scripts:

```bash
handheld click 2                        # alias-style tap of cached snapshot index @e2
handheld click-at 540 960               # tap at coordinates
handheld click-area 100 200 300 400     # tap the center of a region
handheld fill 2 "hello world"           # focus, clear, and type into @e2
handheld clear 2                        # focus and clear @e2
handheld key back                       # key name or Android keycode
handheld system-button recent           # back | home | recent | enter
handheld keycode 67                     # raw Android keycode
handheld scroll down                    # semantic scroll
handheld current-app                     # print foreground component (package/activity)
handheld stop-app com.android.chrome     # force-stop an app
handheld screenshot --output screen.png # save screenshot
handheld wait 1.5                        # wait in seconds
handheld wait-for text "Search"          # wait for text/ref/change/stable
handheld --no-settle tap @e2            # skip post-action settle wait
handheld --settle 250 tap @e2           # cap post-action settle wait
handheld --post-state tap @e2           # include the settled post-action snapshot
handheld gps 37.7749 -122.4194          # set GPS location
handheld clipboard set "copied text"    # set clipboard directly
handheld tiny bootstrap                  # upload, install, and start Tiny helper
handheld pull /sdcard/file.txt .        # pull file from device
handheld install https://example.com/app.apk
```

The compact snapshot (`snap -i`, the `snap` default, and the post-state
snapshot) returns interactive nodes **plus** standalone readable text — headings,
descriptions, displayed values, error messages — so an agent can read a screen,
not just act on it. Text already folded into an interactive row's label (the
`·`-joined form) and labeled layout containers are omitted to avoid noise. Use
`snap` (without `-i`) for the full, unfiltered node list.

Snapshots also carry the **foreground activity**: Tiny only reports the window's
app (`appName`/`bundleId`, often "System UI"), so `snap`/`snap` fold in the
`activity` + `component` (`package/activity`) from `dumpsys window`. The text
header shows it (`Snapshot System UI [com.android.settings.Settings] (…)`), and
`current-app` returns `{packageName, activity, component}`. (Post-action
`--post-state`/MCP snapshots don't include it — they're captured without a shell
round-trip; call `current-app` if you need the activity after an action.)

The text output is **hierarchical** — each node is indented under its nearest
displayed ancestor (two spaces per level), reconstructed from each node's tree
depth, so a row's title/summary and a container's children read as a tree
rather than a flat list. (The `--json` form stays a flat `nodes` array; the
hierarchy is recoverable from each node's relative position.)

Control actions wait for the UI to settle before returning. When Tiny is
available, this first confirms the action moved the UI (`/v2/waitForChange`)
and then waits for stability (`/v2/waitForStable`) with post-state evidence;
otherwise it falls back to a short sleep. Use `--no-settle` to skip or
`--settle <ms>` to cap the wait. All commands accept `--json` for structured
output and `--device <id>` to target a specific profile/session alias.

Pass `--post-state` to fold the settled post-action snapshot into the result
(`snapshot` field in `--json`; printed like `snap` in text mode), so you don't
need a separate `snap` after each action. It reuses the `snap` output shape
(display-filtered nodes, `totalNodeCount`) and refreshes the cached snapshot so
the next ref-based action resolves against the post-action screen. The CLI is
opt-in; MCP action tools include the post-state snapshot by default.

`type`/`fill` set text through Tiny's semantic `setText` (`ACTION_SET_TEXT`)
when Tiny is available — deterministic, unlike `adb input text` key injection,
which drops characters into a freshly focused field. `type` replaces the field
by default; pass `--append` to append (key injection).

`handheld snap` can bootstrap Tiny without ADB by uploading the bundled helper APK
through the active Gateway session, installing it on-device, and reading the
device-local Tiny endpoint through the runtime shell path. The first snapshot
prints a progress line while Tiny is installed; later snapshots return normally.
ADB-backed `handheld i` and `handheld connect` start Tiny during connect: if the v2 APK
is already preinstalled on the device image, the CLI just starts it and records
the local token/forward; if it is missing or unhealthy, the CLI installs the
bundled APK and retries.
The helper APK source is tracked under `android/tiny-snapshot-helper-v2/` and
can be rebuilt with `pnpm run build:tiny:v2`. Tiny keeps
snapshots, events, stable waits, capture, and semantic `setText`; general
action dispatch plus validation live in the CLI's host transport layer.
See `android/tiny-snapshot-helper-v2/README.md`.

## Local agent runs

```bash
handheld run "Open Settings and confirm Wi-Fi is visible"
handheld run "Search Chrome for current weather" --model sonnet
handheld run "Open Settings and check storage" --tui
handheld run "Inspect the current screen" --agent codex --model gpt-5
handheld run "Inspect the current screen" --dry-run
```

`handheld run` starts or reuses the default device, creates an isolated project-local
`.handheld/runs/<run-id>/` workspace, writes a strict MCP config for
`handheld --mcp --device <id>`, starts Tiny helper bootstrap in the
background, then launches the local agent from that workspace. Claude gets only
the generated Handheld MCP server via
`--strict-mcp-config`, `--allowedTools mcp__handheld__*`,
`--setting-sources ""`, and disabled built-in tools. `--agent codex` uses
`codex exec --ignore-user-config -C <workspace>` with the same Handheld MCP
server injected through Codex config overrides. `ANTHROPIC_API_KEY` is stripped
from Claude, and `OPENAI_API_KEY` / `CODEX_API_KEY` are stripped from Codex, so
the local CLIs use the user's OAuth/keychain auth;
pass `--allow-api-key-env` only when you intentionally want API-key auth.
Pass `--tui` to launch Claude Code's interactive terminal in the prepared
workspace so you can steer the agent while it uses the same locked Handheld
MCP server.

## Coming Soon

- Saved-state snapshots: capture, list, and restore profile state heads.
- App library workflows: upload, install, and manage saved app bundles.

## ADB shim

Intercepts standard `adb` commands so existing scripts work transparently.

```bash
handheld shim install                   # install shim to ~/.handheld/bin/
# add ~/.handheld/bin to your PATH (printed after install)

adb connect handheld:<device-id>        # auto-connects via handheld
adb shell input tap 540 960       # routed through relay fast path
adb pull /sdcard/file.txt .       # uses real ADB
adb devices                       # shows all devices
```

## MCP server

Run as an MCP server for AI agent integration:

```bash
handheld --mcp
handheld --mcp --device <device-id>
npx -y handheld --mcp
```

Default agent tools: `devices`, `create_device`, `connect`, `disconnect`, `snap`, `tap`, `long_press`, `double_tap`, `swipe`, `type`, `list_apps`, `open_app`, `launch`, `copy`, `paste`, `press_key`, `back`, `home`, `recent`, `shell`.

Set `HANDHELD_MCP_FULL=1` to expose advanced fleet/profile/billing and compatibility tools for operators.

MCP action tools also settle by default and accept optional `settleMs`, and
return the settled post-action snapshot in the result (`snapshot`) so an agent
doesn't need a separate `snap` after each action. `connect` uses the same
ADB/Tiny bootstrap path as the CLI.

## Config

Stored in `~/.handheld/config.json`. Available keys:

| Key | Description |
|-----|-------------|
| `api-key` | API authentication key |
| `api-url` | Gateway API base URL |
| `default-device` | Default profile/session alias for commands |
| `output` | Default output format (`table`, `json`, `quiet`) |

## Requirements

- Node.js >= 18
- `adb` on PATH for `connect --local`, ADB transport, and pull-heavy workflows

## Transport Model

- Gateway HTTP session commands cover runtime exec, file upload/push, and file-backed install flows
- Relay remains the fast lane for interactive control once the Gateway live-surface chunk lands
- ADB is the heavy lane for pull/push when a tunnel is available
- Tiny can be installed over Gateway upload + runtime shell when ADB is unavailable
- `--headed` opens the remote viewer and does not change the control transport
