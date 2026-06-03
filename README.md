# handheld

CLI for Handheld cloud phone control through Gateway profiles, sessions, file
push, and live transports. Cross-platform (macOS, Linux, Windows).

> **Agents:** read [`install.md`](install.md) first — it orients you on install,
> claiming a cloud phone, and the snapshot → act loop. This README is
> the full command reference.

## Install

```bash
npm install -g handheld
```

## Quickstart

```bash
npx handheld i
```

`handheld i` is the product onboarding path: it claims a trial cloud phone,
starts it, connects the live relay/viewer by default (`--with-adb` also requests
provider ADB), starts the bundled Tiny helper when a device command path is
available, lets the claim tab show that phone after browser approval, and
scaffolds this project as a mobile agent space. The desired first-run moment is:
one command, a claimed cloud phone in the browser, and an agent-ready workspace.

**Already have a key? `init` runs headlessly — no browser.**
When `HANDHELD_API_KEY` is present, `handheld init` skips the browser sign-in
and provisions the trial phone directly with that key, then saves it as the
global account fallback in `~/.handheld/config.json`. This is the CI / agent
path:

```bash
export HANDHELD_API_KEY=<your-api-key>
handheld init                 # provisions/connects cloud + scaffolds agent-space, no browser auth prompt
```

The saved global key is not per-device state. Workspace/project config can take
precedence later when present.

By default, `handheld init` also creates project-local agent setup:

```text
.handheld/
  mcp.json
  runs/
agent-space/
  helpers/agent_helpers.py
  skills/domain/
  skills/interaction/mobile/
  evidence/
```

Use `--workspace <path>` to scaffold a different project directory, or
`--no-agent-space` for auth/device-only behavior (`--no-harness-workspace` is
kept as a compatibility alias).
Project `.handheld/mcp.json` uses the durable `handheld --mcp` command by
default. Set `HANDHELD_BIN` during `init` if a project should point at a
specific development binary instead.
See [`docs/agent-space-naming.md`](docs/agent-space-naming.md) for the naming rationale and legacy compatibility rules.

## Profiles And Sessions

```bash
handheld create                         # provision a cloud phone with existing auth; no browser sign-in
handheld devices                        # list Gateway profiles/devices
handheld connect <profile-id>           # attach to an existing profile/session target
handheld status                         # check connection health
handheld status --prune                 # remove stale saved connection records
handheld doctor                         # secret-safe config/target/transport diagnostics
handheld disconnect                     # tear down
handheld uninstall                      # preview removal of ~/.handheld + project .handheld/agent-space
```

Internally, device-named commands now use Gateway-native profiles and sessions.
The old command names remain as aliases so existing scripts do not have to
rename everything in one step.

Live relay/H5 viewer and CLI device-code auth now use Gateway-native
profile/session routes. `handheld connect` starts or reuses a Gateway session and does
not silently fall back to old Cloud API relay routes.

## Local devices (advanced)

`handheld` is also a plain controller for a local adb device or emulator — no
cloud phone, no session, no API key required. This is for local development,
CI on an emulator, or a physical device you've plugged in. For product
onboarding, prefer `handheld init` so the agent claims and connects a cloud
phone.

```bash
handheld init --local                    # local dev setup: attach + scaffold agent-space, no auth
handheld init --local --no-connect       # scaffold only; no device touch
handheld connect --local                 # auto-pick the one ready adb device
handheld connect --local emulator-5554   # or name the serial (`adb devices`)
handheld connect --local --no-tiny       # skip the Tiny helper bootstrap
handheld snap                            # control commands work with no key
handheld tap @e7
handheld disconnect                      # tears down locally; never calls the Gateway
```

