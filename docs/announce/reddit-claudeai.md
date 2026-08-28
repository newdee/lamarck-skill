# Reddit r/ClaudeAI post draft (EN)

> Suggested title:
> lamarck: my Claude Code skills now evolve from real usage (and it evolves itself, with receipts)

I kept seeing skill optimizers that work like exam halls: write synthetic
test prompts, spawn judge panels, score, keep the best version. microsoft/
SkillOpt does it with benchmarks; alchaincyf/darwin-skill does it with
hand-written prompts and LLM judges. Both are blind to the only signal I
actually care about: what went wrong when the skill ran for real.

So I built the counterpart and named it after the other evolution guy.

**lamarck** - governed evolution from production telemetry:

- Two hooks log every real skill invocation, stamped with the skill file's
  content hash (so every accepted edit gets before/after windows measured
  in *user-correction rate*, not model self-scores).
- Corrected/failed invocations get distilled into a replay corpus - free
  regression tests harvested from reality instead of authored by hand.
- Evolution is gated: >=2 independent same-type gaps, one bounded edit
  proposal, and the user always picks apply / suggestion / reject.
  Three rollback layers behind it (replay old-vs-new, paired blind judge,
  version-window stats).
- Use it or lose it: converged skills drop to spot-checks; rubric entries
  nobody cites become pruning proposals.
- It applies the same rules to itself - the CHANGELOG is the audit trail.

On evidence (because "self-improving" claims deserve suspicion): the
mechanism selftest is 44/44 across ubuntu/macos/windows in CI, and the
mutation bench protocol was committed to the repo *before* any judging ran
- 4/5 known-degraded skill variants flagged, 0/2 known-improved variants
falsely rejected, raw verdicts committed verbatim. The one miss is
analyzed in the repo, not hidden. Real production case studies are still
accumulating - I'm not claiming outcome numbers I don't have yet.

Install: `npx lamarck-skill` (wires the hooks with a backup, runs the
selftest so the install proves itself). MIT. Telemetry never leaves your
machine.

https://github.com/newdee/lamarck-skill

Would love adversarial eyes on the bench protocol - it's designed to be
reproduced.
