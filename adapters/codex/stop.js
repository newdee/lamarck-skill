#!/usr/bin/env node
// Codex adapter - trigger + executor shim (Stop hook, ~/.codex/hooks.json).
// Codex's Stop hook speaks the SAME output contract as Claude Code's
// ({"decision":"block","reason":...}), so this shim delegates the entire
// decision to the reference implementation and only adds the loop guard
// Codex lacks: Claude Code sends stop_hook_active on the re-entered stop,
// Codex does not, so we keep a small local latch instead - one block per
// session per cooldown window. The evaluation itself clears pending, which
// makes the follow-up stop silent anyway; the latch only covers the case
// where the evaluation failed to clean up.
// Must never fail the harness: all errors swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REF = path.join(ROOT, 'scripts', 'stop-evaluate.js');
const LATCH = path.join(ROOT, 'data', '.codex-stop-latch.json');
const COOLDOWN_MS = 120000;

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object') process.exit(0);
  const sid = String(data.session_id || '');
  if (!sid) process.exit(0);

  // loop guard: if we already blocked this session inside the cooldown
  // window, stay silent and let the turn end.
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

  try {
    fs.mkdirSync(path.dirname(LATCH), { recursive: true });
    fs.writeFileSync(LATCH, JSON.stringify({ session: sid, ts: Date.now() }), 'utf8');
  } catch { /* latch is best-effort; the pending cleanup is the real guard */ }
  process.stdout.write(out); // same {"decision":"block","reason":...} contract
} catch { /* never break the harness */ }
process.exit(0);
