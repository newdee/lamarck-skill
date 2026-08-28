# Show HN draft (GATED - do not post until evidence tier 5 has >=1 real case)

> Title:
> Show HN: Lamarck - Claude Code skills that evolve from real usage, with receipts

Skills/prompts rot silently: they get patched for today's incident and
regress on last month's. Existing optimizers (Microsoft's SkillOpt,
darwin-skill) improve skill files offline against benchmarks or synthetic
test prompts - they never see production.

lamarck is the online counterpart. Two Claude Code hooks log every real
skill invocation (content-hash stamped). End-of-turn evaluation ledgers
what happened; user corrections are the ground truth. When the same gap
shows up twice, it proposes one bounded edit - the user applies, parks, or
rejects it. Behind that: replay of real past traces old-vs-new, paired
blind judging, and per-version health stats; any regression rolls back.
Skills that converge drop to spot-checks; parts nobody uses get pruning
proposals. It applies the same rules to itself - the CHANGELOG is the
audit trail.

Evidence so far: 44-check mechanism selftest (CI: ubuntu/macos/windows),
a mutation bench whose protocol was committed before execution (4/5
known-degraded variants caught, 0/2 improved falsely rejected, raw
verdicts in the repo), and now [N] completed production case studies:
[FILL: skill X, correction rate A% -> B% over M invocations, replay W/L].

`npx lamarck-skill` - wires the hooks (backup, add-only), then runs the
selftest so the install proves itself. MIT, Node 18+, telemetry stays
local.

I'd genuinely like this torn apart - the bench is designed to be
reproduced, and the biggest known limitation (observational telemetry,
task-mix drift) is documented rather than hidden.

https://github.com/newdee/lamarck-skill
