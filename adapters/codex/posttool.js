#!/usr/bin/env node
// Codex adapter - collector shim (PostToolUse hook, ~/.codex/hooks.json).
// Codex hook stdin is field-compatible with Claude Code's (session_id,
// tool_name, tool_input, transcript_path), but Codex has no dedicated Skill
// tool: a skill activates when the model READS its SKILL.md. This shim
// detects that read, synthesizes the Skill-shaped event the reference
// collector expects, and pipes it through - zero logic duplicated.
// False positives (a SKILL.md read that is not an activation) are fine:
// the light loop's trigger_fit dimension exists to judge exactly that.
// Must never fail the harness: all errors swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');           // lamarck skill dir
const REF = path.join(ROOT, 'scripts', 'posttool-skill.js'); // reference collector

// Match ".../<skill-dir>/SKILL.md" anywhere in the tool input (read tool,
// shell cat, apply_patch context - the path shape is the signal).
// [/\\]+ because the haystack is JSON.stringify output, where one Windows
// backslash arrives as the two characters \\.
const SKILL_RE = /[/\\]+([A-Za-z0-9._-]+)[/\\]+SKILL\.md/;

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object') process.exit(0);

  const hay = JSON.stringify(data.tool_input || '');
  const m = SKILL_RE.exec(hay);
  if (!m || m[1] === 'lamarck') process.exit(0);

  const synthesized = JSON.stringify({
    session_id: String(data.session_id || ''),
    tool_name: 'Skill',
    tool_input: { skill: m[1], args: `codex:${String(data.tool_name || '')}` },
    transcript_path: String(data.transcript_path || '')
  });
  spawnSync(process.execPath, [REF], { input: synthesized, timeout: 8000 });
} catch { /* never break the harness */ }
process.exit(0);
