<!--
  lamarck light-loop protocol - SINGLE SOURCE.

  This file is the evaluation protocol every adapter injects into its
  executor model at trigger time. The claude-code adapter
  (scripts/stop-evaluate.js) reads it, strips this comment, collapses all
  whitespace to single spaces, substitutes {{BACKLOG}}, and prepends a
  dynamic header naming the trigger, session and pending skills plus the
  working directory. Other adapters must do the same - never paraphrase or
  fork this text (see protocol/adapter-contract.md).

  Editing rules:
  - Every file path stays RELATIVE (the injected header declares the
    working directory they resolve against).
  - Never line-break inside a quoted phrase that scripts/selftest.js greps
    for; whitespace collapsing joins lines with single spaces.
  - {{BACKLOG}} is replaced by the adapter with a backlog notice or ''.
  - This protocol is governed by the same rules as SKILL.md: changes go
    through the optimization gate and explicit user approval.
-->
Do this now WITHOUT reloading SKILL.md. For each pending entry in
data/pending.jsonl belonging to this session, using only real in-context
evidence (<=5 lines each) and, where data/rubrics/<skill>.md exists, judging
against the entries of that rubric whose scenario tag matches this call:
judge trigger_fit (ok|false-positive|wrong-skill), gaps[] (things the
skill's instructions lacked, each 'missing X, caused Y'), outcome
(clean|corrected|failed; quote user corrections in note), friction (wasted
steps, may be empty). First consult data/maturity.json: for skills marked
stable, each entry needs only a glance - if this turn shows no user
correction or anomaly, ledger one line {outcome:'stable-skip',ver:...} and
increment the streak, except every Nth call (stability.sample, default 5)
still gets the full evaluation; any correction, gap, ver change or novel
scenario wakes the skill back to active. For active skills: append one JSON
line per entry to data/ledger.jsonl with fields
{ts,session,skill,ver,harness,trigger_fit,gaps,outcome,friction,note}
(carry ver and harness over from the pending record; a record without a
harness field is 'claude-code'). Treat the harness as part of the
scenario: cross-harness evidence is cross-scenario evidence for the
fencing rules, so an edit justified by one harness's evidence may only
add a branch for that harness, never rewrite what other harnesses rely
on. If the user corrected the skill this turn,
crystallize that correction into one rubric entry in
data/rubrics/<skill>.md - n=1 suffices, format and rules in
data/rubrics/README.md (every entry MUST cite its ledger ts and carry a
scenario tag; superseded entries move to attic, never deleted); if a
reusable lesson emerged, append it to data/learnings/<skill>.md; distill a
regression case {essence,expect,src} into data/replays/<skill>.jsonl for
every corrected/failed entry, AND for a clean entry whose scenario is not
yet represented in that file (one representative case per scenario - a
skill that never fails still needs a corpus, because replay validation of a
future edit must cover its OTHER scenarios and an empty corpus blocks the
auto tier). In EVERY per-skill file path in this protocol - rubrics,
learnings, replays and suggestions alike - write <skill> with ':' replaced
by '__' so plugin names stay valid filenames on all platforms
(caveman:caveman-help -> caveman__caveman-help); ledger and maturity keys
keep the real name with the colon. Maintain maturity.json accordingly
(clean streak of stability.streak, default 10, promotes to stable). Then
re-read data/pending.jsonl and write it back without this session's lines -
re-read immediately before writing, because concurrent sessions may have
appended entries while you were evaluating and those must survive.{{BACKLOG}}
ESCALATE ONLY IF, after logging, some skill has >=2 independent invocations
with same-type gaps in the ledger: then read SKILL.md and run its
optimization gate. NEVER apply an edit to any skill without first asking
the user (AskUserQuestion: apply / keep as suggestion / reject); in a
non-interactive session, or when this harness cannot ask a three-way
choice or spawn the judge subagents the gate's validation needs, write
the proposal to suggestions/<skill>.md instead of editing.
