---
title: "feat: Claim live device handoff for Handheld init"
type: feat
status: active
date: 2026-06-02
---

# feat: Claim live device handoff for Handheld init

## Summary

Wire handheld init into the claim-first live-device story. The CLI should open the claim approval URL, claim a warm clean trial phone, start an H5-enabled session, and report durable deviceId plus sessionId through the device-code handoff. The claim surface then mints its own owner-control bridge token; handheld-harness stays a Python/browser-harness-shaped adapter over the CLI.

---

## Problem Frame

The current first-run shape is close but not the right onboarding story. handheld init already owns auth, warm trial claim, session start, relay connect, workspace scaffolding, and handoff updates. The gap is that the browser side cannot safely render the user's own live device from handoff alone because the CLI handoff reports deviceId and status, not the exact active sessionId that claim should use to mint a live owner token.

handheld-harness is not the runtime owner. It shells out to handheld with explicit argv and gives agents Python helpers like snap(), tap_ref(), and fill(). Any device/session/Tiny/ADB/relay behavior belongs in handheld; harness work is limited to docs, readiness hints, and wrapper parity.

---

## Requirements

**Claim launch and approval**

- R1. handheld init without an existing API key must issue a device code with intent init and open the Gateway-provided claim approval URL.
- R2. handheld login and handheld init --no-device must keep login-only approval behavior.
- R3. handheld init --no-open must print the approval URL and code clearly enough for a human to approve elsewhere.
- R4. HANDHELD_API_KEY or saved config auth must keep the current no-browser path; no handoff is reported when no browser approval tab exists.

**Device and session handoff**

- R5. handheld init must claim or reuse a warm clean trial phone through the existing init-device API path.
- R6. handheld init must start or confirm an H5-enabled active session before reporting handoff ready.
- R7. The handoff payload must include durable IDs only: deviceCode, deviceId, sessionId, status, and error when present.
- R8. H5 tokens, viewer tokens, relay URLs, and share tokens must not be persisted in the device-code handoff.
- R9. ready must mean the claim page can mint an owner-control bridge token for the exact session without redirecting to the dashboard as the primary outcome.

**Claim surface contract**

- R10. The external claim surface must mint its own bridge token after reading authenticated deviceId plus sessionId, and must validate that the session belongs to the signed-in account/org.
- R11. The viewer token minted for claim must be owner-controllable, not a read-only share/demo token.
- R12. The claim viewer may offer a dashboard link as a secondary affordance, but the onboarding endpoint is live control in the claim story.

**Harness parity**

- R13. handheld-harness must continue delegating runtime work to handheld; it must not grow a Gateway client, Tiny client, ADB manager, relay client, or session manager.
- R14. Harness docs, --doctor, and first-run hints must describe handheld init as the setup path that claims/connects a phone and scaffolds agent-space.
- R15. Harness helper command mapping must remain stable over the init/claim change.

---

## Key Technical Decisions

- KTD1. handheld owns the runtime flow. The CLI is the source of truth for auth, warm claim, session start, relay/ADB/Tiny connection state, and MCP command behavior.
- KTD2. handheld-harness remains an adapter. It may update hints and tests, but it must not duplicate handheld runtime logic.
- KTD3. The CLI reports durable IDs, not live tokens. Browser claim mints the token at the final authenticated moment so token lifetime and ownership stay local to the web session.
- KTD4. sessionId should be captured at session start or resolved from the confirmed active session before ready handoff. Do not make the claim page guess which active session the CLI meant.
- KTD5. intent init is the branch point for claim. Login-only flows keep their current approval surface and should not accidentally claim a phone.
- KTD6. Tests should pin the JSON and subprocess contracts. The risk here is not hard code; it is silent drift between CLI output, handoff payloads, and harness wrappers.

---

## High-Level Technical Design

Flow:

- User runs handheld init.
- CLI posts a device-code request with intent init.
- Gateway returns a claim approval URL.
- CLI opens or prints that URL.
- User authenticates and approves the claim code in the browser.
- CLI polling receives the approved API key.
- CLI posts init-device and receives or resolves deviceId.
- CLI starts or confirms an H5-enabled session for that device.
- CLI reports handoff ready with deviceId and sessionId.
- Claim reads the handoff, mints an owner bridge token for that exact session, and renders the claim-styled live controllable phone.
- handheld-harness remains outside this browser story and continues calling handheld through subprocess JSON commands.

