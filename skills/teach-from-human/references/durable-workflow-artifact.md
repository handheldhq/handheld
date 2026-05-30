# Output artifacts + replay/verification contract

Synthesis writes two co-located artifacts. The markdown is the canonical,
durable record; the `workflow.json` is the machine-precise form for
deterministic replay.

## Contents

- [PRIMARY: domain-skill markdown](#primary-domain-skill-markdown)
- [SECONDARY: workflow.json](#secondary-workflowjson)
- [Replay + verification contract](#replay--verification-contract)
- [Post-commit verification](#post-commit-verification)

## PRIMARY: domain-skill markdown

Path: `agent-workspace/domain-skills/<package>/<command-name>.md`

This matches the handheld harness convention exactly — `domain_skills("<package>")`
surfaces it and the run prompt reads it before the agent invents an approach.
Keep the map, not the diary: package names, stable labels/resource-ids, waits,
traps, verification checks. No secrets, no run narration, no raw coordinates as
primary instructions.

Template:

```markdown
# <command-name>

**Package:** com.bank.app
**Task:** Add payee {payee_name} with account {account_number}
**Workflow JSON:** ../../../.handheld/teach/<teach-id>/workflow.json

## Start
Open `com.bank.app` (activity `.PayeesActivity`) — deep link `bankapp://payees`
if available; otherwise `open_app com.bank.app`.

## Variables
| name | description | default |
|------|-------------|---------|
| payee_name | name of the payee to add | Alice |
| account_number | destination account number | 12345678 |
| credential | login password (prompted at replay — never stored) | — |

## Steps
1. **Open the payees screen.** Tap the floating Add-payee button
   (`@by-id:com.bank.app:id/fab_add`, label "Add payee").
   _Checkpoint:_ `wait_for text="Add Payee"`.
2. **Enter the payee name.** Fill the Name field
   (`@by-id:com.bank.app:id/name`) with `{payee_name}`.
   _Checkpoint:_ `wait_for stable`.
3. **Enter the account.** Fill the Account field
   (`@by-id:com.bank.app:id/account`) with `{account_number}`.
   _Checkpoint:_ `wait_for stable`.
4. **Save.** Tap "Save" (`@by-id:com.bank.app:id/save`).
   _Checkpoint:_ `wait_for text="Payee added"`.

## Traps / notes
- The Save button is disabled until both fields are non-empty.
- A re-auth prompt may appear; fill it with `{credential}` (no stored value).
```

A `{credential}` variable shows `—` in the default column and is prompted at
replay — never written into the artifact.

## SECONDARY: workflow.json

Path: `.handheld/teach/<teach-id>/workflow.json`, referenced from the markdown.
Full schema in `references/teach-synthesis-prompt.md` ("Structured-output
schema"). Mobile deltas from the holotab guide schema: `start_url` → `start_app`
(`{package, activity?, deep_link?}`); `steps[].url` → `steps[].screen`;
`checkpoint` is a structured `wait_for` condition
(`{condition: "stable"|"text"|"ref"|"change", value?, timeoutMs?}`); each step
may carry `args` (the concrete MCP tool call) for deterministic replay, with any
credential as a `{credential}` template reference.

## Replay + verification contract

`start_app` → MCP tool:
- no `deep_link`  → `open_app { nameOrPackage: package }`
- with `deep_link` → `launch { target: deep_link }` (VIEW intent)
- first checkpoint after launch confirms arrival
  (`wait_for { condition: "text", value: <first screen string> }`).

Per step:
- target `@by-id:<resource-id>` → resolve via `snap` then act (`tap` / `fill`).
- target by label → `find(text=...)` then act.
- normalized-coord fallback (flagged) → multiply by live `viewport` to get
  pixels, then `tap_at` / `tap {x,y}`. Last resort only.
- after each step, evaluate `checkpoint` with `wait_for { condition, value?,
  timeoutMs? }`.

Fallback ladder (a checkpoint failure drops exactly one rung — never silently
continue):
1. deterministic `workflow.json` `steps[].args`
2. LLM-interpreted markdown playbook (tolerates UI drift)
3. from-scratch with a fresh `snap`

Goal verification: confirm the final checkpoint / success condition and report
the outcome plus the evidence observed (same "outcome + evidence" contract the
run prompt enforces). Surface any drift to the user; do not silently roll back.

## Post-commit verification

After writing the artifacts, optionally run the workflow once against the device
and compare the result to the demonstration's final state. If they diverge,
surface the discrepancy to the user — an accurate report of a mismatch is more
valuable than a false success. Do not silently roll back.
