# lamarck

English | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/lamarck-skill)](https://www.npmjs.com/package/lamarck-skill)
[![ci](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![selftest](https://img.shields.io/badge/selftest-74%2F74-brightgreen)](scripts/selftest.js)

**A production self-evolving system for Claude Code skills.** Not a
one-shot optimizer for a hand-picked skill: install once, and every skill
you have (hundreds, if you have them) keeps accumulating evidence from its
real invocations — and evolves when the evidence gate opens. Edits land
with your approval, or — for skills you explicitly promote to auto —
replay-gated and reported after the fact. lamarck evolves itself by the
same rules while it runs (never on auto). Traits acquired through use are
inherited back into the skill file; parts that go unused atrophy. Every
irreversible step is user-authorized, ledgered, and reversible: the
governance is what makes population-wide evolution safe.

```
npx lamarck-skill
```

## The lane

| | [SkillOpt](https://github.com/microsoft/SkillOpt) | [darwin-skill](https://github.com/alchaincyf/darwin-skill) | lamarck |
|---|---|---|---|
| Metaphor | training ground | examination hall | life |
| Signal | benchmark scores | synthetic test prompts + judge panels | **production telemetry**: real invocations, real user corrections |
| Trigger | offline runs | manual runs | hooks observe every skill call, evaluation batches by threshold |
| Rubric | fixed | fixed 9-dim (SkillLens) | **per-skill, dynamic, git-versioned** — crystallized from evidence, evolves with the skill |
| Regression tests | benchmarks | hand-written prompts | **replayed from real traces** (zero authoring) |
| Direction | improve | improve | improve **and prune** (use-it-or-lose-it) |
| Scope | one benchmark target per run | skills you select, each needing test prompts | **every installed skill, passively, zero setup** — per-skill governance levels |

What it keeps from them: SkillOpt's validation gating, bounded edits and
rejected-edit buffer; darwin's git rollback, paired blind judging (escalating
to a 3-judge majority only on close calls) and human-in-the-loop checkpoints.

## Mechanism

1. **Log** (PostToolUse hook): every skill invocation → `data/pending.jsonl`,
   stamped with the target skill's content hash (`ver`) for per-version
   health windows.
2. **Light loop** (Stop hook): a mini evaluation protocol embedded in the hook
   reason — no SKILL.md reload per turn. Four-dimension verdicts, judged
   against the skill's own rubric (scenario-matched entries only) →
   `data/ledger.jsonl`; a user correction crystallizes into a rubric entry
   (n=1, provenance required); lessons → `data/learnings/`; regression cases →
   `data/replays/`, harvested from failures *and* from clean calls whose
   scenario the corpus does not cover yet. Trigger timing is configurable:
   every turn / manual / threshold batch (default: 5).
3. **Evolve** (gated): ≥2 independent same-type gaps → synthesize a bounded
   edit proposal from ALL evidence → user chooses apply / keep as suggestion /
   reject. Replay validation immediately, paired blind judging on the next
   real invocation, per-version health comparison as the statistical backstop.
   Any degradation → rollback proposal.
4. **Trust ladder**: `config.json` grades each skill auto / evolve / suggest /
   observe (default observe; plugins capped at suggest; new skills inherit
   the default). `auto` is earned autonomy: gate-passing edits land without
   asking — replay validation becomes the landing condition (fail = instant
   rollback), every edit is reported, ledgered and one-revert reversible.
   lamarck itself, the Iron Rules and plugins always require explicit
   approval, whatever the config says.
5. **Convergence**: not every iteration pays. After a clean streak (default
   10) a skill goes *stable* — evaluations drop to spot-checks (1 in 5) and
   one-line `stable-skip` records; any user correction, genome change or
   novel scenario wakes it back to active. A long clean streak is itself
   evidence: the report presents it as a production-reliability certificate.

Everything irreversible requires explicit user confirmation. Telemetry never
leaves the machine (`.gitignore`d); rubrics are versioned with the code.

## Architecture: core + adapters

The core is harness-agnostic - the data files, the optimization gate, and
the evaluation protocol ([protocol/light-loop.md](protocol/light-loop.md),
single source, injected verbatim) contain nothing Claude-specific. A
harness plugs in through an **adapter** with three roles - collector
(append a pending line per invocation), trigger (decide when to evaluate),
executor (a model that runs the protocol) - specified in
[protocol/adapter-contract.md](protocol/adapter-contract.md). Claude Code
ships as the reference adapter (the two hooks in `scripts/`); pi is the
first planned second target (its extension mechanism supports all three
roles); Codex can host collector + trigger today but has no way to inject
the protocol back into its model, so it would run at the manual tier.

## Evidence

Honesty policy: **no self-graded scores** (an optimizer scoring its own output
with its own judges proves nothing; LLM self-evaluation accuracy is ~46% per
the SkillLens paper darwin-skill itself cites). Three tiers instead:

1. **Mechanism self-test** — `node scripts/selftest.js`, isolated temp
   sandbox, zero contact with live telemetry. Currently **74/74**: hook
   logging, genome stamping, threshold/every/manual triggers, config
   fallbacks, session isolation, loop guards, byte-reproducible output,
   gitignore boundaries, and liveness of the protocol clauses the light loop
   depends on (rubric wiring, replay harvesting, backlog surfacing).
   CI-able (exit code gated).
2. **Production telemetry** (accumulating by design): every invocation is
   stamped with the target skill's genome hash, so each accepted edit gets
   before/after windows measured in **user-correction rate** — ground truth
   from user behavior, not model self-scoring. Replay validation adds a
   controlled comparison: identical real inputs, old vs new genome. All
   verify verdicts are ledgered; `/lamarck report` aggregates them.
3. **mutation-bench** ([bench/ on GitHub](https://github.com/newdee/lamarck-skill/tree/main/bench),
   protocol preregistered before execution): controlled degradations with
   public ground truth, blind A/B judging. run-001: **4/5 known-degraded
   variants flagged, 0/2 known-improved variants falsely rejected** (single
   judge, majority-of-3-cases; the miss is analyzed, not hidden). Raw
   verdicts committed verbatim.
4. **Self-application** — lamarck evolves under its own rules: every change
   to itself is evidence-triggered, bounded, user-approved and verified.
   [CHANGELOG.md](CHANGELOG.md) is the auditable history — each version
   carries its triggering evidence, diff summary and verification result,
   including four defects caught and fixed under the review discipline the
   log records. No self-graded score — a paper trail instead.
5. **Case studies** — to be published from real usage before any promotion,
   with observational caveats (task-mix drift) stated, not hidden.

## Install

One command — copies the skill, initializes local config, wires both hooks
into `~/.claude/settings.json` (backup first, add-only, idempotent), then
runs the selftest so the install proves itself:

```
npx lamarck-skill
```

(equivalent: `npx github:newdee/lamarck-skill`). Restart Claude Code (or open
`/hooks` once) afterwards so the hooks load. Uninstall (unwires hooks, keeps
files and telemetry): `npx lamarck-skill uninstall`

<details><summary>Manual install</summary>

1. Clone into your skills directory:
   ```
   git clone https://github.com/newdee/lamarck-skill "$HOME\.claude\skills\lamarck"
   ```
2. Copy `config.example.json` to `config.json` (local, untracked) and adjust
   the trigger mode and evolution whitelist.
3. Wire the two hooks into `~/.claude/settings.json` (replace `<HOME>` with
   your absolute home path, using your platform's separators; `args` exec
   form, no shell parsing):
   ```json
   "hooks": {
     "PostToolUse": [{ "matcher": "Skill", "hooks": [{
       "type": "command", "command": "node",
       "args": ["<HOME>/.claude/skills/lamarck/scripts/posttool-skill.js"],
       "timeout": 10 }]}],
     "Stop": [{ "hooks": [{
       "type": "command", "command": "node",
       "args": ["<HOME>/.claude/skills/lamarck/scripts/stop-evaluate.js"],
       "timeout": 10 }]}]
   }
   ```
4. Verify: `node scripts/selftest.js` — all checks must pass.
5. Kill switch: create a file named `off` in the skill directory — silences
   both hooks; manual `/lamarck` invocation still works (explicit intent).

</details>

## Your first week

Nothing visible happens at first — that is the design. Hooks log every
skill invocation silently. After 5 logged calls in a session (the default
threshold), the end-of-turn evaluation writes verdicts to the ledger. Days
pass; evidence accumulates per skill. The first time some skill shows the
same gap twice, you get a three-choice prompt: apply the proposed edit,
park it as a suggestion, or reject it. Clean skills converge and drop to
spot-checks. Cold start is real: no proposals in week one usually means
your skills are healthy, not that lamarck is idle — check
`data/ledger.jsonl` to see it working.

## FAQ

- **How do I know the hooks are alive?** Use any skill, then check
  `data/pending.jsonl` grew. Unexpected hook errors land in
  `data/hook-errors.log` (silence there = healthy).
- **Can I control when evaluation runs?** Yes: `/lamarck mode every`,
  `manual`, or `threshold N` — and `/lamarck` runs it on demand anytime.
- **Which skills can be edited?** Only whitelisted ones
  (`/lamarck evolve add <skill>`). Default is observe: evidence
  accumulates, nothing is touched. Plugins are never edited.
- **Can it evolve without asking me every time?** Yes — promote a
  battle-tested skill to `auto` (`/lamarck evolve add <skill> auto`):
  gate-passing edits land without prompting, replay-gated, reported
  afterwards, one `git revert` away. lamarck itself never runs on auto.
- **When should I run `/lamarck` manually?** To process backlog from other
  sessions (the light loop reminds you once it is worth draining),
  `audit <skill>` for a full evidence review, `stats` for the scoreboard,
  or `report` for the evolution narrative.
- **How do I pause it?** Create a file named `off` in the skill directory
  (hooks go silent; manual invocation still works). Uninstall:
  `npx lamarck-skill uninstall`.
- **Why no suggestions yet?** Evidence gates: >=2 independent same-type
  gaps per skill before any proposal. Healthy skills never trigger one.

## Requirements

Claude Code on any platform (Windows / macOS / Linux) — Node.js 18+ and git.
Hooks wired in `~/.claude/settings.json` (PostToolUse on `Skill`, Stop).

## Adjacent work

The closest neighbor is [self-improving-skills](https://github.com/UniM0cha/self-improving-skills)
- it also hooks PostToolUse and edits SKILL.md files. The split, line by
line (with [task-observer](https://github.com/rebelytics/one-skill-to-rule-them-all)
for reference):

| | lamarck | self-improving-skills | task-observer |
|---|---|---|---|
| Trigger | **evaluated outcomes**: gap taxonomy, user corrections as ground truth | activity volume: N tool calls / file edits since last distillation | manual session review |
| Scope | **every installed skill, passively** (plugins capped at suggest); per-skill auto/evolve/suggest/observe levels | centers on its own distilled skills | whatever you review by hand |
| Governance | evidence gate (>=2 independent same-type gaps) + user approval per edit, or earned per-skill auto with replay-gated landing | automatic background edits, validated after writing | recommendations only, no edits |
| Verification | **semantic**: replay real traces old-vs-new, paired blind judging, version-window health | syntactic: rollback on malformed SKILL.md | none |
| Pruning | citation-based proposals (90-day zero-cite entries) | time-based archiving (30/90 days unused) | none |
| Proof | preregistered bench, cross-platform CI selftest, audited self-application | - | - |

One sentence: it asks "used a lot - time to distill"; lamarck asks "how
did it perform, is the evidence sufficient, did the edit actually help".
Skill harvesters (self-learning-skills, autoskill) create *new* skills
from sessions rather than evolving existing ones.

## Roadmap

Two orthogonal axes, both harness-shaped by the adapter contract:

- **Genome axis** - the abstraction is not skill-specific: any text artifact
  that steers an agent and is exercised repeatedly in production can evolve
  under the same telemetry → ledger → rubric → gated-edit architecture.
  Planned targets, in order: subagent definitions (`.claude/agents/`),
  CLAUDE.md / AGENTS.md memory files, slash commands, MCP tool
  configurations.
- **Harness axis** - the core is agent-agnostic (see Architecture); a pi
  adapter is the first planned second harness, and Agent Skills adoption
  across tools means the same SKILL.md genomes recur across harnesses -
  one shared ledger then measures a skill across all of them.

Same Iron Rules everywhere: evidence gates, user-in-the-loop, rollback,
whitelists.

## Status

Released: `lamarck-skill` on [npm](https://www.npmjs.com/package/lamarck-skill)
and GitHub. Design log in [CHANGELOG.md](CHANGELOG.md). Production case
studies (evidence tier 5) are accumulating from real usage and will be
published here as they complete.

---

中文文档见 [README.zh-CN.md](README.zh-CN.md)。
