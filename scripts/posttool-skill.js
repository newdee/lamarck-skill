#!/usr/bin/env node
// PostToolUse hook (matcher: Skill). Cross-platform (Node 18+).
// Appends one pending-evaluation record per skill invocation to data/pending.jsonl.
// Must never fail or block the harness: all errors are swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Unexpected errors are still swallowed (the harness must never break),
// but they leave one diagnostic line behind instead of vanishing.
function logErr(e) {
  try {
    const dir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `${new Date().toISOString()} posttool-skill: ${(e && e.message) || e}\n`, 'utf8');
  } catch { /* diagnostics must never break the harness either */ }
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch (e) { logErr(e); process.exit(0); }

  if (!data || data.tool_name !== 'Skill') process.exit(0);
  const skill = String((data.tool_input && data.tool_input.skill) || '');
  // Skip empty names and self-invocations (prevents evaluate-the-evaluator loops).
  if (!skill.trim() || skill === 'lamarck') process.exit(0);

  const root = path.resolve(__dirname, '..');
  // Kill switch: a file named 'off' in the skill directory silences the hooks.
  if (fs.existsSync(path.join(root, 'off'))) process.exit(0);

  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  let args = String((data.tool_input && data.tool_input.args) || '');
  if (args.length > 200) args = args.slice(0, 200);

  // Genome version stamp: content hash of the target skill's SKILL.md at
  // invocation time. Enables per-version performance windows (regression
  // detection after edits). Plugin skills (name contains ':') have no
  // resolvable path here -> empty stamp.
  let ver = '';
  try {
    if (!skill.includes(':')) {
      const sf = path.join(path.resolve(root, '..'), skill, 'SKILL.md');
      if (fs.existsSync(sf)) {
        ver = crypto.createHash('md5').update(fs.readFileSync(sf)).digest('hex').slice(0, 8);
      }
    }
  } catch { /* stamp is best-effort */ }

  const rec = {
    ts: new Date().toISOString().slice(0, 19) + 'Z',
    session: String(data.session_id || ''),
    skill,
    args,
    ver,
    // Pointer to Claude Code's own session transcript - the full execution
    // log already exists there; we store the pointer, never a copy.
    // Decays with the transcript cleanup period; consumers must fall back.
    transcript: String(data.transcript_path || '')
  };
  fs.appendFileSync(path.join(dataDir, 'pending.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
} catch (e) { logErr(e); /* never break the harness */ }
process.exit(0);
