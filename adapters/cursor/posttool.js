#!/usr/bin/env node
// Cursor adapter - collector shim (postToolUse hook, ~/.cursor/hooks.json).
// Cursor's hook stdin carries conversation_id and transcript_path plus
// event-specific tool fields whose exact names are not pinned by the public
// docs, so extraction is deliberately tolerant: session id from
// conversation_id (falling back to session_id), and the skill signal is a
// ".../<skill>/SKILL.md" path anywhere in the payload - Cursor loads skills
// by reading their SKILL.md (it discovers ~/.claude/skills natively).
// Must never fail the harness: all errors swallowed, always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REF = path.join(ROOT, 'scripts', 'posttool-skill.js');
// [/\\]+ because the haystack is JSON.stringify output, where one Windows
// backslash arrives as the two characters \\.
const SKILL_RE = /[/\\]+([A-Za-z0-9._-]+)[/\\]+SKILL\.md/;

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object') process.exit(0);

  // Scan the whole payload minus the fields that legitimately mention paths
  // of every kind (transcript, workspace roots).
  const { transcript_path, workspace_roots, ...rest } = data;
  const m = SKILL_RE.exec(JSON.stringify(rest));
  if (!m || m[1] === 'lamarck') process.exit(0);

  const synthesized = JSON.stringify({
    session_id: String(data.conversation_id || data.session_id || ''),
    tool_name: 'Skill',
    tool_input: { skill: m[1], args: `cursor:${String(data.hook_event_name || '')}` },
    transcript_path: String(data.transcript_path || '')
  });
  spawnSync(process.execPath, [REF], { input: synthesized, timeout: 8000 });
} catch { /* never break the harness */ }
process.exit(0);
