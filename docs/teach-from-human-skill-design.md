# Teach-from-Human: design proposal

**Status:** proposal / RFC
**Audience:** handheld CLI + agent maintainers
**Author:** design pass grounded in `src/commands/connect.ts`, `src/commands/run.ts`, `src/snapshot.ts`, `src/mcp/server.ts`, `android/tiny-snapshot-helper-v2/`, plus the holotab-teardown teach/synthesis research (findings A/B/C).

---

## TL;DR for the impatient

When the agent is stuck on a device task, it calls a first-party CLI command (`handheld teach`) that force-opens the live device viewer, hands control to a human, and **records what the human does as a trajectory**. A skill (`teach-from-human`) then runs the holotab-teardown synthesis methodology over that trajectory to emit a **durable workflow artifact** — a per-package domain-skill markdown file plus an optional executable step script — that the agent replays and verifies on the next run.

> **⚠️ CORRECTION (post-review):** an earlier draft of this doc claimed handheld has no input capture and must *infer* actions from snapshot-diffs — that was **wrong**. The live viewer **already captures full-fidelity trajectories**. See the **Correction** section immediately below, which supersedes §2's "inference" framing and the §5 "recording fidelity" risk. The rest of the design (the four-gate trigger, the synthesis methodology, the domain-skill artifact, the security constraint, the phased/hint-first plan) still stands.

---

## Correction — the capture already exists (supersedes §2 + the §5 fidelity risk)

The premise that "handheld can't capture input, so we must infer actions from snapshot-diffs" is **false**. Verified against a real exported bundle (`mu-trajectory-<deviceId>-<ts>.zip`, schema `mobile-use.trajectory.v1`) and its source:

- **The live viewer is the recorder.** `apps/app/app/(authenticated)/devices/[deviceId]/live/lib/trajectory-recorder.ts` (class `TrajectoryRecorder`) + `live-view.tsx`. The human acts **through** the web viewer — their pointer input on the video surface (`beginPointerGesture`) is translated by the viewer into the actual device action and sent over the relay. Because the **viewer originates the action, it records it exactly** — every action the viewer sends is wrapped by `recorder.recordAction(...)`. There is no inference and no fidelity gap; this is *better* than the holotab DOM extension, not worse.
- **What's actually captured** (`mobile-use.trajectory.v1`): `actions[]` with exact args — `pointer_tap {x, y, normalized{x,y}}`, `pointer_swipe {x1,y1,x2,y2, delta, normalized{from,to,delta}, durationMs}`, `key {key}` — each with `source` (`phone` | `nav` | `toolbar`), `tStart`/`tEnd`/`durationMs`, `viewport {w,h}`, and `preFrame`/`postFrame` screenshots. Plus `frames[]`, a browser-SpeechRecognition `transcript` + `audio.webm`, an `alignment[]` (action ↔ transcript segment), and a **`skillDraft` placeholder** the schema already reserves for exactly this synthesis. Note: **both raw and *normalized* coordinates are captured**, which solves cross-resolution replay portability for free.
- **Open question #1 (touch coordinates) is ANSWERED** — yes, we have them, exactly, today. The whole "spike getevent / Gateway control channel" investigation is unnecessary.

### Re-mapped gaps (what's actually left to build)

| Piece | Status | Where |
|---|---|---|
| Record the human's actions (exact, + frames + voice) | ✅ **EXISTS** | live viewer `TrajectoryRecorder` |
| Open the live viewer for the human | ✅ **EXISTS** | `connect.ts` `--headed` → `openUrl(viewerUrl)` |
| Bundle the trajectory (`mobile-use.trajectory.v1` zip) | ✅ **EXISTS** | `downloadTrajectoryBundle` (`trajectory-exporter`) |
| **Handoff: get the bundle to the agent** | ❌ **net-new (the real gap)** | today it's a *browser download only* — no server persistence (no API route). The viewer already has direct-upload plumbing (`putFileToDirectUploadUrl`) — lean on it. |
| **Arm "record mode" from the agent** | ❌ net-new (small) | viewer record is a manual button; want a viewer URL param/deep-link the agent can open pre-armed |
| **Synthesis skill (trajectory → durable workflow)** | ❌ net-new (unchanged from below) | the `teach-from-human` skill in §3 — fills `skillDraft` |
| Replay a durable workflow | ❌ net-new, but **tractable** | actions are exact (+ normalized coords + refs); §3's domain-skill + checkpoint replay stands |

### What this changes in the design below

