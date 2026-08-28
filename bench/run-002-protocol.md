# run-002 protocol (PREREGISTERED, NOT YET EXECUTED)

Gated on: first completed real-skill evolution cycle (evidence tier 5).
This file is committed before execution, like run-001; results will land
in `results/run-002.jsonl` without touching this protocol.

## Goals

1. Scale up run-001: a second target skill + 3-judge majority per variant.
2. Head-to-head vs darwin-skill on identical inputs.

## Design

- **Targets**: `csv-cleaner` (run-001 target, reused) + one new target of a
  different genre (an ops/runbook-style skill), each with 5 degraded / 2
  improved variants authored the same way (public ground truth, fixed
  blinded A/B assignments committed here before judging).
- **Judging**: 3 independent tool-less judges per variant (majority), same
  prompt template as run-001. Judge model recorded per verdict.
- **darwin arm**: run darwin-skill's own evaluation workflow on the same
  variant set (its judges, its rubric); count flagged degraded / falsely
  rejected improved. Same inputs, both systems, comparable columns.
- **Metrics**: recall on degraded, FP rate on improved, per system;
  case-level vote table; judge-agreement (Fleiss kappa) as a bonus.
- **Honesty**: variant authorship remains ours (stated); the darwin arm
  runs unmodified from its published repo at a pinned commit (recorded in
  results); disagreements published verbatim.

## Not in scope

Benchmark-score lifting (SkillOpt's lane). This bench measures regression
gating, not optimization strength.
