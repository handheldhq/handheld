# Tiny Snapshot Helper v2

Tiny v2 is the durability-focused successor to the original Tiny Snapshot
Helper. It runs in parallel with v1 while callers migrate.

## Identity

- package: `com.example.tinysnapshot.v2`
- runner: `com.example.tinysnapshot.v2/.TinyV2Instrumentation`
- device port: `6792`
- endpoint prefix: `/v2/`
- auth header: `X-Mobile-Harness-Tiny-Token`

Rebuild locally:

```sh
pnpm run build:tiny:v2
```

The script writes the APK to
`android/tiny-snapshot-helper-v2-build/tiny-snapshot-helper-v2.apk`.

## Why v2 exists

Tiny v1 proved that a small, persistent UiAutomation process can make Android
state reads much faster and more reliable than host-side `uiautomator dump` or
full Appium sessions. It also accumulated too many jobs:

- observing state
- dispatching taps and touch payloads
- running debug shell commands
- talking to `touchd`
- keeping an on-device action journal
- deciding whether primitive actions succeeded

That made Tiny health depend on unrelated action transports. A missing or
stale `touchd` daemon could make Tiny action support fail even though snapshots
and event waits were healthy. Shell and action endpoints also expanded the APK
surface area and made ambiguous dispatch harder to reason about.

Tiny v2 narrows the APK back to the durable primitive:

```text
state snapshot -> event wake-up -> stable state -> evidence
```

The host owns action dispatch and validation.

## State-only surface

Tiny v2 keeps:

- `GET /v2/status`
- `GET /v2/snapshot`
- `GET /v2/signature`
- `GET /v2/observe`
- `GET /v2/events`
- `GET /v2/waitForChange`
- `GET /v2/waitForStable`
- `GET /v2/screenshot`
- `GET /v2/capture`
- `GET /v2/responseChunk`

Tiny v2 removes:

- `/act`
- `/actAndWait`
- `/shell`
- `/shellOutput`
- `/actions`
- `touchd` capability advertising

The only mutating endpoint is `POST /v2/setText`. It remains in the APK because
semantic text entry needs in-process access to
`AccessibilityNodeInfo.performAction(...)`. It is advertised as a separate
capability, not as a general action transport.

`setText` treats `text` / `value` as literal input. Leading, trailing, and
all-whitespace values are preserved; option fields such as `mode`, `clear`,
and `target` remain normalized.

`signature` returns the live foreground component, event sequence, and
filter-independent layout digest without sending the full node tree back to the
host. Cached snapshot refs/selectors use it to fail closed when the live screen
no longer matches the snapshot that produced the target.

## Host-side action model

The host-side action loop (the handheld CLI transport layer) performs:

1. read pre-state from Tiny v2
2. resolve the target/ref on the host
3. dispatch through a host executor, initially ADB
4. wait for Tiny v2 event/stability evidence
5. validate the post-state on the host

This makes Tiny v2 the witness and the host the actor.

## How this improves on v1

### Transport failures stop poisoning state health

In v1, action endpoints mixed snapshotting with tap, shell, and touchd dispatch.
If `touchd` was missing or a shell call hung, callers could see a Tiny action
failure even though `/snapshot` and `/waitForStable` were fine.

In v2, Tiny only reports state health. ADB, relay, provider API, touchd, or any
future executor can fail independently without making Tiny's observation path
look broken.

### Smaller APK attack and failure surface

Removing shell, touch payloads, and generic action endpoints means fewer code
paths in the instrumentation APK. The v2 capabilities object advertises only
state features plus `setText`.

### Clearer primitive proof

v1 often returned an action result that mixed dispatch, stability, validation,
and transport details in one on-device response. v2 records:

- pre-state evidence
- dispatch evidence
- stable post-state evidence
- validation result

The host can distinguish "the tap was sent" from "the UI changed" from "the
task/domain goal was proven."

### Better replay policy

Generic actions are no longer replayed by the APK. The host journal uses an
`actionId` and conservative validation: if a dispatch acknowledgement is lost,
the host reads fresh state and validates the expected post-state instead of
blindly double-dispatching.

### Mobilewright-style speed without giving up Tiny state

Mobilewright/mobilecli gets snappy Android actions largely by keeping device
control warm instead of starting a new tool chain per call. Tiny v2 follows the
same lesson in the handheld host transport: keep ADB server, port forwarding, and shell
sessions warm, while Tiny provides the state oracle that ADB does not provide
well.

### Parallel migration

v2 uses a separate package and port, so v1 remains shippable while the host
engine migrates. On one device, v1 and v2 should not run at the same time
because Android only allows one active UiAutomation instrumentation
registration. Startup code should stop the other generation before launching a
Tiny helper.

## Validation responsibilities

Tiny v2 handles state collection:

- `eventSeq`
- accessibility nodes
- `treeDigest`
- `actionDigest`
- event history
- stable waits
- optional screenshots
- chunked large responses, including direct screenshots when requested

The handheld host transport handles action-specific interpretation:

- editable tap -> focused
- checkable tap -> checked state changed
- scroll -> digest movement plus scroll/text evidence
- setText -> expected value or masked password-length evidence
- generic tap/key/shell -> UI changed or observed stable state

The host engine should prefer state proof over event-count proof. A digest or
validated post-state change can be enough even when Android does not emit a
matched accessibility event, and an action whose desired state already exists
should not require a digest change just to count as successful.

This is the main durability boundary: Tiny v2 reports what happened; host code
decides whether that proves the requested primitive.
