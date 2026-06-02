# Agent-Space Naming

Handheld uses `agent-space/` for the project-local agent environment created by `handheld init` and by harness-shaped `handheld run` workspaces.

## Why `agent-space/`

Lattice's company language is **agent spaces**: persistent, identity-bearing places where agents and humans collaborate across computer, browser, and phone. The generated folder is one concrete instance of that idea, so the singular `agent-space/` is the right project artifact name.

The hyphen matters. `agent-space/` scans as two real words, matches the company phrase, and is easier to read in shell output than `agentspace/`. It also avoids the older Browser Harness phrase `agent-workspace/`, which made the directory sound like scratch storage instead of an agent's durable operating surface.

## Layout

New scaffolds write this shape:

```text
agent-space/
  helpers/agent_helpers.py
  skills/domain/
  skills/interaction/mobile/
  evidence/
```

`helpers/` is for local CLI-agent shims. `skills/domain/` stores package-keyed app knowledge. `skills/interaction/mobile/` stores reusable mobile interaction mechanics. `evidence/` stores proof artifacts from runs.

## Compatibility

`agent-workspace/` remains a legacy compatibility path only. Handheld cleanup removes it when present, and `handheld-harness` still accepts `HH_AGENT_WORKSPACE` for old callers. New docs, prompts, scaffolds, and defaults should use `agent-space/` and `HH_AGENT_SPACE`.