- **§1 / §2:** the CLI command does **not** build a recorder or a snapshot-diff inference engine (delete that). It (a) opens the viewer **pre-armed to record** (`--headed` + a record intent), and (b) **retrieves the bundle** when the human is done. The recording state machine, frame capture, and the entire `inferredAction`/`confidence` apparatus are **moot** — read the real `mobile-use.trajectory.v1` schema instead.
- **§5:** "recording fidelity is the biggest risk" is **deleted.** The new #1 risk/gap is the **handoff** (bundle is client-download-only — MVP: agent watches `~/Downloads/mu-trajectory-*.zip`; proper: viewer uploads to Gateway on stop + a `handheld trajectory pull <session>` command using the existing upload plumbing). The security constraint (never store credentials), the four-gate trigger, and the brittle-deterministic-replay risk all still hold.
- **Component boundary:** this feature lives **across two codebases** — the **live viewer** (`mobile-use-mono/.../live/`, capture: done) and the **handheld CLI + skill** (handoff + synthesis: to build). The original doc framed it as CLI-only; it isn't.
- **Revised phased plan:** Phase 0 (one-line hint → domain-skill) still first. Phase 1 becomes **"wire the existing viewer recorder to the agent"** — `handheld teach` opens the pre-armed viewer, the human records via the viewer that already works, the bundle reaches the agent (Downloads-watch MVP, then upload+pull), and the `teach-from-human` skill synthesizes a domain-skill from the real `mobile-use.trajectory.v1`. No recorder to build.

The sections below are preserved for the parts that remain valid (trigger, synthesis methodology, artifact, wiring, security); read §2 and §5 through this correction.

---

## 1. The CLI command

### Name

**`handheld teach`** is the recommended primary name. It matches the holotab vocabulary the synthesis prompts already assume, reads as a verb the agent can call ("teach me how to do X"), and is symmetric with the existing `handheld run` (agent does it) / `handheld teach` (human shows it) pair.

`handheld handoff` is a reasonable alias and is arguably more honest about the *interaction* (control changes hands), but it under-sells the durable-learning half. Recommendation: ship `teach` as canonical, register `handoff` as a hidden alias for discoverability.

### Synopsis

```
handheld teach <objective...> [flags]

  <objective>            one-line description of the task the human will demonstrate
                         (becomes the synthesis task_instruction; see §3)

  --device <id>          target device (falls back to default-device, like every other cmd)
  --package <pkg>        app the workflow is keyed to; if omitted, inferred from current_app
  --headed               open the viewer automatically (default true for `teach`; see note)
  --no-headed            record without opening a viewer (human already has the device open)
  --poll-ms <n>          snapshot/screenshot sample interval during recording (default 600)
  --timeout <sec>        max recording duration before auto-stop (default 900)
  --voice                enable voice narration capture if a mic bridge is configured (Phase 3)
  --out <dir>            where to write the raw trajectory (default ./.handheld/teach/<id>/)
  --synthesize           run the teach-from-human skill immediately after stop (default true)
  --no-synthesize        capture only; leave synthesis to a later explicit skill invocation
  --json                 machine-readable progress + final artifact paths
```

### Exact behavior (the recording state machine)

1. **Resolve + connect.** Reuse `connectDevice({ deviceId, headed: true })` from `connect.ts` verbatim. That already:
   - resolves `viewerUrl` through the three-layer priority chain (`startResult.h5.viewerUrl` → `relayInfo.h5.viewerUrl` → `liveDetail.activeSession.h5.viewerUrl`),
   - calls `openUrl(viewerUrl)` to pop the OS browser at the live device,
   - bootstraps the relay + ADB tunnel + Tiny helper.
   **Reused, not built.** The only change: `teach` defaults `headed` to true and surfaces the `viewerUrl` explicitly in `--json` (it already does — `printConnectResult` emits `viewer.url`).

2. **Establish a recording baseline.** Take an initial `snap` (full snapshot via Tiny `/v2/snapshot`), a screenshot (`tiny screenshot`), record `current_app`, and note the Tiny `eventSeq` high-water mark from `/v2/events`. Write a `trajectory.json` header (schema in §2).

3. **Hand over + record.** Print a clear human-facing banner to stdout (and to the agent via `--json` events): *"Live viewer open at `<url>`. Do the task now. Press Enter here (or run `handheld teach --stop`) when finished."* Then enter the capture loop:
   - **Poll loop** every `--poll-ms`: read `/v2/events` since the last seq (cheap), and whenever the filter-independent `layoutDigest` changes OR an `AccessibilityEvent` of an interesting type fires (`VIEW_CLICKED`, `VIEW_FOCUSED`, `VIEW_TEXT_CHANGED`, `VIEW_SCROLLED`, `WINDOW_STATE_CHANGED`, `WINDOW_CONTENT_CHANGED`), capture a fresh `snap` + screenshot and append a raw **frame** to the trajectory.
   - This is a **state-sampling recorder**, not an input recorder (see §2 and §5 for why this is the only option on mobile).

