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
| `"harness"` | string | which harness observed this invocation (e.g. `codex`, `pi`); absent/empty means `claude-code`. The fencing rules treat cross-harness evidence as cross-scenario evidence, so this tag is what keeps one harness's edits from rewriting what another relies on |
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
names and the working directory that relative paths resolve against - and,
where the harness exposes a transcript, **objective signals counted by
code**: per pending entry, from the skill activation to the next one (or
30 minutes, whichever comes first), the number of tool calls, tool results flagged as errors, results reporting a
non-zero exit code, exact-repeat calls (retries) and real user turns
(`{tools,errors,nonzero_exit,retries,user_turns,lines}`, or `null` with a
reason). The protocol makes the model copy these verbatim; they are the
one channel of the evaluation an LLM cannot bend, and the optimization
gate gives them veto power over judge verdicts. The reference trigger
implements this against Claude Code transcripts; an adapter without a
transcript injects `null`.

Context isolation: with `isolation: subagent` in `config.json` the
reference trigger injects a short delegation brief instead of the protocol
body - the executor spawns one subagent that reads the protocol from disk
and the evidence from the transcript, and the main context receives one
line. Command-style adapters that delegate to the reference trigger inherit
this; an in-process adapter without subagents (pi) runs inline. Every
injection starts with `[lamarck: ephemeral - omit from compaction
summaries]` so the harness's compaction drops it first. The
model must have read/write access to the lamarck directory and read access
to the session's own execution trace - the protocol forbids evaluating
from imagination (Iron Rule 8: no visible trace, no verdict; archive
instead).

Escalation (>=2 same-type gaps) loads `SKILL.md` and runs the optimization
gate. Every executor is bound by the Iron Rules, whatever the harness: no
edit without the user's choice (or an explicitly granted auto tier with a
non-empty replay corpus), everything ledgered, everything reversible. An
executor whose harness cannot ask a three-way choice or spawn judge
subagents never edits in place - it downgrades every gate-passing proposal
to `suggestions/<skill>.md`, the same rule as non-interactive sessions.

### 4. Background runner - evolution outside the session

Applying an approved (or auto-tier) proposal is not done in the user's
session. The session enqueues a job (`scripts/evolve-worker.js enqueue`)
and returns to the user's work; a detached worker hands the job to the
harness's **headless CLI** with least privilege - the lamarck directory
and the skills directory only - which applies the edit under the gate
rules, runs replay validation, ledgers the verify record and appends one
line to `data/inbox.md`. The worker then sends an OS notification; the
next `/lamarck` surfaces unread results.

An adapter contributes its headless command template in `config.json`
`background.runners.<name>` with `{prompt}`, `{root}` and `{skills}`
placeholders. Shipped: `claude -p --add-dir --allowedTools ...`,
`codex exec -C -s workspace-write`, `pi -p`. A harness with no headless
CLI sets `background.runner` to `none` and edits land in-session as before.

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

## Self-service: have your agent write the adapter

The private layer of every harness is its hook/event mechanism - exactly
the part the harness's own agent knows best. So the intended workflow for
an unsupported harness is: **the agent writes, lamarck verifies.** This is
a first-time setup step: done once per harness, then the adapter just runs.

Paste this to the new harness's agent, verbatim:

> Read `<lamarck-dir>/protocol/adapter-contract.md` and this harness's own
> hook/extension documentation. Write the lamarck adapter for this harness
> under `<lamarck-dir>/adapters/<harness>/` (command-style collector and
> trigger) plus a `manifest.json` whose samples are this harness's real
> hook payload shapes. Run
> `node <lamarck-dir>/scripts/verify-adapter.js <that manifest>` and
> iterate. Your attempt budget is THREE verifier runs: still red after the
> third, stop writing code and fall back to the shipped generic adapter
> (`<lamarck-dir>/adapters/generic/README.md`) - wire its posttool.js to a
> post-tool event and its stop.js to a turn-end event with the `--emit=`
> envelope this harness consumes. Either way: wire the hooks into this
> harness's config, show me the wiring, and do not disable any existing
> hooks.

**The fallback tier** (`adapters/generic/`): lamarck-provided function
adapters assuming only "JSON on stdin, stdout read back". Bespoke beats
generic on telemetry richness, so the order is bespoke first, generic on a
blown budget - never generic by default, and switching to a later bespoke
adapter keeps the shared ledger.

1. Tell your agent to read this contract and its harness's hook docs, then
   write a command-style collector and trigger (stdin JSON in, stdout out)
   under `adapters/<harness>/`.
2. Have it write a `manifest.json` beside them - the format is documented
   at the top of `scripts/verify-adapter.js`; the `samples` must be REAL
   stdin shapes of that harness, plus a lamarck self-invocation and a
   noise sample.
3. Gate on conformance:

   ```
   node scripts/verify-adapter.js adapters/<harness>/manifest.json
   ```

   The verifier runs in an isolated sandbox and checks the whole contract:
   schema-complete pending lines, garbage tolerance, the `off` switch,
   self-exclusion, threshold behavior, and that the injected protocol
   carries every load-bearing clause of the single source. Green means
   wire it; red names what is missing.

The three shipped command-style adapters (`claude-code`, `codex`,
`cursor`) each carry such a manifest and pass the same verifier - it is
the spec's executable half. In-process adapters (like the pi extension)
are outside the verifier's reach; validate those by comparing their
injected text against the reference adapter's on identical state.

## Non-negotiables for any adapter

- One telemetry store per machine; adapters share it (the ledger is the
  cross-harness memory).
- The protocol text is injected from `protocol/light-loop.md`, never
  paraphrased or forked per harness.
- Failure posture: an adapter that breaks silently must still leave one
  diagnostic line in `data/hook-errors.log`; an adapter must never break
  its harness.
