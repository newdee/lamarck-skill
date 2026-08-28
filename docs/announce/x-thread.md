# X/Twitter drafts (EN) - each block fits the 280-char free-tier limit

> Post from your own account; edit freely. Raw char counts are under 280
> even before t.co shortens URLs to 23 chars, so every block is safe.

## Option A: single tweet (lowest friction)

Darwin evolves skills by selection. Lamarck evolves them by use.

lamarck: Claude Code skills that evolve from real usage - evidence-gated
edits, user-approved, replay-tested, self-evolving with an audited
changelog.

npx lamarck-skill
github.com/newdee/lamarck-skill

## Option B: thread (6 tweets)

1/
Darwin evolves skills by selection. Lamarck evolves them by use.

I built lamarck for Claude Code: skills evolve from real production
usage, not synthetic tests - governed, evidence-gated, reversible.

npx lamarck-skill

2/
Offline skill optimizers (SkillOpt, darwin-skill) never see real usage.
Hand-written test prompts. Judges scoring their own work.

The signal that matters - what went wrong when a real user ran the
skill - is invisible to them.

3/
lamarck's loop: hooks log every real invocation, content-hash stamped.
End-of-turn evaluation ledgers what happened.

User corrections are the ground truth - not LLM self-scores (~46%
accuracy per the SkillLens paper).

4/
Evolution is gated: 2+ independent same-type gaps -> one bounded edit ->
you apply, park, or reject it.

Three rollback layers: replay real traces old-vs-new, paired blind
judging, per-version health stats.

5/
Use it or lose it, literally: 10 clean evaluations and a skill drops to
spot-checks. Rubric entries uncited for 90 days become pruning
proposals.

No offline optimizer prunes.

6/
Receipts, not claims: 44-check selftest in CI (ubuntu/macos/windows), a
mutation bench preregistered BEFORE execution (4/5 degraded caught, 0/2
false positives), SLSA provenance on npm.

github.com/newdee/lamarck-skill
