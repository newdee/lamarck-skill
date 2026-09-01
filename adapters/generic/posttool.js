#!/usr/bin/env node
// Generic fallback collector - the escape hatch when a harness's own agent
// cannot produce a conforming bespoke adapter (contract: three failed
// verifier iterations). Assumes only "a post-tool hook that passes one
// JSON object on stdin" and extracts tolerantly:
//   session    - session_id | conversation_id | thread_id | sessionId | session
//   transcript - transcript_path | transcriptPath | transcript
//   activation - a ".../<skill>/SKILL.md" path anywhere in the payload,
//                transcript/workspace-like fields excluded (they carry
//                paths of every kind without implying an activation).
// Delegates the actual logging to the reference collector - zero logic
// duplicated. Must never fail the harness: errors swallowed, exit 0.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REF = path.join(ROOT, 'scripts', 'posttool-skill.js');
// [/\\]+ because the haystack is JSON.stringify output, where one Windows
// backslash arrives as the two characters \\.
const SKILL_RE = /[/\\]+([A-Za-z0-9._-]+)[/\\]+SKILL\.md/;
const pick = (o, keys) => { for (const k of keys) { if (o[k]) return String(o[k]); } return ''; };

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw || !raw.trim()) process.exit(0);
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) process.exit(0);

  const scan = {};
  for (const [k, v] of Object.entries(data)) {
    if (/transcript|workspace/i.test(k)) continue;
    scan[k] = v;
  }
  const m = SKILL_RE.exec(JSON.stringify(scan));
  if (!m || m[1] === 'lamarck') process.exit(0);

  const synthesized = JSON.stringify({
    session_id: pick(data, ['session_id', 'conversation_id', 'thread_id', 'sessionId', 'session']),
    tool_name: 'Skill',
    tool_input: { skill: m[1], args: `generic:${pick(data, ['tool_name', 'toolName', 'hook_event_name'])}` },
    transcript_path: pick(data, ['transcript_path', 'transcriptPath', 'transcript']),
    lamarck_harness: process.env.LAMARCK_HARNESS || 'generic'
  });
  spawnSync(process.execPath, [REF], { input: synthesized, timeout: 8000 });
} catch { /* never break the harness */ }
process.exit(0);
