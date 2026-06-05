# `handheld.trajectory.v1` — input schema

The bundle the live viewer records and hands to this skill. The viewer
originates each device action, so it records the action **exactly** (no
inference, no fidelity gap). Both raw pixel and normalized [0,1] coordinates are
captured for every tap and swipe, which solves cross-resolution replay
portability at the schema level.

## Contents

- [TrajectoryBundle (top level)](#trajectorybundle-top-level)
- [RecordedAction](#recordedaction)
- [Action vocabulary + args](#action-vocabulary--args)
- [RecordedFrame](#recordedframe)
- [TranscriptSegment / TrajectoryAlignment](#transcriptsegment--trajectoryalignment)
- [Reading it during synthesis](#reading-it-during-synthesis)

## TrajectoryBundle (top level)

```jsonc
{
  "schema": "handheld.trajectory.v1",
  "version": 1,
  "deviceId": "string",
  "sessionId": "string | null",
  "startedAt": "ISO8601",
  "stoppedAt": "ISO8601",
  "durationMs": 123456,
  "actions": [ /* RecordedAction[] — the canonical action log */ ],
  "frames":  [ /* RecordedFrame metadata; base64 omitted in the bundle JSON */ ],
  "transcript": {
    "status": "captured | unavailable | empty",
    "source": "browser-speech-recognition",
    "segments": [ /* TranscriptSegment[] */ ]
  },
  "audio": {
    "path": "audio.webm | null",
    "mimeType": "string",
    "status": "captured | denied | unavailable | empty"
  },
  "alignment": [ /* TrajectoryAlignment[] — actionId ↔ transcript within ±2000ms */ ],
  "skillDraft": {
    "source": "human-recording",
    "name": null,
    "intent": null,
    "notes": "string"
  }
}
```

`frames[]` here is metadata only (`Omit<RecordedFrame,"base64">`); the PNG
bytes live in the separate `TrajectoryExport.frames` array inside the zip and on
disk under `frames/`.

`skillDraft` is the schema's reserved synthesis-hint slot — the synthesis output
fills `name` (→ `command_name`), `intent` (→ `task_pattern`), and `notes`.

## RecordedAction

```jsonc
{
  "id": "a00001",                 // "a00001", "a00002", ...
  "requestId": "string",
  "source": "agent | nav | phone | relay | shell | toolbar",
  "action": "pointer_tap | pointer_swipe | tap | swipe | key | open_app | scroll | fill | screenshot | snap | back | home | ...",
  "args": { /* type-narrows per action — see below */ },
  "tStart": 0,                    // ms since session origin
  "tEnd": 120,
  "durationMs": 120,
  "ok": true,
  "error": "string?",
  "result": "unknown?",
  "viewport": { "width": 1080, "height": 2400 },
  "preFrame": "frames/a00001-pre.png",
  "postFrame": "frames/a00001-post.png"
}
```

`source: "phone"` marks a real human finger action (`pointer_tap` /
`pointer_swipe`). `source: "agent" | "relay" | "toolbar"` mark actions the
system/agent originated. For human-demonstration synthesis, the human's intent
lives in the `phone`-sourced actions.

## Action vocabulary + args

**`pointer_tap`** (human finger, `source:"phone"`):
```json
{ "x": 540, "y": 1200, "normalized": { "x": 0.5, "y": 0.5 } }
```

**`pointer_swipe`** (human finger, `source:"phone"`):
```json
{
  "x1": 540, "y1": 1200, "x2": 540, "y2": 400,
  "delta": { "x": 0, "y": -800 },
  "normalized": {
    "from":  { "x": 0.5, "y": 0.5 },
    "to":    { "x": 0.5, "y": 0.167 },
    "delta": { "x": 0.0, "y": -0.333 }
  }
}
```

**`tap` / `swipe`** (agent/relay) — same arg shapes as the pointer_* variants.

**`key`** (key injection):
```json
{ "key": "BACK" }   // or "ENTER", an int keycode, etc.
```

**Other agent actions** (`open_app`, `scroll`, `fill`, `screenshot`, `snap`,
`back`, `home`, ...) — args depend on the originating handheld MCP tool.

## RecordedFrame

```jsonc
{
  "id": "a00001-pre",             // "<actionId>-pre" | "<actionId>-post"
  "actionId": "a00001",
  "kind": "pre | post",
  "path": "frames/a00001-pre.png",
  "t": 0,                         // ms elapsed at capture
  "contentType": "image/png",
  "base64": "..."                 // present only in TrajectoryExport.frames
}
```

## TranscriptSegment / TrajectoryAlignment

```jsonc
// TranscriptSegment
{ "id": "s1", "tStart": 0, "tEnd": 900, "text": "tap add payee",
  "confidence": 0.9, "isFinal": true, "source": "browser-speech-recognition" }

// TrajectoryAlignment — co-occurring within ±2000ms
{ "actionId": "a00001", "transcriptSegmentIds": ["s1"] }
```

## Reading it during synthesis

- Walk `actions[]` in order; keep `phone`-sourced actions as the human's intent.
- For each `pointer_tap`, open its `preFrame` and the post-action snapshot, diff
  them, and pick the most stable identifier (resource-id > label) of the node
  that changed state. Use `normalized.{x,y}` only as a flagged fallback.
- Pull `literal_values_observed` from `fill` / text-entry actions — reference
  context only (do NOT make a variable per value).
- Use `alignment[]` to attach the human's voice narration to the right step.
- The synthesis output writes back into `skillDraft.name` / `intent` / `notes`.
