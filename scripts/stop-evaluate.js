#!/usr/bin/env node
// Stop hook. Cross-platform (Node 18+). If this session has pending
// skill-invocation records past the configured trigger, block the stop once
// and hand the model a self-contained LIGHT evaluation protocol, so the full
// lamarck SKILL.md is NOT reloaded every turn. stop_hook_active guards
// against infinite block loops (one block per turn max).
// Must never fail the harness: all errors are swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');

// Unexpected errors are still swallowed (the harness must never break),
// but they leave one diagnostic line behind instead of vanishing.
function logErr(e) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `${new Date().toISOString()} stop-evaluate: ${(e && e.message) || e}\n`, 'utf8');
  } catch { /* diagnostics must never break the harness either */ }
}

try {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let data = null;
  if (raw && raw.trim()) {
    try { data = JSON.parse(raw); } catch (e) { logErr(e); process.exit(0); }
  }

  // Already continuing because of a stop hook: never block twice.
  if (data && data.stop_hook_active) process.exit(0);

  const root = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(root, 'off'))) process.exit(0);

  // Trigger mode from config.json: every | manual | threshold (default threshold/5).
  // Missing or corrupt config falls back to the defaults, never crashes.
  let mode = 'threshold';
  let threshold = 5;
  const cfgPath = path.join(root, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (['every', 'manual', 'threshold'].includes(cfg.mode)) mode = cfg.mode;
      const t = Number(cfg.threshold);
      if (Number.isInteger(t) && t >= 1) threshold = t;
    } catch { /* fall back to defaults */ }
  }
  if (mode === 'manual') process.exit(0);

  const pendingPath = path.join(root, 'data', 'pending.jsonl');
  if (!fs.existsSync(pendingPath)) process.exit(0);
  const lines = fs.readFileSync(pendingPath, 'utf8').split('\n').filter(l => l.trim());
  if (!lines.length) process.exit(0);

  // Only this session's entries force an evaluation here; other sessions'
  // entries lack in-context evidence and are handled by manual /lamarck runs.
  // No session_id (anomalous input) -> cannot attribute entries, never block.
  const sid = data ? String(data.session_id || '') : '';
  if (!sid) process.exit(0);
  const mine = [];
  let backlog = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (!o) continue;
      if (o.session === sid) mine.push(o); else backlog++;
    } catch { /* tolerate corrupt lines */ }
  }
  const needed = mode === 'every' ? 1 : threshold;
  if (mine.length < needed) process.exit(0);

  const names = [...new Set(mine.map(o => o.skill))];
  const p = (...seg) => path.join(root, ...seg);
  // Other sessions' entries never trigger a block on their own (no in-context
  // evidence to judge them by). But once this session is already evaluating,
  // an actionable backlog earns one line: transcript pointers decay, so silent
  // accumulation quietly loses the evidence it points at.
  const backlogClause = backlog >= needed
    ? ` NOTE: ${backlog} pending entr${backlog === 1 ? 'y' : 'ies'} from other sessions are also on file and are NOT evaluated here; tell the user once that '/lamarck' drains that backlog and that transcript pointers decay after ~30 days.`
    : '';
  const reason =
    `lamarck LIGHT loop (trigger: mode=${mode}, needed=${needed}): ${mine.length} skill invocation(s) from this session (session_id=${sid}) await evaluation: [${names.join(', ')}]. ` +
    `Do this now WITHOUT reloading SKILL.md. For each pending entry in ${p('data', 'pending.jsonl')} belonging to this session, using only real in-context evidence (<=5 lines each) and, where ${p('data', 'rubrics')}${path.sep}<skill>.md exists, judging against the entries of that rubric whose scenario tag matches this call: ` +
    `judge trigger_fit (ok|false-positive|wrong-skill), gaps[] (things the skill's instructions lacked, each 'missing X, caused Y'), outcome (clean|corrected|failed; quote user corrections in note), friction (wasted steps, may be empty). ` +
    `First consult ${p('data', 'maturity.json')}: for skills marked stable, each entry needs only a glance - if this turn shows no user correction or anomaly, ledger one line {outcome:'stable-skip',ver:...} and increment the streak, except every Nth call (stability.sample, default 5) still gets the full evaluation; any correction, gap, ver change or novel scenario wakes the skill back to active. ` +
    `For active skills: append one JSON line per entry to ${p('data', 'ledger.jsonl')} with fields {ts,session,skill,ver,trigger_fit,gaps,outcome,friction,note} (carry ver over from the pending record); ` +
    `if the user corrected the skill this turn, crystallize that correction into one rubric entry in ${p('data', 'rubrics')}${path.sep}<skill>.md - n=1 suffices, format and rules in ${p('data', 'rubrics', 'README.md')} (every entry MUST cite its ledger ts and carry a scenario tag; superseded entries move to attic, never deleted); ` +
    `if a reusable lesson emerged, append it to ${p('data', 'learnings')}${path.sep}<skill>.md; ` +
    `distill a regression case {essence,expect,src} into ${p('data', 'replays')}${path.sep}<skill>.jsonl for every corrected/failed entry, AND for a clean entry whose scenario is not yet represented in that file (one representative case per scenario - a skill that never fails still needs a corpus, because replay validation of a future edit must cover its OTHER scenarios and an empty corpus blocks the auto tier). ` +
    `In every per-skill path above, write <skill> with ':' replaced by '__' so plugin names stay valid filenames on all platforms (caveman:caveman-help -> caveman__caveman-help); ledger and maturity keys keep the real name with the colon. ` +
    `Maintain maturity.json accordingly (clean streak of stability.streak, default 10, promotes to stable). Then re-read data${path.sep}pending.jsonl and write it back without this session's lines - re-read immediately before writing, because concurrent sessions may have appended entries while you were evaluating and those must survive.` + backlogClause + ` ` +
    `ESCALATE ONLY IF, after logging, some skill has >=2 independent invocations with same-type gaps in the ledger: then read ${p('SKILL.md')} and run its optimization gate. ` +
    `NEVER apply an edit to any skill without first asking the user (AskUserQuestion: apply / keep as suggestion / reject); in a non-interactive session, write the proposal to suggestions/<skill>.md instead of editing.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
} catch (e) { logErr(e); /* never break the harness */ }
process.exit(0);