`init --local` is the local dev/CI setup path: it creates `.handheld/`,
`agent-space/`, MCP config, helpers, skills, and evidence directories without
cloud auth; when it connects successfully, it saves that adb serial as the
default device. Use `connect --help` to choose between cloud reconnects and
local adb, and use `connect --local` only when the workspace already exists and
you only need to attach a local device: it attaches over adb, bootstraps the Tiny helper on-device (the
same path the [handheld-harness](https://github.com/) uses — they share one
Tiny instance via a fixed token), and saves a relay-less connection marked
`local`. Every control/observation command (`snap`, `tap`, `type`, `swipe`,
`shell`, `screenshot`, …) runs without an API key; a key is only needed for
Gateway operations that provision or list **cloud** phones (`init` without `--local`, `create`,
`devices`, cloud `connect`). Requires `adb` on PATH. The **first** `connect --local`
on a device installs/starts the Tiny helper and can take ~30s (one-time, local as
well as cloud); later commands are fast.

## Device control

```bash
handheld snap                           # compact view: actionable refs (@e1, ...) + readable text
handheld snap -i                        # leaner: actionable refs only (drops read-only text)
handheld snap --screenshot              # also save a JPEG (defaults to ./handheld-screenshot-<ts>.jpg in CWD)
handheld snap --screenshot-output a.jpg # …or choose the path explicitly (recommended in scripts)
handheld tap 540 960                    # tap at coordinates
handheld tap @e2                        # tap cached snapshot ref
handheld tap 'id=search_action_bar'     # durable selector: tap by resource-id
handheld tap 'label=Network & internet' # tap by visible name (id=/label=/text= also work on type/fill/long-press/...)
handheld long-press @e2                 # long press cached snapshot ref
handheld long-press 540 960             # long press at coordinates
handheld double-tap @e2                 # double tap a ref
handheld swipe 540 400 540 1200         # swipe gesture
handheld type "hello world"             # set the focused field (replaces existing text)
handheld type @e5 "hello world"         # set @e5 to the text
handheld type @e5 "hello world" --append  # append instead of replacing
handheld list-apps                      # launchable app packages (one id per line; --json → {ok, apps:[{package,label}]})
handheld open-app settings              # open by package, alias (chrome/settings/gmail/maps/play/youtube/files), or package-like name
handheld launch "https://example.com"   # deep link / intent
handheld launch com.example/.Main       # explicit component
handheld copy "copied text"             # set clipboard
handheld paste @e5                      # focus then paste
handheld press-key back                 # key name or Android keycode
handheld back                           # Android back
handheld home                           # Android home
handheld recent                         # Android recent apps
handheld shell "pm list packages"       # run shell command
handheld current-app                     # text: prints "package/activity"; --json: {packageName, activity, component}
```

### Snapshot format

`snap` prints a compact, agent-facing tree: structural containers are collapsed,
off-screen nodes are dropped (with a scroll hint), and only the foreground
window's nodes appear inline — other windows (status bar, nav bar, keyboard) are
grouped or summarized below.

- `--all` — the full uncollapsed tree (every structural container, nothing folded). The header's `(shown/total)` count puts those folded containers in `total`, so `--all` is what reveals the gap between `shown` and `total` — **not** `--offscreen`.
- `--offscreen` — also keep nodes that are in the tree but below the viewport fold.
- **Scrollable lists recycle their off-screen rows out of the accessibility tree**, so a row you haven't scrolled to simply isn't captured yet — neither `--all` nor `--offscreen` can show it. **`scroll` to load more rows** (the foreground `ScrollView` carries `actions=[scroll]`, and a `[N more below — scroll: …]` hint appears when below-fold rows *are* still in the tree). When you pass `--offscreen`, the footer reminds you of this.
- `--json` returns the structured node list with the normalized fields (no per-node `raw` blob — that kept each node ~1KB); pass `--raw` for the complete unprocessed Tiny response (every field, never culled).

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
  Note: a focused search/text field often surfaces its typed text as the **title**
  (`TextField "wifi"`) rather than in the `= "value"` slot — for such fields the
  title *is* the current value. Also, an **empty** focused field is filtered out of
  the compact snapshot (use `--all` to see it, or just `type` into it — the field
  is still focused on-device even when not shown).
- **`[ … ]`** — `id=` (resource-id, package prefix stripped), state flags
  (`focused`, `disabled`, `checked`/`unchecked`, `selected`), and **`actions=[…]`**
  = what you can do here: `press`, `long_press`, `set_value`, `toggle`, `scroll`.
- **`[other window · pkg]`** — nodes belonging to a different window than the
  foreground activity. **`[keyboard open · …]`** — the IME, collapsed to one line
  (the keys are rarely tap targets — use `type`; pass `--all` to expand them).

Before a cached `@eN`/selector target dispatches input, handheld compares the last
snapshot's foreground with Tiny's live foreground. A move to a **different** screen
fails closed with a re-`snap` hint. But when only the **layout drifted on the same
screen** — a ticking clock, async content finishing, or the settle tail of a
`--post-state` capture — handheld transparently re-resolves your target against a
fresh snapshot by identity (`@eN` via the node's stable id; `id=`/`label=`/`text=`
by selector) and dispatches against its current position. So a target that merely
moved keeps working without a manual re-`snap`; only a genuine navigation forces
one. The `id=` and `"title"` shown on actionable nodes double
as **durable selectors**: `tap id=search_action_bar`, `tap 'label=Network &
internet'`, or `type 'label=Notes' "hi"` resolve against the last snapshot but
survive `@eN` renumbering within that snapshot (`id=` matches the full or
package-stripped resource-id; `label=`/`text=` match the name/value,
case-insensitive; the actionable node wins when several match).

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

The compact snapshot (`snap` default and the post-state snapshot) returns
interactive nodes **plus** standalone readable text — headings,
descriptions, displayed values, error messages — so an agent can read a screen,
not just act on it. Text already folded into an interactive row's label (the
`·`-joined form) and labeled layout containers are omitted to avoid noise. Use
`snap -i`/`--interactive` for actionable nodes only, or `snap --all` for the
full, unfiltered node list.