4. **Stop.** Triggered by Enter on the controlling terminal, an explicit `handheld teach --stop`, the `--timeout`, or a SIGINT. On stop: flush the final frame, take a closing screenshot, write `trajectory.json` to `--out`.

5. **Synthesize (default).** Unless `--no-synthesize`, invoke the `teach-from-human` skill (§3) on the just-written trajectory, producing the durable workflow artifact(s), then print their paths.

### Where things are stored

```
./.handheld/teach/<teach-id>/
  trajectory.json          raw recorded frames (the §2 schema)
  frames/                   screenshots, frame-NNN.png
  objective.md             the human-language objective passed in
  workflow.json            synthesized durable workflow (§3 output)         [after synth]
  skill.md                 rendered domain-skill markdown                    [after synth]
```

`<teach-id>` is a slug derived from the objective + timestamp + random hex, identical to `buildRunId()` in `run.ts` (reuse that function). This intentionally mirrors the `.handheld/runs/<id>/` workspace layout so a teach session and a run session are siblings, and so a `run` workspace can later reference a teach workflow by path.

### Reuse vs. net-new

| Capability | Source | Status |
|---|---|---|
| Open live viewer in browser | `connect.ts` `openUrl` + `viewerUrl` chain + `--headed` | **Reuse verbatim** |
| Connect relay/ADB/Tiny | `connect.ts` `connectDevice` | **Reuse verbatim** |
| Snapshot capture | `snapshot.ts` / Tiny `/v2/snapshot` | **Reuse** |
| Accessibility event stream | Tiny `/v2/events` (`EventLog.java`) | **Reuse** |
| Screenshots | Tiny `/v2/screenshot` | **Reuse** |
| Workspace/run-id/dir scaffolding | `run.ts` `createRunWorkspace`, `buildRunId` | **Reuse pattern** |
| Recording state machine + poll loop | — | **Net-new** |
| Human "I'm done" signal / handover gate | — | **Net-new** (gap #1 in finding C) |
| Frame → semantic action inference | — | **Net-new** (gap #2; this is the hard part) |
| Trajectory serialization format | — | **Net-new** (gap #3) |

---

## 2. Recording → trajectory handoff

### What is actually captured (and the honest mobile gap)

This is where mobile diverges hard from the holotab browser extension. Finding B describes a content script that intercepts **raw DOM events** — `click {x,y,elementInfo}`, `keydown {key,code}`, `wheel {deltaX,deltaY}` — directly off the page, with pixel-perfect element identity and exact keystrokes. **Handheld cannot do this.** Confirmed against the code:

- The relay `viewerUrl` is a **WebRTC/H5 video surface** served by the Gateway. The human's taps land on the *remote device*; there is no reverse channel that mirrors them back to the CLI as structured events. `openUrl` is explicitly fire-and-forget (`child.unref()`), and there is no local server or webhook subscribed to the viewer session (gap #6 in finding C).
- **Tiny v2 is a state oracle by design.** Its README is explicit: the only mutating endpoint is `POST /v2/setText`; `/v2/input` (pointer injection in `InputService.java`) is for the *host to act*, not to capture. `/v2/events` (`EventLog.java`) records `AccessibilityEvent` metadata only — `{seq, timeMs, type, typeName, packageName, className, text}`. **There are no coordinates and no source-node ref on those events.** So even the native signal we do have is coarse: it tells you *that* a click happened in some package on some class with some text, not *where* or *on which ref*.

The consequence: handheld records a **state-sampled trajectory** and **infers** the human's action between consecutive frames, rather than capturing the action directly. Each frame is a `(snapshot, screenshot, events-since-last)` triple. The inference step (a) diffs the two snapshots to find what changed (focus moved, a checkbox flipped, a new screen appeared, text appeared in a field), (b) correlates with the accessibility events in the gap, and (c) emits a best-guess semantic action drawn from the handheld MCP vocabulary (`tap`, `fill`, `scroll`, `open_app`, `back`, etc.).

This is strictly lower fidelity than holotab's DOM interception. It is good enough to reconstruct *the sequence of screens and the salient action on each*, which is exactly what the synthesis step needs (synthesis already throws away most low-level detail). It is **not** good enough to capture, say, a precise drag path or a long-press duration. §5 is honest about where this breaks.

### Captured per frame

| Field | Source | Notes |
|---|---|---|
| `seq` | monotonic | frame index |
| `capturedAt` | clock | ISO8601 |
| `snapshot` | Tiny `/v2/snapshot` (`SnapshotDocument`) | nodes with `ref`, `stableId`, `label`, `role`, `bounds`, `editable`, `checked`, `focused`, `identifier` (resource-id), plus `layoutDigest`, `appName`, `bundleId`, `activity` |
| `screenshot` | Tiny `/v2/screenshot` | path under `frames/`; sampled subset embedded for synthesis |
| `events` | Tiny `/v2/events` since last seq | `[{type, typeName, packageName, className, text, timeMs}]` |
| `app` | `current_app` | `{package, activity}` |
| `inferredAction` | inference pass (net-new) | `{ tool, args, confidence, evidence }` (see below) |
| `voiceText?` | mic bridge (Phase 3) | nearest narration segment |

### The trajectory format handed back to the agent

Adopt the **finding-B event-array shape**, adapted for mobile. The top-level mirrors the holotab vault trajectory (`id`, `status`, `objective`, `created_at/started_at/finished_at`, `viewport_width/height`, `events[]`, `metadata`) so anyone who has seen a holotab trajectory recognizes it. The event objects, however, are mobile-native:

```jsonc
{
  "id": "2026-05-30T...-add-payee-a1b2c3",
  "kind": "teach",                       // distinguishes from an agent run trajectory
  "agent": "human",
  "device_id": "...",
  "package": "com.bank.app",
  "objective": "Add a new payee named {payee_name} with account {account_number}",
  "status": "completed",                 // completed | stopped | timed_out
  "created_at": "...", "finished_at": "...",
  "viewport_width": 1080, "viewport_height": 2400,
  "events": [
    {
      "type": "DeviceObservationEvent",   // analog of holotab's observation_event
      "data": {
        "snapshot_digest": "ab12...",
        "app": { "package": "com.bank.app", "activity": ".PayeesActivity" },
        "screenshot": "frames/frame-007.png",
        "salient_nodes": [ { "ref": "@e5", "stableId": "...", "label": "Add payee", "role": "Button", "identifier": "com.bank.app:id/fab_add" } ]
      },
      "timestamp": "..."
    },
    {
      "type": "HumanActionEvent",         // mobile analog of holotab's WebActionEvent
      "data": {
        "inferred": true,                  // ALWAYS true on mobile — this is a reconstruction
        "confidence": 0.82,
        "action": {
          "tool": "tap",                   // drawn from the handheld MCP tool vocabulary
          "args": { "target": "@e5" },     // ref preferred; falls back to {x,y} when no ref matched
          "target_node": { "stableId": "...", "label": "Add payee", "identifier": "com.bank.app:id/fab_add" }
        },
        "evidence": {
          "accessibility_events": [ { "typeName": "TYPE_VIEW_CLICKED", "className": "android.widget.Button", "text": "Add payee" } ],
          "snapshot_diff": "focus→@e5; new activity .AddPayeeActivity",
          "pre_screenshot": "frames/frame-007.png",
          "post_screenshot": "frames/frame-008.png"
        }
      },
      "timestamp": "..."
    }
    // ... write/fill, scroll, back, etc.
  ],
  "metadata": { "poll_ms": 600, "fidelity": "state-sampled-inferred" }
}
```

Key deltas from the finding-B schema, called out explicitly:

- **`WebActionEvent` → `HumanActionEvent`.** The action vocabulary is the **handheld MCP tool set** (`tap`/`fill`/`scroll`/`open_app`/`back`/`swipe`/`key`…), not browser actions (`goto`/`click`/`write`). This is deliberate: the durable workflow must replay through the same MCP tools the agent already has, so recording in that vocabulary means zero translation at replay time.
- **`element.xpath`/`coordinates`/`bounding_box` → `target_node` keyed by `stableId` + `identifier` (resource-id) + `label`.** Mobile has no DOM/xpath; the durable handle is Tiny's `stableId` and the Android resource-id. Pixel coordinates are kept only as a last-resort fallback and flagged, mirroring the synthesis rule "NEVER pixel coordinates" for the *durable* output.
- **`inferred: true` everywhere.** Every human action is a reconstruction, never a capture. The agent reading this trajectory must treat `confidence` as real and prefer high-confidence steps. This honesty field has no analog in holotab because holotab's actions are ground truth.
- **Screenshots are local files, not CDN URLs.** holotab stores `https://.../screenshot-*.jpg`; handheld writes `frames/frame-NNN.png` under the teach dir. Synthesis embeds a sampled subset as base64 (the same `SYNTHESIS_MAX_SCREENSHOTS` sampling from finding A).

### Where stored

Raw trajectory at `./.handheld/teach/<id>/trajectory.json` with screenshots under `frames/`. Handed to the agent as a file path (the agent reads it; we do **not** stream the whole base64 blob through the agent's context). The synthesis step (a skill, §3) consumes it and emits the durable artifact.

---

## 3. The skill

### Name + registration

**Skill name: `teach-from-human`.** It is a first-party skill shipped with the handheld CLI (not a user dotfile), so the agent always has it (see §4). Two responsibilities: (a) tell the agent *when* to reach for a human, and (b) convert a recorded trajectory into a durable workflow using the holotab synthesis methodology.

### The precise "when to use" trigger

The whole point is that the agent reaches for this **exactly when stuck, and not before** (a human handoff is expensive — see §5). The skill's trigger description, written so the agent self-selects correctly:

> **Use `teach-from-human` when, and only when, you have genuinely exhausted autonomous options on a device task** — specifically when **all** of these hold:
> 1. You have tried at least two distinct approaches (e.g. different entry points / different snapshot refs / search vs. menu navigation) and re-observed state after each, and you are still not making progress toward the objective;
> 2. The blocker is *knowledge*, not a transient (not "the app is still loading", not "Tiny is bootstrapping" — those call for `wait_for`/retry, never a human);
> 3. A human physically present could plausibly demonstrate the step in under a minute (a login wall, a CAPTCHA, a non-obvious gesture, an app-specific flow you can't infer from the snapshot);
> 4. No existing domain-skill for this package already covers the flow (check `agent-workspace/domain-skills/<package>/` first — if the human already taught it, replay instead of re-teaching).
>
> Do **not** use it for: tasks you can complete by reading the snapshot more carefully, transient failures, ambiguity that a one-line clarifying question would resolve, or anything where a human isn't actually available. When in doubt, ask a clarifying question first; escalate to a full demonstration only when a *verbal* answer wouldn't unblock you.

This four-gate trigger is the single most important behavioral knob. It is the difference between a useful escape hatch and an agent that fobs every minor snag onto a human.

### Trajectory → durable workflow (reusing the finding-A methodology)

The conversion is **the holotab `teach_synthesis_system_prompt` pipeline, ported to mobile**, cited from finding A:

1. **Per-frame annotation (finding A's `teach_live_annotation_prompt`).** For each `DeviceObservationEvent` + following `HumanActionEvent`, produce a factual 3–5 sentence annotation ("User tapped the floating Add-payee button; the Add Payee screen opened with empty Name and Account fields"). This is the `Observation:` line that becomes each `[STEP=N]` block. We can run these *live* during recording (as holotab does, to amortize latency) or in a batch at synthesis time. **Recommendation: batch at synthesis** for the MVP — live annotation needs a VLM call per frame and adds recording-time latency for marginal benefit.

2. **Synthesis (finding A's `teach_synthesis_system_prompt`).** Assemble the `<execution_trace>` ( `[STEP=N]` blocks with `Action:` / `Page:`→`Screen:` / `Observation:` / optional `Voice narration:`), the `<literal_values_observed>` (every text the human typed via inferred `fill` actions, with the verbatim warning *"do NOT automatically promote each one to a variable"*), the `objective` string as the explicit `task_instruction`, and a sampled set of embedded screenshots. Apply the five methodology steps verbatim from finding A:
   - intent reasoning first (the ephemeral `reasoning` field),
   - critical-path filtering (drop exploratory taps, corrections, the navigation overhead of getting *to* the app),
   - conservative variable extraction (only what a human would plausibly vary next run; every `{placeholder}` must have a `suggested_variables` entry; `task_pattern` must reference all of them),
   - step generation with a `checkpoint` per step (no pixel coords),
   - kebab-case `command_name`.

   The synthesis runs through the handheld agent itself (Claude) with the finding-A structured-output schema (`reasoning` / `command_name` / `task_pattern` / `start_url`→`start_app` / `suggested_variables` / `steps[]` / `additional_context`), so **no new model endpoint is needed** — it is a prompt + JSON-schema the skill carries.

3. **Refinement (finding A's `standalone_refinement_prompt`).** If the human or agent wants to edit the synthesized workflow ("the account field is always the same, drop that variable"), the skill applies the surgical-editor refinement prompt and returns the complete updated workflow JSON. Same structural rules enforced.

Mobile adaptations of the schema (small, principled):
- `start_url` → `start_app` (`{ package, activity?, deep_link? }`). Reuse `open_app` semantics.
- step `details` reference **labels / resource-ids / Tiny stableIds / relative position**, never pixel coordinates — this is *already* the synthesis rule, it maps cleanly onto Android's accessibility identifiers.
- each step's `checkpoint` is expressed as a `wait_for` condition where possible (`{condition: "text", value: "Payee added"}` or `{condition: "ref"}`), so verification is mechanically checkable at replay (§ replay).

### The durable workflow artifact — concrete choice

There are three candidate artifact forms (mirroring finding C's three partial primitives). The recommendation is **a layered artifact, not a single form**, because each layer serves a different replay confidence level:

1. **PRIMARY: a per-package domain-skill markdown** at `agent-workspace/domain-skills/<package>/<command-name>.md`. This is the durable, human-and-agent-readable record. It is keyed by Android package (matching the harness's existing `domain-skills/<package>/` convention exactly), contains the synthesized `task_pattern`, the `steps[]` with their checkpoints, the `suggested_variables`, stable resource-ids/labels, and the `additional_context` traps. **This is the canonical artifact.** It plugs directly into the mechanism that already exists: `run.ts` seeds `agent-workspace/domain-skills/`, the run prompt already instructs the agent to "Keep durable app facts under agent-workspace/domain-skills," and the harness SKILL.md already tells the agent to read these before inventing an approach. **We are filling finding C's gap #5 (domain-skill write-back from human demonstration) with zero new read-path plumbing.**

2. **SECONDARY: a structured `workflow.json`** (the finding-A synthesis schema, verbatim) co-located in the teach dir and referenced from the markdown. This is the machine-precise form an MCP `replay_workflow` tool reads (Phase 2). It is the same JSON the synthesis step already produces — we just persist it.

3. **OPTIONAL (Phase 3): a deterministic step script** — an ordered list of concrete MCP tool calls (`[{tool:"open_app",args:{package}}, {tool:"fill",args:{target:"@by-id:...id/name", text:"{payee_name}"}}, ...]`) that a new `handheld replay <workflow.json>` command can execute **without an LLM in the loop** (finding C gap #4). This is the holy grail for cost/determinism but the most brittle (see §5), so it ships last and always with an agent fallback.

Why not pick just one: the markdown is robust but requires the agent (LLM) to re-interpret at replay; the step script is cheap and deterministic but brittle to UI drift. Layering lets the agent **prefer the cheap deterministic script, fall back to the LLM-interpreted markdown** when the script's checkpoints fail. That fallback ladder is the whole value proposition.

### How the agent replays it later (+ verification)

At the start of any `run`, the agent already reads `agent-workspace/domain-skills/<package>/`. With a taught workflow present:

1. **Match.** The agent (or a slash-command `/add-payee`) recognizes the `command_name` / `task_pattern` matches the current objective and binds `suggested_variables` from the objective ("add payee Alice / acct 123" → `{payee_name: "Alice", account_number: "123"}`).
2. **Replay.** Phase 1: the agent executes the markdown steps through normal MCP tools, substituting variables. Phase 2+: `replay_workflow` runs the `workflow.json` steps; Phase 3: `handheld replay` runs the deterministic script.
3. **Verify each step.** After each step, evaluate its `checkpoint` via `wait_for` (text/ref/stable) — exactly the mechanism that already exists. A failed checkpoint means the UI drifted; the agent **falls back one rung** (deterministic script → markdown → from-scratch with the snapshot) rather than blindly continuing. This per-step checkpoint is the synthesis methodology's `checkpoint` field doing real work, not decoration.
4. **Verify the goal.** The final `additional_context` / objective gives the success condition; the agent confirms it and reports evidence (the same "final answer: outcome plus evidence" contract the run prompt already enforces).

---

## 4. First-party wiring — how the agent ALWAYS knows

Three registration points, so the capability is never something the agent has to be told about:

1. **MCP tool: `teach_request`** (net-new, added to `src/mcp/server.ts` alongside `connect`/`snap`/`tap`/…). Signature roughly `{ objective: string, package?: string }`. Calling it: (a) opens the headed viewer, (b) starts the recorder, (c) **blocks the agent's loop** until the human signals done (this is finding C gap #1 — the handover gate — implemented as a long-poll the MCP tool awaits), (d) returns the trajectory path + synthesized workflow path. Because it is a handheld MCP tool, every `run` workspace (which is locked to `mcp__handheld__*`) exposes it automatically. **The agent discovers it the same way it discovers `tap`.**

2. **Skill registration: `teach-from-human`** shipped in the CLI package and listed in the run prompt's tool/skill preamble. The `renderPrompt()` in `run.ts` gains a line: *"If you get genuinely stuck on a device step (see the teach-from-human trigger gates), call `teach_request` to bring in a human and learn the flow durably — then replay it."* This is the one-line nudge that makes the escape hatch top-of-mind without encouraging overuse.

3. **Read-path already wired.** The run workspace already seeds `agent-workspace/domain-skills/` and the prompt already says to consult it. Taught workflows land there, so **reuse is automatic** — the agent reads a taught skill on the next run with no new instruction.

### End-to-end loop

```
agent runs task ──► stuck (2 approaches failed, knowledge gap, human could show it)
   │
   ├─ checks domain-skills/<pkg>/ ── already taught? ──► replay (skip to ▼ verify)
   │
   ▼ not taught
calls MCP teach_request{objective, package}
   │
   ├─ connectDevice({headed:true}) ──► openUrl(viewerUrl)   [REUSED]
   ├─ banner: "viewer open, do the task, press Enter when done"
   ├─ recorder polls snap + /v2/events + screenshot ──► trajectory.json   [NET-NEW]
   │      (state-sampled, inferred actions — NOT raw input capture)
   ▼ human presses done  ──► agent loop unblocks (handover gate)   [NET-NEW]
teach-from-human skill:
   ├─ annotate frames (finding A live-annotation prompt)
   ├─ synthesize (finding A teach_synthesis prompt + JSON schema)   [REUSED methodology]
   └─ write domain-skills/<pkg>/<command>.md  + workflow.json
   ▼
agent replays the synthesized steps, substituting variables
   ▼ verify each step's checkpoint via wait_for; verify final goal
   ▼
next time: domain-skill present ──► replay directly, no human needed
```

---

## 5. Honest assessment

### Is full human demonstration the best approach? Compared to the alternatives:

| Approach | Cost to human | Durability | When it wins |
|---|---|---|---|
| **Agent asks a clarifying question** | one sentence | low (not saved) | the blocker is *ambiguity* ("which account?"), not *knowledge* |
| **Agent retries with more tools / more careful reading** | none | n/a | the answer was in the snapshot all along (most "stuck" cases) |
| **Human writes a one-line hint** ("tap the hamburger then Settings") | one sentence, async | medium (can be saved as a domain-skill note) | the human knows the flow but can't be present to demo |
| **Full human demonstration (this proposal)** | ~1 min of live attention | **high** (synthesized, replayable) | a *non-verbalizable* flow: a gesture, a CAPTCHA, a login, an app-specific multi-screen dance the agent can't infer |

**My honest take: the product owner is right to be unsure, and the answer is "yes, but as the top rung of a ladder, not the default."** Most agent "stuck" states are not knowledge gaps — they're impatience (UI still loading), under-reading the snapshot, or ambiguity a single question resolves. Full demonstration is the **expensive escape hatch you reach for last**, which is exactly why §3's four-gate trigger is the load-bearing part of the whole design. If we ship the recorder/synthesizer but get the trigger wrong, we will have built an annoyance. If we get the trigger right, demonstration is genuinely the only thing that durably teaches a non-verbalizable flow — and the holotab teardown proves the synthesis half works.

A strong **intermediate** worth shipping *before* full demonstration: the **one-line hint → domain-skill** path. It captures most of the durable-learning value (the agent writes what the human said into `domain-skills/<pkg>/`) for a fraction of the build cost and human cost. I'd argue this should be Phase 0.

### Risks

1. **Recording fidelity is structurally limited (the big one).** As established in §2, handheld cannot intercept input the way the browser extension does. Inferred actions will sometimes be wrong: a tap on an unlabeled custom view with no resource-id degrades to `{x,y}` (brittle); a precise drag or a timed long-press is essentially uncapturable; two rapid taps may collapse into one frame; a screen that changes without an accessibility event (canvas/game UI) is invisible to the diff. **Mitigation:** the `confidence` field and `inferred:true` are first-class; low-confidence steps are flagged for the human to confirm during synthesis; the durable artifact prefers stable resource-ids and falls back to LLM-interpreted markdown (which tolerates drift) over deterministic scripts (which don't).

2. **Brittle replay.** Deterministic step scripts (Phase 3) break the moment the app updates its layout. **Mitigation:** the layered artifact + per-step checkpoint + fallback ladder (script → markdown → from-scratch). Never ship a deterministic replay without the LLM fallback.

3. **Trigger misfire / learned helplessness.** If the agent over-calls `teach_request`, it trains users to expect to babysit. **Mitigation:** the four gates, the "clarifying question first" rule, and a rate signal (if `teach_request` fired for this package recently, prefer replaying what was just taught).

4. **Security / sensitive input.** A human demonstrating a login types a password into the live viewer. holotab redacts password fields (`key:"Unidentified", sensitive:true`); handheld's accessibility events already mask password-node text, and `snap` flags `password`/editable nodes — but **the synthesized workflow must never store the literal credential as a variable value or default.** This must be an explicit synthesis constraint: any `fill` into a node flagged `password`/sensitive becomes a `{credential}` variable with **no stored value**, prompted at replay. This is non-negotiable and must be in the synthesis prompt.

5. **Handover gate UX.** Blocking the agent loop on a human is novel for this CLI. If the human walks away, the `--timeout` must fire and the agent must degrade gracefully (report "human did not complete demonstration", fall back to asking a question). The MCP `teach_request` blocking semantics need careful timeout + cancellation handling.

### When NOT to use it

- Transient failures (loading, bootstrapping) — retry/`wait_for`, never a human.
- Anything a clarifying question resolves — ask first.
- When no human is available — the trigger must check/assume availability; a blocked `teach_request` with no human is a hang.
- Flows already covered by an existing `domain-skills/<pkg>/` entry — replay, don't re-teach.
- One-off tasks unlikely to recur — the synthesis overhead isn't worth it; just have the human do it in the viewer and move on (`--no-synthesize`).

### Open questions (genuine, not papered over)

1. **Can we get a richer human-input signal than accessibility events?** Options to investigate: (a) does the Gateway relay expose the human's touch coordinates from the WebRTC control channel? If so, a Gateway-side event stream (finding C gap #6) would massively improve fidelity and is worth a spike *before* committing to pure snapshot-diff. (b) `adb shell getevent` can capture raw touch on a device we hold via ADB — but it emits raw kernel coordinates needing per-device calibration, and it's unavailable on relay-only sessions. Worth prototyping for `--local`/ADB sessions specifically. **This is the highest-leverage open question; the answer changes the recorder architecture.**
2. **Live vs. batch annotation** — does live per-frame annotation (holotab's choice) materially improve synthesis quality enough to justify the recording-time VLM latency on mobile? Default to batch; measure.
3. **Variable binding at replay** — how does the agent reliably map a free-text objective ("add Alice, account 123") onto `suggested_variables`? holotab leans on the `task_pattern` template; we inherit that, but mobile objectives may be messier. Needs a binding step, possibly its own small prompt.
4. **Multi-app flows** — the domain-skill artifact is keyed by a single package. A flow that spans apps (share sheet → another app) needs either a multi-package key or a "flows" namespace. Defer, but note it.
5. **How does a deterministic replay address a node?** `stableId` is per-session, resource-id is durable but not always present, label is human-readable but localized/volatile. The replay node-addressing scheme (`@by-id:` / `@by-label:` / `@by-stable:` with fallback order) needs design before Phase 3.

### Phased build plan

- **Phase 0 — one-line hint → domain-skill (cheapest durable win).** No recorder. When stuck, the agent asks the human for a one-line hint and writes it (lightly structured) into `agent-workspace/domain-skills/<package>/`. Proves the read/replay path and the trigger gates with almost no new code. *This de-risks everything and may capture 60% of the value.*
- **Phase 1 — MVP recorder + synthesis → markdown.** `handheld teach` opens the headed viewer (reuse `connectDevice`), runs the state-sampled poll-loop recorder, writes `trajectory.json`, and the `teach-from-human` skill synthesizes a **domain-skill markdown** (finding A methodology). Replay is LLM-interpreted (the agent reads the markdown). MCP `teach_request` with the blocking handover gate. **No deterministic replay yet** — markdown + agent is the whole loop. Ship the security constraint (no stored credentials) from day one.
- **Phase 2 — structured `workflow.json` + `replay_workflow` MCP tool.** Persist the synthesis JSON; add an MCP tool that replays it step-by-step with per-step `checkpoint` verification and the fallback ladder. Still LLM-mediated per step, but structured.
- **Phase 3 — deterministic `handheld replay` (no LLM) + richer capture.** The deterministic step script and node-addressing scheme (open question #5); the `getevent`/Gateway touch-coordinate spike (open question #1) if it panned out; voice narration. Always with the LLM fallback. This is where cost/latency wins land, and where brittleness risk is highest — gate it behind solid checkpoints.

---

## Appendix: primitive reuse map (one glance)

| Need | Existing primitive | File |
|---|---|---|
| Open live viewer | `--headed` → `openUrl(viewerUrl)` | `src/commands/connect.ts` |
| Resolve viewer URL | 3-layer `viewerUrl` chain | `src/commands/connect.ts` |
| Connect transports + Tiny | `connectDevice` | `src/commands/connect.ts` |
| Snapshot (refs, stableId, resource-id, digest) | `SnapshotDocument` / Tiny `/v2/snapshot` | `src/snapshot.ts`, `android/.../SnapshotService.java` |
| Accessibility events (the only native action signal) | Tiny `/v2/events` | `android/.../EventLog.java` |
| Screenshots | Tiny `/v2/screenshot` | `src/tiny-helper.ts` |
| Workspace/run-id scaffolding | `createRunWorkspace`, `buildRunId` | `src/commands/run.ts` |
| Durable-skill read path | `domain-skills/<pkg>/` seeding + run-prompt instruction | `src/commands/run.ts` |
| Step verification | `wait_for {stable|text|ref|change}` | `src/mcp/server.ts` |
| MCP tool surface to extend | tool registry (`tap`, `fill`, `snap`, …) | `src/mcp/server.ts` |
| Net-new: recorder loop, handover gate, action inference, trajectory format, replay | — | to build |