The critical ownership boundary is between handheld init and claim. handheld creates the real phone/session and reports durable IDs. Claim owns token minting and UI control. Harness sits outside the browser story and keeps using the CLI contract.

---

## Scope Boundaries

**In scope**

- handheld init device-code intent, handoff reporting, session id capture, error handling, JSON output, and docs.
- Tests around handheld auth/init, API client session shape, connect/session reuse, and handoff payloads.
- handheld-harness docs/readiness hints and wrapper contract tests if affected.
- External contract notes for Gateway/app claim token minting.

**Deferred**

- Full claim UI implementation and visual polish.
- Right rail panels, app/file/share controls, teaching panels, and dashboard redesign.
- Public landing-page copy or marketing routing.
- Release/version bump.

**Out of scope**

- Implementing device/session/Tiny/ADB/relay logic in handheld-harness.
- Storing H5 SDK tokens, viewer tokens, relay URLs, or share tokens in the device-code record.
- Making dashboard live view the primary post-init destination.

---

## Implementation Units

### U1. Lock the handheld init claim approval branch

- **Goal:** Keep init and login approval semantics separate and make the claim URL branch explicit.
- **Requirements:** R1, R2, R3, R4.
- **Files:**
  - src/commands/auth.ts
  - src/commands/auth.test.ts
  - src/commands/auth-config-command.test.ts
  - README.md
  - install.md
- **Approach:** Preserve the current intent init post for normal handheld init, keep intent login for login-only flows, and adjust copy/tests so the CLI accepts a Gateway-provided claim URL without hardcoding the route locally.
- **Test scenarios:**
  - handheld init posts intent init when --no-device is absent.
  - handheld init --no-device posts intent login.
  - handheld login posts intent login.
  - handheld init --no-open prints the returned verification URL and user code.
  - Existing API key path skips device-code creation and does not attempt handoff.

### U2. Capture sessionId before handoff ready

- **Goal:** Make ready handoff carry the exact active H5 session claim should use.
- **Requirements:** R5, R6, R7, R8, R9.
- **Files:**
  - src/commands/auth.ts
  - src/api-client.ts
  - src/api-client.test.ts
  - src/commands/auth-config-command.test.ts
  - src/commands/connect-state.test.ts
- **Approach:** Change the init preparation path so startDeviceForInit returns the active sessionId or resolves it from the confirmed active session. Report ready only after sessionId is known. Keep connectDevice reuse compatible so init does not create a second session just to get connection state.
- **Test scenarios:**
  - Fresh start returns a session id and reportDeviceCodeHandoff sends ready, deviceId, and sessionId.
  - Already-active device resolves the active session id and sends the same ready payload.
  - Start-pending or retryable start errors do not produce ready.
  - Handoff payload never includes H5 token, viewer URL, relay URL, API key, or bridge token fields.
  - JSON init output may include connection metadata, but handoff remains durable-ID-only.

### U3. Harden handoff status and error semantics

- **Goal:** Keep claim progress honest when init fails during claim, readiness, start, or connect.
- **Requirements:** R6, R7, R8, R9.
- **Files:**
  - src/commands/auth.ts
  - src/commands/auth-config-command.test.ts
  - src/api-client.test.ts
- **Approach:** Keep the existing provisioning -> starting -> ready/error flow, but make status transitions tied to actual milestones: device id after warm claim, starting before H5 session start, ready after session id. On failure, include deviceId when known and sanitized error; never include token-bearing fields.
- **Test scenarios:**
  - Warm claim failure reports error with no device id.
  - Start failure after claim reports error with device id and no session id.
  - Connect failure after ready does not erase the already-valid deviceId/sessionId handoff unless the session itself failed.
  - Handoff reporting failures do not crash a successful headless API-key init path because no browser is waiting.

### U4. Keep CLI live-view output secondary to claim

- **Goal:** Avoid breaking the onboarding story by making dashboard/live-view URL output the final browser destination.
- **Requirements:** R9, R12.
- **Files:**
  - src/commands/auth.ts
  - src/commands/connect.ts
  - src/commands/connect.test.ts
  - README.md
  - install.md
