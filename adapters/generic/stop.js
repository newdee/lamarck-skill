#!/usr/bin/env node
// Generic fallback trigger + executor shim - pairs with generic/posttool.js.
// Assumes "a turn-end hook that passes one JSON object on stdin and reads
// stdout". Session identity is extracted tolerantly; the output envelope is
// chosen with --emit (ask the harness's docs which one it consumes):
//   --emit=block     {"decision":"block","reason":<protocol>}   (default;
//                    Claude Code / Codex style)
//   --emit=followup  {"followup_message":<protocol>}            (Cursor style)
//   --emit=text      the protocol as plain stdout text           (harnesses
//                    that append hook stdout as context)
// Loop guards: honors stop_hook_active when the harness sends one, plus the
// per-session cooldown latch for harnesses that do not. The evaluation
// clearing pending is the durable guard.
// Must never fail the harness: errors swallowed, exit 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REF = path.join(ROOT, 'scripts', 'stop-evaluate.js');
const LATCH = path.join(ROOT, 'data', '.generic-stop-latch.json');
const COOLDOWN_MS = 120000;
const emitArg = process.argv.find(a => a.startsWith('--emit='));
const EMIT = emitArg ? emitArg.slice(7) : 'block';

try {
  if (!['block', 'followup', 'text'].includes(EMIT)) process.exit(0);
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) process.exit(0);
  if (data.stop_hook_active) process.exit(0);
  const pick = (keys) => { for (const k of keys) { if (data[k]) return String(data[k]); } return ''; };
  const sid = pick(['session_id', 'conversation_id', 'thread_id', 'sessionId', 'session']);
  if (!sid) process.exit(0);

  try {
    const latch = JSON.parse(fs.readFileSync(LATCH, 'utf8'));
    if (latch && latch.session === sid && Date.now() - latch.ts < COOLDOWN_MS) process.exit(0);
  } catch { /* no latch yet */ }

  const r = spawnSync(process.execPath, [REF], {
    input: JSON.stringify({ session_id: sid, stop_hook_active: false }),
    encoding: 'utf8', timeout: 8000
  });
  const out = (r.stdout || '').trim();
  if (!out) process.exit(0);
  let reason = '';
  try { reason = String(JSON.parse(out).reason || ''); } catch { process.exit(0); }
  if (!reason) process.exit(0);

  try {
    fs.mkdirSync(path.dirname(LATCH), { recursive: true });
    fs.writeFileSync(LATCH, JSON.stringify({ session: sid, ts: Date.now() }), 'utf8');
  } catch { /* latch is best-effort */ }
  if (EMIT === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  else if (EMIT === 'followup') process.stdout.write(JSON.stringify({ followup_message: reason }));
  else process.stdout.write(reason);
} catch { /* never break the harness */ }
process.exit(0);
