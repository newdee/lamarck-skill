# lamarck

English | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/lamarck-skill)](https://www.npmjs.com/package/lamarck-skill)
[![ci](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![selftest](https://img.shields.io/badge/selftest-44%2F44-brightgreen)](scripts/selftest.js)

**Install once — every skill you have is under evolution watch.** lamarck
passively observes every real invocation of every installed skill (hundreds,
if you have them), accumulates per-skill evidence, and evolves them under
evidence gates — edits only ever land with your approval. It evolves itself
by the same rules while it runs. Traits acquired through use are inherited
back into the skill file; parts that go unused atrophy. Every irreversible
step is user-approved, ledgered, and reversible: the governance is what
makes population-wide evolution safe. Counterpart to
[darwin-skill](https://github.com/alchaincyf/darwin-skill), which optimizes
one hand-picked skill at a time.

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
   reason — no SKILL.md reload per turn. Four-dimension verdicts →
   `data/ledger.jsonl`; lessons → `data/learnings/`; corrected/failed calls
   distilled into `data/replays/` regression cases. Trigger timing is
   configurable: every turn / manual / threshold batch (default: 5).
3. **Evolve** (gated): ≥2 independent same-type gaps → synthesize a bounded
   edit proposal from ALL evidence → user chooses apply / keep as suggestion /
   reject. Replay validation immediately, paired blind judging on the next
   real invocation, per-version health comparison as the statistical backstop.
   Any degradation → rollback proposal.
4. **Whitelist**: `config.json` grades each skill evolve / suggest / observe
   (default observe; plugins capped at suggest). New skills inherit the default.
5. **Convergence**: not every iteration pays. After a clean streak (default
   10) a skill goes *stable* — evaluations drop to spot-checks (1 in 5) and
   one-line `stable-skip` records; any user correction, genome change or
   novel scenario wakes it back to active. A long clean streak is itself
   evidence: the report presents it as a production-reliability certificate.

Everything irreversible requires explicit user confirmation. Telemetry never
leaves the machine (`.gitignore`d); rubrics are versioned with the code.

## Evidence

Honesty policy: **no self-graded scores** (an optimizer scoring its own output
with its own judges proves nothing; LLM self-evaluation accuracy is ~46% per
the SkillLens paper darwin-skill itself cites). Three tiers instead:

1. **Mechanism self-test** — `node scripts/selftest.js`, isolated temp
   sandbox, zero contact with live telemetry. Currently **44/44**: hook
   logging, genome stamping, threshold/every/manual triggers, config
   fallbacks, session isolation, loop guards, byte-reproducible output,
   gitignore boundaries. CI-able (exit code gated).
2. **Production telemetry** (accumulating by design): every invocation is
   stamped with the target skill's genome hash, so each accepted edit gets
   before/after windows measured in **user-correction rate** — ground truth
   from user behavior, not model self-scoring. Replay validation adds a
   controlled comparison: identical real inputs, old vs new genome. All
   verify verdicts are ledgered; `/lamarck report` aggregates them.
3. **mutation-bench** (`bench/`, protocol preregistered before execution):
   controlled degradations with public ground truth, blind A/B judging.
   run-001: **4/5 known-degraded variants flagged, 0/2 known-improved
   variants falsely rejected** (single judge, majority-of-3-cases; the miss
   is analyzed, not hidden — see `bench/README.md`). Raw verdicts committed
   verbatim.
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
| Scope | **every installed skill, passively** (plugins capped at suggest); per-skill evolve/suggest/observe levels | centers on its own distilled skills | whatever you review by hand |
| Governance | evidence gate (>=2 independent same-type gaps) + user approval per edit | automatic background edits, validated after writing | recommendations only, no edits |
| Verification | **semantic**: replay real traces old-vs-new, paired blind judging, version-window health | syntactic: rollback on malformed SKILL.md | none |
| Pruning | citation-based proposals (90-day zero-cite entries) | time-based archiving (30/90 days unused) | none |
| Proof | preregistered bench, cross-platform CI selftest, audited self-application | - | - |

One sentence: it asks "used a lot - time to distill"; lamarck asks "how
did it perform, is the evidence sufficient, did the edit actually help".
Skill harvesters (self-learning-skills, autoskill) create *new* skills
from sessions rather than evolving existing ones.

## Roadmap

The genome abstraction is not skill-specific: any text artifact that steers
an agent and is exercised repeatedly in production can evolve under the same
telemetry → ledger → rubric → gated-edit architecture. Planned targets, in
order: subagent definitions (`.claude/agents/`), CLAUDE.md / AGENTS.md memory
files, slash commands, MCP tool configurations. Same Iron Rules everywhere:
evidence gates, user-in-the-loop, rollback, whitelists.

## Status

Released: `lamarck-skill` on [npm](https://www.npmjs.com/package/lamarck-skill)
and GitHub. Design log in [CHANGELOG.md](CHANGELOG.md). Production case
studies (evidence tier 5) are accumulating from real usage and will be
published here as they complete.

---

中文文档见 [README.zh-CN.md](README.zh-CN.md)。
