---
name: handheld-install
description: "Install the handheld CLI, claim a trial cloud phone, and start driving it with minimal prompting."
---

# `handheld` installation & orientation

Use this file to get oriented: install `handheld`, claim a trial cloud phone,
and run the first snapshot. For the full command catalog read
[`README.md`](README.md).

`handheld` is a controller for a real Android cloud phone provisioned through
the Gateway. The default onboarding is cloud-first: one command claims a trial
phone, connects it, lets the claim tab show the live device after browser
approval, and scaffolds an agent-ready workspace.

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

`adb` is not required for the default cloud onboarding. It is only needed for
local-device development and pull-heavy workflows.

## Get a cloud phone

Run `handheld init`. This is the product onboarding path: it claims a trial
cloud phone, starts or reuses a session, connects the live relay/viewer by
default, lets the claim tab show the live phone after browser approval, and
scaffolds this project as a mobile agent space.
**How it authenticates depends on whether a key is already available:**

- **You're an agent / headless / CI, and you HAVE a key** — set it in the
  environment; `init` then skips the browser entirely and provisions directly.
  No human, no browser; it saves the global account key for later fallback:

  ```bash
  export HANDHELD_API_KEY=<key>
  handheld init                     # "Using env API key — skipping browser sign-in." -> device + agent space ready
  ```

- **No key yet (interactive human at a terminal)** — `init` opens a browser login
  for the user to complete, then provisions the trial cloud phone:

  ```bash
  handheld init                    # opens a browser login — the user completes it
  # handheld init --with-adb       # also request provider ADB (when the device offers it)
  ```

After it returns, `handheld status` shows the connected device; `handheld devices`
lists all profiles. `handheld create` is the headless cloud provisioner for an
already-authenticated account; it never opens browser sign-in and does not
replace the first-run project scaffold that `init` owns.
It also creates `.handheld/mcp.json`, `.handheld/runs/`, and an editable
`agent-space/` with `helpers/agent_helpers.py`, domain skills, mobile interaction
skills, and evidence storage. Use `--no-agent-space` to skip that scaffold
(`--no-harness-workspace` remains a legacy alias).
The generated project MCP config uses `handheld --mcp` by default; set
`HANDHELD_BIN` during `init` only when the project should pin a development
binary.

### Local device / emulator (advanced)

Local adb is an advanced development path, not the product onboarding. Use it
only for local dev, CI on an emulator, or a plugged-in phone.

```bash
handheld init --local                    # local dev setup: attach + scaffold agent-space, no auth
handheld init --local --no-connect       # scaffold only; no device touch
handheld connect --local                 # attach-only: auto-pick the sole ready adb device
handheld connect --local emulator-5554   # or name the serial (see `adb devices`)
```

`init --local` scaffolds `.handheld/`, MCP config, helpers, skills, and evidence
storage before optionally attaching. `connect --local` is the attach-only sibling:
it bootstraps the Tiny helper over adb and saves a `local` connection. It shares one
on-device Tiny with `handheld-harness` via a fixed token, so both tools can drive the
same device at once.

## The core loop

Snapshot → read refs → act → re-snapshot. Snapshot refs (`@e1`, `@e2`, …) are cached to
disk between invocations, so a later `tap @e2` resolves against the last `snap`.
Before dispatch, handheld verifies the cached snapshot still matches Tiny's live
foreground/digest; stale cached targets fail closed with a re-snap hint.

```bash
handheld snap                    # compact refs (@e1…) + readable text; add --screenshot for a JPEG file
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
- **Harness-shaped workspace:** `handheld init` creates the persistent project workspace; `handheld run --workspace-template harness "Inspect the current screen"` creates a per-task boxed workspace with the same helper/skill/evidence shape. Local adb remains available for dev/CI with `--local`.
- **Shell out:** the discrete subcommands above work in any script (each call is a fresh
  process; state lives in `~/.handheld`).

## Maintenance

- `handheld status` — active connections + transport health; add `--prune` to remove stale records with no usable relay or ADB transport.
- `handheld doctor` — read-only, secret-safe diagnostics for config, target selection, relay, ADB, Tiny, and stale-prune readiness.
- `handheld uninstall` — dry-run local cleanup; add `--yes` to remove `~/.handheld`, project `.handheld/`, `agent-space/`, and legacy `agent-workspace/` for test resets.
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

Try the cloud path first; only involve the user when a step genuinely needs
them (browser login or account approval).

1. Already connected? `handheld snap` prints a compact snapshot → you're done.
2. Otherwise `handheld status`. If "No active connections", run `handheld init`.
3. Match the symptom:
   - **"No API key configured"** → only happens on a Gateway path. For a cloud
     phone set `HANDHELD_API_KEY` (preferred) or run `handheld init` for browser
     login and trial-phone provisioning.
   - **"Not connected. Run `handheld connect`"** → no saved connection; run
     `handheld init` for first-run cloud provisioning, or `handheld connect <id>`
     only when reconnecting an existing cloud profile.
   - **`connect --local` → "No adb device in 'device' state"** → start an emulator or plug in
     a device and authorize USB debugging (`adb devices` should list it as `device`).
   - **`connect --local` → "Multiple adb devices"** → pass an explicit serial.
   - **First cloud `snap` is slow / "Getting Tiny installed…"** → expected one-time bootstrap
     (up to ~30s); later snapshots are fast.
   - **Snapshot says Tiny unavailable** → `handheld tiny bootstrap` (`--force` to reinstall).

## First-run demo

Claim a cloud phone, then open Settings and snapshot it so the user sees the
controller driving the phone:

```bash
handheld init                       # claim/connect a trial cloud phone
handheld open-app settings
handheld snap                        # compact refs + text for the Settings screen
```
