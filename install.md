---
name: handheld-install
description: "Install the handheld CLI and connect it to a phone (cloud or local adb device) with minimal prompting, so an agent can get oriented and start driving."
---

# `handheld` installation & orientation

Use this file to get oriented: install `handheld`, connect to a phone, and run the
first snapshot. For the full command catalog read [`README.md`](README.md).

`handheld` is a controller for an Android phone — either a **cloud phone** (a real
device provisioned through the Gateway) or a **local adb device/emulator**. The
control surface (`snap`/`tap`/`type`/`shell`/…) is the same for both; only how you
*connect* differs.

## Install

```bash
npm install -g handheld          # global CLI: `handheld`, `handheld-route`
handheld --help
```

Working from this repo instead (development):

```bash
pnpm install && pnpm run build
node dist/cli.js --help          # `node dist/cli.js` ≡ `handheld`
```

`adb` only needs to be on `$PATH` for local devices and pull-heavy workflows.

## Get a phone — two ways

Pick based on what the user wants. If unsure, ask which one; don't provision a cloud
phone unprompted (it uses trial quota / billing).

### A) Cloud phone — `handheld init`

The product's onboarding. Claims a trial cloud phone, connects transports, opens
the live viewer when available, and scaffolds this project as a mobile agent
workspace.
**How it authenticates depends on whether a key is already available:**

- **You're an agent / headless / CI, and you HAVE a key** — set it in the
  environment; `init` then skips the browser entirely and provisions directly.
  No human, no browser; it saves the global account key for later fallback:

  ```bash
  export HANDHELD_API_KEY=<key>
  handheld init                     # "Using env API key — skipping browser sign-in." → device + workspace ready
  ```

- **No key yet (interactive human at a terminal)** — `init` opens a browser login
  for the user to complete, then provisions:

  ```bash
  handheld init                    # opens a browser login — the user completes it
  # handheld init --with-adb       # also request provider ADB (when the device offers it)
  ```

After it returns, `handheld status` shows the connected device; `handheld devices`
lists all profiles. (`handheld create` is the alias that only ever provisions with a
configured key — `init` now covers that case too.)
It also creates `.handheld/mcp.json`, `.handheld/runs/`, and an editable
`agent-workspace/` with `agent_helpers.py`, domain skills, mobile interaction
skills, and evidence storage. Use `--no-harness-workspace` to skip that scaffold.

### B) Local device / emulator — `handheld connect --local`

Attaches directly over adb. **No Gateway, no session, no API key.** Use this for local
dev, CI on an emulator, or a plugged-in phone.

```bash
handheld connect --local                 # auto-pick the sole ready adb device
handheld connect --local emulator-5554   # or name the serial (see `adb devices`)
```

This bootstraps the Tiny helper over adb and saves a `local` connection. It shares one
on-device Tiny with `handheld-harness` via a fixed token, so both tools can drive the
same device at once.

## The core loop

Snapshot → read refs → act → re-snapshot. Snapshot refs (`@e1`, `@e2`, …) are cached to
disk between invocations, so a later `tap @e2` resolves against the last `snap`.
Before dispatch, handheld verifies the cached snapshot still matches Tiny's live
foreground/digest; stale cached targets fail closed with a re-snap hint.

```bash
handheld snap -i                 # actionable refs (@e1…) + readable text; add --screenshot for a PNG
handheld tap @e2                 # tap a cached ref (or `handheld tap 540 960` for coordinates)
handheld type "hello"            # set the focused field (Tiny setText; --append to append)
handheld open-app settings       # launch an app by name/alias/package
handheld back | home | recent
handheld shell "getprop ro.product.model"
```

Actions wait for the UI to settle before returning (`--no-settle` to skip, `--settle <ms>`
to cap, `--post-state` to fold the settled snapshot into the result). **Control commands
need no API key** — a key is only required for Gateway provisioning (`init`/`create`/
`devices`, cloud `connect`).

## Driving it from an agent

- **MCP server (primary):** `handheld --mcp [--device <id>]` exposes the controller as
  ~20 structured tools (`snap`, `tap`, `type`, `connect {local:true}`, …) that settle by
  default and return the post-action snapshot. Point your agent's MCP config at it.
- **One-shot task:** `handheld run "Open Settings and confirm Wi-Fi is visible"` spins up a
  sandboxed local agent wired to the handheld MCP server.
- **Harness-shaped workspace:** `handheld init` creates the persistent project workspace; `handheld run --workspace-template harness "Inspect the current screen"` creates a per-task boxed workspace with the same helper/skill/evidence shape. Add `--local` for an adb device/emulator with no cloud API auth; use `--local-serial <serial>` when several are attached.
- **Shell out:** the discrete subcommands above work in any script (each call is a fresh
  process; state lives in `~/.handheld`).

## Maintenance

- `handheld uninstall` — dry-run local cleanup; add `--yes` to remove `~/.handheld`, project `.handheld/`, and `agent-workspace/` for test resets.
- `handheld status` — active connections + transport health; add `--prune` to remove stale records with no usable relay or ADB transport.
- `handheld doctor` — read-only, secret-safe diagnostics for config, target selection, relay, ADB, Tiny, and stale-prune readiness.
- `handheld disconnect [device-id]` — tear down. A bare `disconnect` resolves the sole
  connection; with several attached it requires an explicit serial. Local teardown never
  calls the Gateway.
- `handheld tiny bootstrap [--force]` — (re)install/start the Tiny helper if a snapshot
  reports it unavailable.

## Architecture

```text
Cloud:  cloud phone  <-- Gateway session (HTTP) / relay / ADB tunnel -->  handheld  -->  ~/.handheld
Local:  adb device   <-- adb + on-device Tiny (localhost forward)     -->  handheld  -->  ~/.handheld
```

- A **connection** (serial + Tiny endpoint + session/relay) is persisted in
  `~/.handheld/connections.json`; control commands load it. `local: true` marks a local
  attach (no Gateway).
- **Tiny** is the resident on-device helper that serves snapshots, `setText`, and input. It
  works on API 36 and is reached over an `adb forward` (local) or the Gateway/relay
  (cloud). The first cloud snapshot may take ~30s while Tiny is uploaded and started.
- The Gateway client is built lazily — it's only constructed when a Gateway call actually
  fires, which is why local/controller use needs no key.

## First-time setup & troubleshooting

Try a command first; only involve the user when a step genuinely needs them (browser
login, plugging in a device, authorizing USB debugging).

1. Already connected? `handheld snap -i` prints a snapshot → you're done.
2. Otherwise `handheld status`. If "No active connections", connect (cloud or local above).
3. Match the symptom:
   - **"No API key configured"** → only happens on a Gateway path. For a cloud
     phone set `HANDHELD_API_KEY` (preferred) or run `handheld login`. For a
     *local* device you don't need a key — use `handheld connect --local`.
   - **"Not connected. Run `handheld connect`"** → no saved connection; connect first.
   - **`connect --local` → "No adb device in 'device' state"** → start an emulator or plug in
     a device and authorize USB debugging (`adb devices` should list it as `device`).
   - **`connect --local` → "Multiple adb devices"** → pass an explicit serial.
   - **First cloud `snap` is slow / "Getting Tiny installed…"** → expected one-time bootstrap
     (up to ~30s); later snapshots are fast.
   - **Snapshot says Tiny unavailable** → `handheld tiny bootstrap` (`--force` to reinstall).

## First-run demo

Connect, then open Settings and snapshot it so the user sees the controller driving the
phone:

```bash
handheld connect --local            # or `handheld init` for a cloud phone
handheld open-app settings
handheld snap -i                     # actionable refs + text for the Settings screen
```
