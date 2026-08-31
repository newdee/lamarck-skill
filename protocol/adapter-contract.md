# lamarck adapter contract

lamarck's core is harness-agnostic: the data files (`data/*.jsonl`,
`data/rubrics/`, `data/learnings/`, `data/replays/`, `data/maturity.json`),
the optimization gate and Iron Rules in `SKILL.md`, and the light-loop
protocol in `protocol/light-loop.md` contain nothing Claude-specific. What
binds an agent harness to that core is an **adapter**, made of three roles.
Implement all three and any agent - Claude Code, pi, Codex, anything that
can run a model over a repo - hosts the same evolution loop over the same
files.

## The three roles

### 1. Collector - append one pending line per observed invocation

Whenever the harness invokes a skill (or any genome the adapter observes),
append one JSON line to `data/pending.jsonl`:

| field | type | meaning |
|---|---|---|
| `"ts"` | string | ISO-8601 UTC, second precision (`2026-08-30T12:00:00Z`) |
| `"session"` | string | harness session/thread id; `""` if unknowable (such entries are drained only by manual runs) |
| `"skill"` | string | the invoked skill's real name, colon and all |
| `"args"` | string | invocation arguments, truncated to 200 chars |
| `"ver"` | string | 8-hex md5 of the target skill's SKILL.md at invocation time; `""` if unresolvable |
| `"transcript"` | string | absolute path to the harness's own execution log for this session; `""` if none. Store the pointer, never a copy |

Collector rules: append-only; must never fail the harness (swallow errors,
leave one line in `data/hook-errors.log`); must skip lamarck's own
invocations (no evaluate-the-evaluator loops); must honor the `off` kill
switch file.

Reference implementation: `scripts/posttool-skill.js` (Claude Code
PostToolUse hook).

### 2. Trigger - decide when evaluation happens

Read `config.json` (`mode`: `every` | `manual` | `threshold`, default
threshold/5) and fire when THIS session's pending count reaches the bar.
Entries from other sessions never trigger on their own - they lack
in-context evidence - but when the trigger already fired and the foreign
backlog is at or above the bar, surface its count once (transcript pointers
decay; silent accumulation loses evidence). Honor `off`. Never fire twice
in one turn.

Reference implementation: `scripts/stop-evaluate.js` (Claude Code Stop
hook).

### 3. Executor - a model that runs the protocol

At trigger time, hand the model `protocol/light-loop.md` verbatim (strip
the authoring comment, collapse whitespace, substitute `{{BACKLOG}}`),
prefixed by a header naming the trigger mode, session id, pending skill
names and the working directory that relative paths resolve against. The
model must have read/write access to the lamarck directory and read access
to the session's own execution trace - the protocol forbids evaluating
from imagination (Iron Rule 8: no visible trace, no verdict; archive
instead).

Escalation (>=2 same-type gaps) loads `SKILL.md` and runs the optimization
gate. Every executor is bound by the Iron Rules, whatever the harness: no
edit without the user's choice (or an explicitly granted auto tier with a
non-empty replay corpus), everything ledgered, everything reversible.

## Adapter notes per harness

- **Claude Code** (reference, shipped): collector = PostToolUse hook,
  trigger + executor = Stop hook whose block reason carries the protocol -
  the turn's own model evaluates at zero marginal cost. Scripts stay in
  `scripts/` (path frozen: existing installs reference it from
  settings.json; other adapters live in `adapters/<harness>/`).
- **Codex** (shipped, `adapters/codex/`): Codex >= 0.142 hooks speak
  Claude-compatible stdin fields AND the same Stop-hook block contract, so
  both shims delegate to the reference scripts. Differences handled: no
  Skill tool (activation = a SKILL.md read, pattern-matched from tool
  input) and no `stop_hook_active` loop guard (a per-session cooldown
  latch substitutes).
- **Cursor** (shipped, `adapters/cursor/`): `postToolUse` collects (same
  SKILL.md-read signal; session identity from `conversation_id`), and the
  `stop` hook injects via `{"followup_message": ...}` - the shim
  translates the reference block contract into that shape. Cursor
  discovers `~/.claude/skills/` natively, so both harnesses exercise the
  same genome files.
- **pi** (shipped, `adapters/pi/`): a single TypeScript extension covers
  all three roles in-process - `tool_call` collects, `agent_settled`
  triggers, `sendMessage(deliverAs: "followUp")` injects the protocol it
  renders itself from the same single-source file.

A harness with no injection path at all still fits the contract at the
`manual` tier: collect continuously, evaluate when the user asks that
harness's model to run the protocol.

## Non-negotiables for any adapter

- One telemetry store per machine; adapters share it (the ledger is the
  cross-harness memory).
- The protocol text is injected from `protocol/light-loop.md`, never
  paraphrased or forked per harness.
- Failure posture: an adapter that breaks silently must still leave one
  diagnostic line in `data/hook-errors.log`; an adapter must never break
  its harness.
