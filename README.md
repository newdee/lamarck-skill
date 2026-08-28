# lamarck

**Lamarckian skill evolution for Claude Code** — skills evolve from real usage,
not synthetic tests. Traits acquired through use are inherited back into the
skill file; parts that go unused atrophy. Counterpart to
[darwin-skill](https://github.com/alchaincyf/darwin-skill).

## The lane

| | [SkillOpt](https://github.com/microsoft/SkillOpt) | [darwin-skill](https://github.com/alchaincyf/darwin-skill) | lamarck |
|---|---|---|---|
| Metaphor | training ground | examination hall | life |
| Signal | benchmark scores | synthetic test prompts + judge panels | **production telemetry**: real invocations, real user corrections |
| Trigger | offline runs | manual runs | hooks observe every skill call, evaluation batches by threshold |
| Rubric | fixed | fixed 9-dim (SkillLens) | **per-skill, dynamic, git-versioned** — crystallized from evidence, evolves with the skill |
| Regression tests | benchmarks | hand-written prompts | **replayed from real traces** (zero authoring) |
| Direction | improve | improve | improve **and prune** (use-it-or-lose-it) |

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

1. **Mechanism self-test** — `pwsh scripts/selftest.ps1`, isolated temp
   sandbox, zero contact with live telemetry. Currently **39/39**: hook
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
4. **Case studies** — to be published from real usage before any promotion,
   with observational caveats (task-mix drift) stated, not hidden.

## Install

1. Clone into your skills directory:
   ```
   git clone https://github.com/newdee/lamarck-skill "$HOME\.claude\skills\lamarck"
   ```
2. Copy `config.example.json` to `config.json` (local, untracked) and adjust
   the trigger mode and evolution whitelist.
3. Wire the two hooks into `~/.claude/settings.json` (replace `<HOME>` with
   your absolute home path; `args` exec form, no shell parsing):
   ```json
   "hooks": {
     "PostToolUse": [{ "matcher": "Skill", "hooks": [{
       "type": "command", "command": "pwsh",
       "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                "<HOME>\\.claude\\skills\\lamarck\\scripts\\posttool-skill.ps1"],
       "timeout": 10 }]}],
     "Stop": [{ "hooks": [{
       "type": "command", "command": "pwsh",
       "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                "<HOME>\\.claude\\skills\\lamarck\\scripts\\stop-evaluate.ps1"],
       "timeout": 10 }]}]
   }
   ```
4. Verify: `pwsh scripts/selftest.ps1` — all checks must pass.
5. Kill switch: create a file named `off` in the skill directory — silences
   both hooks; manual `/lamarck` invocation still works (explicit intent).

## Requirements

Claude Code on Windows (pwsh 7+) — hooks in `~/.claude/settings.json`
(PostToolUse on `Skill`, Stop), plus git. POSIX port: planned.

## Status

Pre-release. Design log in [CHANGELOG.md](CHANGELOG.md).

---

中文简介:lamarck 是"用进废退"的 skill 进化系统——hook 观察每次真实调用,
经验按证据门写回 skill 文件,无用部分修剪;逐 skill 动态 rubric 与代码同库
版本化,回归用例从真实痕迹蒸馏,负优化由 replay + 成对盲评 + 版本分窗健康度
三道防线拦截,所有编辑用户在环。
