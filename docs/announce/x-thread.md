# X/Twitter thread draft (EN)

> Post from your own account; edit freely. One tweet per block.

1/
Darwin makes skills evolve by selection.
Lamarck makes them evolve by use.

I built lamarck: governed evolution for Claude Code skills, driven by
production telemetry instead of synthetic tests.

npx lamarck-skill

2/
The problem with offline skill optimizers (SkillOpt, darwin-skill): they
never see real usage. Hand-written test prompts, judge panels scoring
their own work. The signal that matters - what actually went wrong when a
real user ran the skill - is invisible to them.

3/
lamarck's loop: hooks log every real skill invocation (stamped with the
skill file's content hash). A light end-of-turn evaluation writes verdicts
to a ledger. Corrections from the user are ground truth - not LLM
self-scoring (~46% accuracy per the SkillLens paper).

4/
Evolution is gated, not vibes: >=2 independent same-type gaps -> one
bounded edit proposal -> the user picks apply / keep as suggestion /
reject. Then three rollback layers: replay real traces old-vs-new, paired
blind judging, per-version health windows.

5/
Use it or lose it, literally: skills that go clean for 10 straight
evaluations drop to spot-checks (convergence). Rubric entries nobody
cites for 90 days become pruning proposals (atrophy). Neither exists in
any offline optimizer.

6/
Receipts, not claims: mechanism selftest 44/44 (CI on ubuntu/macos/
windows), a mutation bench whose protocol was committed BEFORE execution
(4/5 known-degraded variants caught, 0/2 improved ones falsely
rejected), and a CHANGELOG that is itself an audited self-evolution log.

7/
MIT, cross-platform (Node 18+), telemetry never leaves your machine.

github.com/newdee/lamarck-skill
