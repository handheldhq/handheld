# handheld-harness Adapter Proof - 2026-06-02

Scope: deterministic implementation proof for the new `oss/handheld-harness`
adapter plus `handheld run` harness workspace support.

## Deterministic Checks

- `oss/handheld-harness`: `python -m compileall src tests/fixtures/fake_handheld.py && python -m pytest -q`
  - Result: 26 passed.
- `oss/handheld` focused run tests: `pnpm test src/commands/run.test.ts`
  - Result: 8 passed.
- `oss/handheld` full tests: `pnpm test`
  - Result: 28 files passed; 168 passed, 2 skipped.
- `oss/handheld` typecheck: `pnpm typecheck`
  - Result: passed.
- `oss/handheld` build: `pnpm build`
  - Result: passed; `dist/cli.js` rebuilt.

## CLI Proof

- Adapter doctor:
  - Command: `PYTHONPATH=src HANDHELD_BIN=/Users/hbruceweaver/Projects/lattice-technologies/oss/handheld/dist/cli.js python -m handheld_harness.run --doctor`
  - Result: `ok: handheld CLI reachable`.
- Harness dry-run:
  - Command: `node dist/cli.js run "Inspect the current screen" --local emulator-5554 --workspace-template harness --dry-run --agent codex --json`
  - Result: prepared a workspace with `agent-workspace`, `evidence`, locked Handheld MCP config, and empty local `HANDHELD_API_URL`.
- Heredoc/fake-handheld smoke:
  - Command: `PYTHONPATH=src HH_FAKE_RECORD=/tmp/handheld-harness-heredoc-record.jsonl HANDHELD_BIN=/Users/hbruceweaver/Projects/lattice-technologies/oss/handheld-harness/tests/fixtures/fake_handheld.py python -m handheld_harness.run` with `state = snap()`.
  - Result: printed `.Settings` and recorded `["--json", "snap", "--agent"]`.

## Live Device Proof

Cloud relay smoke:

- Used an already-active cloud session; no new cloud phone was provisioned.
- `node dist/cli.js --json connect <redacted-device-id> --webrtc-only --no-tiny` returned ok with relay connected.
- `node dist/cli.js --device <redacted-device-id> --json snap --agent` returned launcher state with Tiny backend and 10 actionable nodes.
- Adapter command: `PYTHONPATH=src HANDHELD_BIN=... HH_DEVICE=<redacted-device-id> HH_EVIDENCE_DIR=/tmp/handheld-harness-cloud-evidence-20260602 python -m handheld_harness.run`.
- Adapter result: `before_activity=com.android.launcher3.Launcher`, `home_ok=True`, `home_has_snapshot=True`.
- Evidence: `/tmp/handheld-harness-cloud-evidence-20260602/20260602T140353Z-cloud-smoke-snap.json`, `...-status.json`, `...-screen.jpg`.

Local emulator smoke:

- Started SDK AVD `Medium_Phone_API_36.1` headless and waited for `sys.boot_completed=1` on `emulator-5554`.
- `node dist/cli.js --json connect --local emulator-5554` returned ok with Tiny ready.
- Adapter command: `PYTHONPATH=src HANDHELD_BIN=... HH_DEVICE=emulator-5554 HH_EVIDENCE_DIR=/tmp/handheld-harness-local-evidence-20260602 python -m handheld_harness.run`.
- Adapter result: `before_activity=com.google.android.apps.nexuslauncher.NexusLauncherActivity`, `launch_ok=True`, `launch_has_snapshot=True`, `after_activity=com.android.settings.Settings`.
- Evidence: `/tmp/handheld-harness-local-evidence-20260602/20260602T140605Z-local-smoke-snap.json`, `...-status.json`, `...-screen.jpg`.
- Harness local dry-run: `node dist/cli.js --json run "Open Settings and confirm Wi-Fi is visible" --local emulator-5554 --workspace-template harness --dry-run --agent codex` returned ok with locked MCP config and evidence path.
- Cleanup: `node dist/cli.js --json disconnect emulator-5554` returned ok; `adb -s emulator-5554 emu kill` stopped the emulator.
