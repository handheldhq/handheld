---
name: teach-from-human
description: >-
  Synthesize a durable, replayable handheld domain-skill from a human's live
  device demonstration (a handheld.trajectory.v1 bundle from the live viewer).
  Use ONLY when stuck on a device task and ALL four gates hold: (1) two distinct
  autonomous approaches were tried and re-observed with no progress; (2) the
  blocker is a knowledge gap, not a transient (loading/Tiny bootstrap settle on
  their own, never a human); (3) a present human could demo the step in under a
  minute (login wall, CAPTCHA, non-obvious gesture, app-specific flow the
  snapshot can't reveal); (4) no existing domain-skill for the package covers
  it. Triggers on: "get a human to show me", "teach from human", "demonstrate
  this flow", "record what the human does", "synthesize a workflow from this
  trajectory". Outputs
  agent-space/skills/domain/<package>/<command>.md plus workflow.json. Do
  NOT trigger for snapshot-solvable tasks, transient failures, ambiguity a
  one-line question resolves, or when no human is available — ask first.
---

# teach-from-human

Convert one human-recorded device demonstration into a durable, replayable
workflow. The human acts through the live device viewer; the viewer records a
`handheld.trajectory.v1` bundle (exact actions, frames, optional voice). This
skill runs the holotab teach-synthesis methodology over that bundle and writes
a per-package domain-skill the agent replays — and verifies — on the next run.

This skill does NOT capture the demonstration. Capture is the live viewer's job:
`handheld teach <objective>` (or the `teach_request` MCP tool) opens the live
viewer for the human and writes a teach envelope. MCP-only agents should poll
`teach_status` until `status` is `ready`, then call `read_teach_artifact` with
`artifact: "trajectory"` and synthesize from the returned JSON. When a human
explicitly gives you a local bundle path, you may use that path instead.

## When to use (the four gates — load-bearing)

Reach for a human demonstration **last**, not first. Fire this skill only when
**all four** hold:

1. **Exhausted autonomy** — at least two distinct approaches tried (different
   entry points / refs / search-vs-menu), state re-observed after each, still
   no progress.
2. **Knowledge gap, not a transient** — not "still loading", not "Tiny
   bootstrapping". Those resolve via the built-in settle (every action waits
   until the UI is stable) or a retry, never a human.
3. **A human could demo it in under a minute** — a login wall, CAPTCHA, a
   non-obvious gesture, an app-specific multi-screen flow uninferrable from the
   snapshot.
4. **Not already taught** — check `agent-space/skills/domain/<package>/`
   first. If the flow is there, **replay it** (see "Replay") instead of
   re-teaching.

When in doubt, ask a one-line clarifying question first. Escalate to a full
demonstration only when a verbal answer would not unblock you, and only when a
human is actually available.

## Inputs

A `handheld.trajectory.v1` bundle (zip + extracted JSON) produced by the live
viewer, plus the human-language `objective`. The bundle's JSON carries
`actions[]` (exact `pointer_tap` / `pointer_swipe` / `key` / agent actions with
raw **and** normalized coordinates), frame-metadata + PNG frames, an optional
`transcript`, an `alignment[]` (action ↔ transcript), and a `skillDraft` slot
the synthesis fills. Full field shapes: `references/trajectory-schema.md`.

**Provenance guard.** Identify the exact bundle being synthesized (the
trajectory JSON returned by `read_teach_artifact` once `teach_status` is
`ready`, or an explicit path the user gave). Do not synthesize from fragments.
If no bundle can be identified, refuse with:
`No handheld.trajectory.v1 bundle found to synthesize. Run a teach recording first, or pass an explicit bundle path.`

## Synthesis workflow

Apply the holotab teach-synthesis methodology, adapted for mobile. Drive it with
the system prompt in `references/teach-synthesis-prompt.md` (load it before
synthesizing). Five steps, in order:

1. **Intent reasoning first.** Before emitting anything, state the user's
   highest-level goal in one sentence: "If someone described this task in one
   sentence, what would they say?" That sentence becomes `task_pattern`. The
   workflow is a reusable shortcut, not a session replay.
2. **Critical-path filtering.** Keep only the minimal essential actions. Drop
   navigation overhead (opening the launcher to reach the app), exploratory
   taps, corrections, accidental actions. Set `start_app` to where the real
   task begins.
3. **Conservative variable extraction.** Create a variable ONLY when the human
   would realistically supply a different value next run (search queries,
   message bodies, per-run form inputs, quantities, dates, target ids). Do NOT
   variabilize UI labels/button text or navigation-only values. Treat
   `literal_values_observed` as reference context, not a directive to make a
   variable per value. Every `{placeholder}` used anywhere MUST have a
   `variables` entry, and `task_pattern` MUST reference every variable.
