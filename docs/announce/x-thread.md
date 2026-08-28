# X/Twitter drafts (EN) - each block fits the 280-char free-tier limit

> Post from your own account; edit freely. Raw char counts are under 280
> even before t.co shortens URLs to 23 chars, so every block is safe.

## Option A: single tweet (lowest friction)

Install once and EVERY Claude Code skill you have goes under evolution
watch - hundreds at a time, passively, from real usage.

Evidence-gated edits, always your approval, replay-tested. It evolves
itself by the same rules.

npx lamarck-skill
github.com/newdee/lamarck-skill

## Option B: thread (6 tweets)

1/
Skill optimizers improve ONE skill you point at, with hand-written
tests.

lamarck: install once, and EVERY skill you have goes under evolution
watch - passively, from real usage. Darwin selects; Lamarck uses.

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