- **Approach:** Normal browser-approved init should rely on the claim tab for the live viewer. CLI output can still print a live view or dashboard URL as secondary information after connect, but it should not open a dashboard live route at the final moment of init.
- **Test scenarios:**
  - Browser-approved handheld init opens only the verification URL.
  - connectDevice retains explicit headed behavior for users who ask for a viewer outside init.
  - Init output still gives useful terminal next steps for tap, swipe, snap, and shell.

### U5. Update handheld-harness parity docs and checks

- **Goal:** Keep harness aligned with the new init story without moving runtime logic into Python.
- **Requirements:** R13, R14, R15.
- **Files:**
  - ../handheld-harness/AGENTS.md
  - ../handheld-harness/README.md
  - ../handheld-harness/SKILL.md
  - ../handheld-harness/install.md
  - ../handheld-harness/src/handheld_harness/client.py
  - ../handheld-harness/src/handheld_harness/run.py
  - ../handheld-harness/tests/unit/test_client.py
  - ../handheld-harness/tests/unit/test_run.py
  - ../handheld-harness/tests/integration/test_handheld_cli_contract.py
- **Approach:** Update wording and readiness checks only where needed. The harness should continue constructing explicit handheld argv arrays and should keep --doctor focused on CLI reachability, target readiness, .handheld/mcp.json, and agent-space readiness.
- **Test scenarios:**
  - HandheldClient still prefixes HANDHELD_BIN, optional --device, --json, --post-state, and --no-settle correctly.
  - handheld-harness --doctor points missing users to handheld init.
  - No harness code imports or implements Gateway, Tiny, ADB, relay, or session clients.
  - Integration contract test can use a fake handheld binary to prove wrapper arguments remain stable.

### U6. Document and verify the cross-repo claim contract

- **Goal:** Leave future implementers a crisp contract for the Gateway/app side without making this plan pretend those files live here.
- **Requirements:** R10, R11, R12.
- **Files:**
  - README.md
  - install.md
  - docs/proofs/claim-live-handoff-smoke.md
  - ../handheld-harness/docs/proofs/parity-checklist.md
- **Approach:** Add a short proof note after implementation showing the full path: handheld init opens claim, claim approves, CLI reports deviceId/sessionId, claim mints owner token, first frame renders, and a click/touch/nav visibly changes device state.
- **Test scenarios:**
  - Gateway contract accepts sessionId in CLI handoff.
  - Claim rejects mismatched deviceId/sessionId or wrong owner.
  - Claim mints owner-control token rather than share/demo token.
  - Live proof records first frame and visible control result.

---

## Risks and Dependencies

- Gateway must accept, persist, and expose sessionId on CLI handoff before claim can mint against the exact session.
- Claim must validate ownership and session/device match server-side; client-side checks are not enough.
- sessionId shape must be normalized. Current CLI code sees both active session detail and start responses; implementation should pin one canonical field.
- Existing dirty work in both repos should be preserved. Do not revert unrelated edits while implementing this plan.
- handheld-harness is a sibling repo. Its file references in this plan use ../handheld-harness/... from the handheld checkout.
- Live proof needs a real device/session path. Unit tests can pin contract shape, but they cannot prove first frame/control.

---

## Sources and Existing Patterns

- src/commands/auth.ts owns loginWithDeviceCode, reportDeviceCodeHandoff, prepareInitDevice, and handheld init.
- src/api-client.ts owns /cli/init-device, /profiles/:id/sessions, and active-session resolution helpers.
- src/commands/connect.ts owns session reuse/start, relay connect, viewer URL handling, saved connection state, and ConnectDeviceResult.sessionId.
- src/commands/auth-config-command.test.ts, src/api-client.test.ts, and src/commands/connect-state.test.ts are the closest existing tests to extend.
- ../handheld-harness/AGENTS.md states the adapter boundary: runtime behavior belongs in ../handheld.
- ../handheld-harness/src/handheld_harness/client.py shells out to handheld with explicit args.
- ../handheld-harness/src/handheld_harness/run.py exposes the browser-harness-shaped heredoc runner and --doctor.
