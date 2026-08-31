# lamarck adapter: Cursor

Cursor's Agent hooks (`~/.cursor/hooks.json`) cover all three adapter
roles: `postToolUse` observes tool activity (collector), and the `stop`
hook can hand the agent a `followup_message` - which is exactly an
injected evaluation protocol (trigger + executor). Cursor also discovers
skills from `~/.claude/skills/` natively, so the genomes lamarck watches
are literally the same files across both harnesses.

- **posttool.js** (collector): Cursor has no dedicated Skill tool - a
  skill activates when the agent reads its `SKILL.md`. The shim scans each
  postToolUse payload for a `.../<skill>/SKILL.md` path (transcript and
  workspace fields excluded) and feeds the reference collector a
  synthesized event. Session identity comes from `conversation_id`.
- **stop.js** (trigger + executor): delegates the decision to the
  reference `stop-evaluate.js`, then translates
  `{"decision":"block","reason"}` into Cursor's
  `{"followup_message": ...}`. A per-session cooldown latch guards
  against continuation loops.

## Wiring

1. Merge `hooks.json` (replace `<HOME>` with your absolute home path) into
   `~/.cursor/hooks.json` (create it if absent; project-level
   `.cursor/hooks.json` also works and takes precedence).
2. Restart Cursor so hooks load.

Telemetry lands in the shared store (`../../data/`) - one ledger per
machine across every harness.

## Verification status

Mechanism-tested via this repo's selftest with documented stdin shapes.
Cursor's public docs do not pin the exact tool-field names inside
postToolUse payloads, so the collector extracts tolerantly (whole-payload
scan); not yet validated against a live Cursor session - field reports
welcome. The shims fail closed: on any surprise they exit 0 silently and
Cursor is never blocked or delayed.