4. **Step + checkpoint generation.** For each critical-path step write
   `action` (imperative), `details` (target by **resource-id > label >
   normalized-coord fallback**, never raw pixel coordinates), and a
   `checkpoint` — a verification of the **settled post-action snapshot**. Every
   handheld action settles automatically (waits until the UI is stable) and
   returns the post-action snapshot, so a checkpoint is NOT a wait call: it is
   the assertion the agent confirms against that snapshot — an expected text
   present, an expected screen/activity, or a node in an expected state. Write
   it as `{ "expect": "text" | "node" | "screen", "value": "<what to confirm>" }`.
   To pick a target for each `pointer_tap`, read the action's `preFrame` and the
   post-action snapshot diff and choose the most stable identifier of the node
   that changed.
5. **Command name.** Short, memorable, kebab-case, 2-4 words, max 30 chars,
   action-oriented (`add-payee`, `book-table`). Not
   `navigate-to-app-and-add-a-payee`.

Then run the **validation loop**: every `{placeholder}` resolves to a
`variables` entry, `task_pattern` references all variables, no step carries a
raw pixel `{x, y}` as its primary target, and the credential rule below holds.
Fix and re-check before writing.

## Credential safety (NON-NEGOTIABLE)

The synthesized workflow MUST NEVER store a literal credential as a variable
value, `default`, or step text. Any text entry into a sensitive field becomes a
`{credential}` variable with **no `default` and no example value**, prompted at
replay. Detect sensitivity from the snapshot node of the target (an `editable`
node whose label/resource-id indicates a password/PIN/secret, e.g. label
"Password", resource-id `...:id/password`) and from the demonstration intent. A
step that fills such a field is written as: details "Fill the password field
with `{credential}`", step args `{ "target": "@by-id:<pkg>:id/password",
"text": "{credential}" }` — a template reference only, never the typed literal.
The `variables` entry is `{ "name": "credential", "description": "login
password", "required": true }` with no value.

## Output artifacts

Write two co-located artifacts (format details and the workflow.json schema:
`references/durable-workflow-artifact.md`):

- **PRIMARY** — `agent-space/skills/domain/<package>/<command-name>.md`:
  the human-and-agent-readable playbook (task_pattern, variable table, steps
  with checkpoints, stable resource-ids/labels, traps). This is what
  `domain_skills("<package>")` surfaces and the run prompt reads before the
  agent invents an approach. Match the existing `skills/domain/<package>/`
  convention exactly: package names, stable labels, waits, traps, verification
  checks; no secrets, no run narration, no raw coordinates as primary
  instructions.
- **SECONDARY** — `workflow.json` co-located in the teach session dir, which
  lives in the **invoking agent's workspace** — project-local, beside the run
  workspaces (`<workspace>/.handheld/teach/<teach-id>/workflow.json`, mirroring
  `.handheld/runs/`) — and referenced from the markdown: the machine-precise
  synthesis JSON a future `replay_workflow` reads. The teach session is rooted
  in whatever workspace the invoking agent is running in (its cwd), never a
  global `~/.handheld` path; if invoked inside a `handheld run` workspace, both
  artifacts land in that workspace's `agent-space/`.

## Replay + verification

When a later run's objective matches a taught `command_name` / `task_pattern`:

1. **Match + bind.** Bind `variables` from the objective ("add payee Alice acct
   123" → `{payee_name:"Alice", account_number:"123"}`). Prompt for any
   `{credential}` — never read it from the artifact.
2. **Replay.** Execute the markdown steps through the handheld MCP tools
   (`open_app` / `launch` for `start_app`, `tap`, `fill`, `scroll`, `back`,
   `swipe`, `key`), substituting variables.
3. **Verify each step.** Each action settles automatically and returns the
   post-action snapshot; confirm the step's `checkpoint` against it (the
   expected text/node/screen is present). A failed checkpoint means the UI
   drifted — fall back one rung on the ladder, do not blindly continue.
4. **Verify the goal.** Confirm the success condition and report the outcome
   plus the evidence observed.

**Fallback ladder** (cheapest → most robust): deterministic workflow.json steps
→ LLM-interpreted markdown playbook → from-scratch with a fresh snapshot. A
checkpoint failure drops exactly one rung; surface drift to the user, never
silently roll back.

## Limits

- **Fixture staleness.** The frames and resource-ids are a point-in-time
  capture. An app update can move or rename targets; the markdown (LLM-tolerant)
  outlives the deterministic JSON. Re-teach when replay drifts repeatedly.
- **Single-package key.** The artifact is keyed by one Android package. A flow
  spanning apps (share sheet → another app) is out of scope; note it and defer.
- **Cannot codify.** Precise drag paths and timed long-presses captured only as
  coordinates are brittle; flag low-confidence steps for human confirmation
  rather than shipping them silently.
- **No live capture here.** This skill needs a pre-recorded bundle; it does not
  open the viewer or drive the device.

## What this skill does NOT do

- Capture the demonstration (the live viewer / `teach_request` does that).
- Run or replay the workflow (that is the run agent + the post-action settle and
  snapshot check, above).
- Edit an existing taught workflow from scratch (use the refinement prompt in
  `references/teach-synthesis-prompt.md`).
- Fire on transient failures, snapshot-readable tasks, or one-off tasks
  unlikely to recur.
