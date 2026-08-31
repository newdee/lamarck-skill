#!/usr/bin/env node
// Cursor adapter - trigger + executor shim (stop hook, ~/.cursor/hooks.json).
// Delegates the decision to the reference stop-evaluate.js and translates
// the output contract: Claude/Codex speak {"decision":"block","reason"},
// Cursor's stop hook continues the agent with {"followup_message": "..."}.
// Loop guard: same per-session cooldown latch as the Codex shim (Cursor
// has no stop_hook_active equivalent in its public contract).
// Must never fail the harness: all errors swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REF = path.join(ROOT, 'scripts', 'stop-evaluate.js');
const LATCH = path.join(ROOT, 'data', '.cursor-stop-latch.json');
const COOLDOWN_MS = 120000;

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object') process.exit(0);
  const sid = String(data.conversation_id || data.session_id || '');
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
  process.stdout.write(JSON.stringify({ followup_message: reason }));
} catch { /* never break the harness */ }
process.exit(0);
