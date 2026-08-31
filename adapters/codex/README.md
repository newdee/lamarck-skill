# lamarck adapter: Codex CLI

Codex >= 0.142 ships a hooks system whose stdin fields (`session_id`,
`tool_name`, `tool_input`, `transcript_path`) and Stop-hook output contract
(`{"decision":"block","reason":...}`) match Claude Code's. Both shims here
therefore delegate to the reference scripts in `scripts/` and only translate
what differs:

- **posttool.js** (collector): Codex has no Skill tool - a skill activates
  when the model reads its `SKILL.md`. The shim watches every PostToolUse
  event for a `.../<skill>/SKILL.md` path in the tool input, then feeds the
  reference collector a synthesized Skill-shaped event. Over-collection is
  handled downstream by the light loop's `trigger_fit` verdict.
- **stop.js** (trigger + executor): delegates wholesale; adds a per-session
  cooldown latch because Codex has no `stop_hook_active` loop guard.

## Wiring

1. Merge `hooks.json` (replace `<HOME>` with your absolute home path) into
   `~/.codex/hooks.json` - or the `[hooks]` table of `~/.codex/config.toml`.
2. Run `/hooks` inside Codex once to review and trust the two commands
   (Codex trusts hooks by content hash; a lamarck upgrade that changes the
   shims needs re-trusting).
3. Optional: point Codex at your Claude skills so both harnesses exercise
   the same genomes - Codex already reads `~/.codex/skills/`; symlink or
   copy shared skills there.

Telemetry lands in the shared store (`../../data/`), so evidence from Codex
and Claude Code accumulates in one ledger per machine.

## Verification status

Mechanism-tested on this repo's selftest with documented stdin shapes
(fabricated input, real shims, real reference scripts). Not yet validated
against a live Codex session - field reports welcome. The shims fail
closed: on any surprise they exit 0 silently and Codex is never blocked.
