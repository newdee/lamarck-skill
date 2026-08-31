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
  // The protocol body is a SINGLE SOURCE shared by every adapter
  // (protocol/light-loop.md). This adapter injects it verbatim: strip the
  // authoring comment, normalize line endings (CRLF checkouts must produce
  // byte-identical output), collapse whitespace, fill the one placeholder.
  // A missing protocol file must never crash the harness - log one
  // diagnostic and stay silent; pending survives for the next turn.
  const protoPath = p('protocol', 'light-loop.md');
  let proto = '';
  try {
    proto = fs.readFileSync(protoPath, 'utf8');
  } catch (e) { logErr(new Error(`light-loop protocol unreadable: ${(e && e.message) || e}`)); process.exit(0); }
  proto = proto.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim().replace('{{BACKLOG}}', backlogClause);
  // Refuse a dirty render outright: an empty body, an unfilled placeholder,
  // or an unclosed authoring comment (which the strip above cannot remove)
  // must never reach the model as protocol text.
  if (!proto || proto.includes('{{') || proto.includes('<!--')) { logErr(new Error('light-loop protocol empty, unfilled or unclosed-comment - refusing to inject')); process.exit(0); }
  const reason =
    `lamarck LIGHT loop (trigger: mode=${mode}, needed=${needed}): ${mine.length} skill invocation(s) from this session (session_id=${sid}) await evaluation: [${names.join(', ')}]. ` +
    `Working directory: ${root} - every relative path below resolves against it. ` + proto;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
} catch (e) { logErr(e); /* never break the harness */ }
process.exit(0);
