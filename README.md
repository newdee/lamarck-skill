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

Everything irreversible requires explicit user confirmation. Telemetry never
leaves the machine (`.gitignore`d); rubrics are versioned with the code.

## Requirements

Claude Code on Windows (pwsh) — hooks in `~/.claude/settings.json` (PostToolUse
on `Skill`, Stop), plus git. POSIX port: planned.

## Status

Pre-release. Design log in [CHANGELOG.md](CHANGELOG.md).

---

中文简介:lamarck 是"用进废退"的 skill 进化系统——hook 观察每次真实调用,
经验按证据门写回 skill 文件,无用部分修剪;逐 skill 动态 rubric 与代码同库
版本化,回归用例从真实痕迹蒸馏,负优化由 replay + 成对盲评 + 版本分窗健康度
三道防线拦截,所有编辑用户在环。