Snapshots also carry the **foreground activity**: Tiny only reports the window's
app (`appName`/`bundleId`, often "System UI"), so `snap`/`snap` fold in the
`activity` + `component` (`package/activity`) from `dumpsys window`. The text
header shows it (`Snapshot System UI [com.android.settings.Settings] (…)`), and
`current-app --json` returns `{packageName, activity, component}` (plain `current-app` prints the `package/activity` string). (Post-action
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

In text mode, action commands that don't print a snapshot (`tap`, `open-app`,
`back`/`home`/`recent`, `swipe`, `long-press`, …) acknowledge success with a one-
line `ok` — or `ok (no UI change)` when the settle detected the action was a no-op
— so success is distinguishable from a silent failure. `--json` carries the full
result (incl. the `wait` settle metadata) and `--post-state` prints the snapshot
instead.

Pass `--post-state` to fold the settled post-action snapshot into the result
(`snapshot` field in `--json`; printed like `snap` in text mode), so you don't
need a separate `snap` after each action. It reuses the `snap` output shape
(display-filtered nodes, `totalNodeCount`) and refreshes the cached snapshot. The
capture waits for the layout to actually stop moving before caching, and the
same-screen identity re-resolution above covers any residual drift, so a `@eN`
ref printed by a `--post-state` action resolves on the very next command. The CLI is
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
handheld run "Inspect the current screen" --local --workspace-template harness --dry-run
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
`HANDHELD_API_KEY` / `MOBILEUSE_API_KEY` are not passed into the spawned agent
environment; `handheld init` persists the global account key for the MCP server
fallback instead.
Pass `--tui` to launch Claude Code's interactive terminal in the prepared
workspace so you can steer the agent while it uses the same locked Handheld
MCP server.
Pass `--local` to target an adb device/emulator with no cloud API auth; add
`--local-serial <serial>` when several local devices are attached. Pass
`--workspace-template harness` or `--harness` to include a handheld-harness-shaped
`agent-space` with mobile interaction skills and evidence directories. Project
`agent-space/skills/domain` files are imported into each run; agents can inspect
them with `list_domain_skills` / `read_domain_skill`, save run-local candidates
with `save_domain_skill_candidate`, and promote durable discoveries back to the
project with `promote_domain_skill`.

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

Default agent tools: `devices`, `create_device`, `connect`, `disconnect`, `snap`, `capture_evidence`, `list_domain_skills`, `read_domain_skill`, `save_domain_skill_candidate`, `promote_domain_skill`, `tap`, `long_press`, `double_tap`, `swipe`, `type`, `list_apps`, `open_app`, `launch`, `copy`, `paste`, `press_key`, `back`, `home`, `recent`, `shell`, `teach_request`, `teach_status`, `read_teach_artifact`.
When `teach_request` opens a human demonstration, locked MCP-only agents should
poll `teach_status` by `teachId`, then call `read_teach_artifact` for the
captured trajectory instead of reading host files directly.

Set `HANDHELD_MCP_FULL=1` to expose advanced fleet/profile/billing and compatibility tools for operators.

MCP action tools also settle by default and accept optional `settleMs`, and
return the settled post-action snapshot in the result (`snapshot`) so an agent
doesn't need a separate `snap` after each action. `connect` uses the same
ADB/Tiny bootstrap path as the CLI.

## Config

Stored in `~/.handheld/config.json`. `handheld init` with `HANDHELD_API_KEY`
saves that account key as the global fallback key, similar to a normal CLI
login. Headless/agent auth can still use `HANDHELD_API_KEY` for the current
process; browser login and manual config remain supported for local profiles.
Workspace/project config can take precedence later when present. Available keys:

| Key | Description |
|-----|-------------|
| `api-key` | Optional global account API key; `HANDHELD_API_KEY` overrides it for the current process |
| `api-url` | Gateway API base URL |
| `default-device` | Default profile/session alias for commands |
| `output` | Default output format (`table`, `json`, `quiet`) |

`handheld config get api-key`, `handheld config get`, and `handheld doctor`
mask stored API keys by default. Use `HANDHELD_API_KEY` when a full key must be
supplied non-interactively; `handheld config get api-key --raw` exists only for
automation that intentionally uses a stored local key.

## Requirements

- Node.js >= 18
- `adb` on PATH for `connect --local`, ADB transport, and pull-heavy workflows

## Transport Model

- Gateway HTTP session commands cover runtime exec, file upload/push, and file-backed install flows
- Relay remains the fast lane for interactive control once the Gateway live-surface chunk lands
- ADB is the heavy lane for pull/push when a tunnel is available
- Tiny can be installed over Gateway upload + runtime shell when ADB is unavailable
- `--headed` opens the remote viewer and does not change the control transport
