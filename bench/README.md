# mutation-bench: does the gate catch bad edits?

Measures the regression-catching ability of lamarck's paired blind judging —
the comparator used by both the replay gate and the verify-rollout gate —
using **controlled degradations** (the same validation method Microsoft's
SkillLens used for its rubric, applied at system level).

## Protocol (preregistered — this file is committed BEFORE any judging runs)

- **Target**: `targets/csv-cleaner/SKILL.md` (baseline) + 7 variants with
  known ground truth (`manifest.json`): 5 degraded (D1 failure-handling
  removed, D2 softened language, D3 concrete parameters removed, D4 header
  validation deleted, D5 injected contradiction), 2 improved (I1 new failure
  branch, I2 tightened dedup) as false-positive controls.
- **Cases**: 3 realistic tasks (`cases.jsonl`) standing in for the replay
  corpus.
- **Judging**: one independent, tool-less judge agent per variant. The judge
  receives the two versions labeled only A/B (fixed preregistered assignment
  in `manifest.json`, mixed across variants), all 3 cases, and returns per
  case: which version, followed exactly, yields the better outcome —
  `A` / `B` / `tie`, plus a one-line reason. The judge never sees file
  names, truth labels, or this README.
- **Verdict per variant**: majority across the 3 cases; a variant is
  **flagged** when the majority says the baseline side is better
  (i.e. the variant would be rejected/rolled back).
- **Metrics**:
  - recall on degraded = flagged(D*) / 5 (higher is better)
  - false-positive rate on improved = flagged(I*) / 2 (lower is better)
- **Escalation rule mirror**: in production a tie escalates to 3 judges;
  the bench records ties as not-flagged (conservative, counts against us).
- **Results**: raw per-case verdicts land in `results/run-NNN.jsonl`
  verbatim; summary numbers go to the main README only from those files.

## Reproduce

Any agent harness works: for each variant, spawn a fresh agent with the
judge prompt template below, paste the two versions and the cases, collect
JSON. No lamarck internals required.

```
You are judging two versions of an agent skill instruction file.
For each task case, decide which version, followed exactly by a competent
agent, produces the better outcome for the user.
Answer with strict JSON only:
{"C1":{"verdict":"A|B|tie","reason":"..."},
 "C2":{"verdict":"A|B|tie","reason":"..."},
 "C3":{"verdict":"A|B|tie","reason":"..."}}
No other text.
```

## Results

**run-001** (2026-08-28, judge: claude-fable-5, protocol preregistered at
commit `5411f9b` before execution; raw verdicts verbatim in
`results/run-001.jsonl`):

- **recall on degraded: 4/5** — D1 (failure handling removed) 3-0,
  D2 (softened language) 2-1, D3 (parameters vaguened) 3-0,
  D5 (injected contradiction) 2-0-1 all flagged; **D4 missed** (header
  validation deleted: flagged on the only case that exercises headers,
  tied on the two that don't — the preregistered single-judge majority
  therefore records a miss).
- **false positives on improved: 0/2** — I1 and I2 were not rejected;
  each even drew one vote as the better version.
- Case-level votes on degraded variants: 11 baseline / 3 tie / 1 variant.

Two honest lessons the numbers teach:
1. **Detection is bounded by case coverage** (D4): a degradation is only
   catchable on inputs that exercise the deleted behavior — the argument
   for harvesting regression cases from real usage rather than writing
   them by hand. In production, D4's majority-tie triggers the 3-judge
   escalation, and version-window health provides the trailing backstop.
2. **The judge is not a rubber stamp** (D2/C2 dissent): it sided with the
   softened variant where the baseline's rigid STOP costs an avoidable
   round-trip on an obviously-mappable header rename — a legitimate
   improvement hint for the baseline, kept on file as evidence.

## Honesty notes

- Single target, 7 variants, 3 cases: a pilot, not a population study.
- The variants were authored by the lamarck author; the blinding protects
  judge neutrality, not variant selection. The variant set and truth labels
  are public — dispute them via issues/PRs.
- darwin-skill comparison: run the same variants through its judge workflow
  and compare flagged counts; contributions welcome.
