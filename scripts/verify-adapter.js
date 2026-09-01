#!/usr/bin/env node
// lamarck adapter conformance verifier.
//
//   node scripts/verify-adapter.js <manifest.json>
//
// The adapter contract (protocol/adapter-contract.md) tells ANY agent how
// to write an adapter for its own harness; this verifier is the machine
// check that the result actually conforms - write the adapter, pass this,
// then wire it. It exercises command-style collectors and triggers (stdin
// JSON in, stdout out) in an isolated sandbox copy of the repo; in-process
// adapters (like the pi extension) are out of its scope.
//
// Manifest format (paths relative to the repo root):
// {
//   "name": "codex",
//   "collector": {
//     "command": ["node", "adapters/codex/posttool.js"],
//     "samples": [                        // >=1: real stdin shapes of YOUR harness
//       { "input": { ... }, "expect": { "skill": "myskill", "session": "s1" } }
//     ],
//     "self_sample": { ... },             // an invocation of lamarck itself - must NOT be logged
//     "noise_sample": { ... }             // unrelated activity - must NOT be logged
//   },
//   "trigger": {
//     "command": ["node", "adapters/codex/stop.js"],
//     "input_template": "{\"session_id\":\"$SESSION\"}"   // $SESSION is substituted
//   }
// }
//
// Checks (exit 0 = conformant, 1 = not):
//   C1 each sample logs exactly one pending line with the six schema fields
//   C2 garbage stdin: exit 0, nothing logged
//   C3 the `off` kill switch silences the collector
//   C4 lamarck self-invocations and noise are not logged
//   T1 at threshold, the trigger emits the injected protocol (all load-bearing
//      clauses present, harness-specific envelope ignored)
//   T2 below threshold: silent   T3 empty pending: silent
//   T4 garbage stdin: exit 0, silent   T5 `off`: silent
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: node scripts/verify-adapter.js <manifest.json>'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Clauses every injected protocol must carry, whatever the envelope.
// Kept in lockstep with protocol/light-loop.md via the selftest.
const CLAUSES = ['trigger_fit', 'ESCALATE ONLY IF', 'rubrics', 'n=1 suffices',
  'clean entry whose scenario is not', 're-read immediately before writing',
  "':' replaced by '__'", 'lamarck LIGHT loop'];

// --- sandbox: a working copy of the repo so adapters resolve their ROOT.
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-conform-'));
for (const item of ['scripts', 'protocol', 'adapters']) {
  fs.cpSync(path.join(repo, item), path.join(sb, item), { recursive: true });
}
fs.mkdirSync(path.join(sb, 'data'), { recursive: true });
fs.writeFileSync(path.join(sb, 'config.json'), '{"mode":"threshold","threshold":2}', 'utf8');
const pending = path.join(sb, 'data', 'pending.jsonl');
const offFile = path.join(sb, 'off');

const run = (cmdArr, input) => spawnSync(cmdArr[0], cmdArr.slice(1).map(a => path.join(sb, a)),
  { input, encoding: 'utf8', cwd: sb, timeout: 20000 });
const lines = () => (fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8').split('\n').filter(l => l.trim()) : []);

let pass = 0; const fails = [];
const check = (n, c, extra) => {
  if (c) { pass++; console.log(`PASS  ${n}`); }
  else { fails.push(n); console.log(`FAIL  ${n}${extra ? '  [' + extra + ']' : ''}`); }
};

try {
  // ---------- collector ----------
  const col = manifest.collector;
  let i = 0;
  for (const s of col.samples) {
    i++;
    const before = lines().length;
    const r = run(col.command, JSON.stringify(s.input));
    const now = lines();
    const rec = now.length ? JSON.parse(now[now.length - 1]) : null;
    check(`C1.${i} sample logs one schema-complete pending line`,
      r.status === 0 && now.length === before + 1 && rec &&
      ['ts', 'session', 'skill', 'args', 'ver', 'harness', 'transcript'].every(k => k in rec) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(rec.ts) && rec.args.length <= 200 &&
      rec.skill === s.expect.skill && rec.session === s.expect.session &&
      typeof rec.harness === 'string' && rec.harness.length > 0 &&
      (!s.expect.harness || rec.harness === s.expect.harness),
      rec ? `got skill=${rec.skill} session=${rec.session} harness=${rec.harness}` : 'nothing logged');
  }
  let n0 = lines().length;
  check('C2 garbage stdin: exit 0, nothing logged',
    run(col.command, '{{not json').status === 0 && lines().length === n0);
  fs.writeFileSync(offFile, '', 'utf8');
  run(col.command, JSON.stringify(col.samples[0].input));
  check('C3 off switch silences the collector', lines().length === n0);
  fs.unlinkSync(offFile);
  if (col.self_sample) {
    run(col.command, JSON.stringify(col.self_sample));
    check('C4a lamarck self-invocation not logged', lines().length === n0);
  }
  if (col.noise_sample) {
    run(col.command, JSON.stringify(col.noise_sample));
    check('C4b unrelated activity not logged', lines().length === n0);
  }

  // ---------- trigger ----------
  const trg = manifest.trigger;
  const feed = (session) => run(trg.command, trg.input_template.split('$SESSION').join(session)).stdout || '';
  const seed = (session, count) => {
    const rows = [];
    for (let k = 0; k < count; k++) rows.push(JSON.stringify({
      ts: '2026-08-31T00:00:00Z', session, skill: 'conf-skill-' + k, args: '', ver: '', transcript: ''
    }));
    fs.writeFileSync(pending, rows.join('\n') + '\n', 'utf8');
  };
  seed('conf-below', 1);
  check('T2 below threshold: silent', feed('conf-below') === '');
  fs.writeFileSync(pending, '', 'utf8');
  check('T3 empty pending: silent', feed('conf-empty') === '');
  seed('conf-at', 2);
  check('T4 garbage stdin: exit 0, silent',
    run(trg.command, 'garbage{{').status === 0 && (run(trg.command, 'garbage{{').stdout || '') === '');
  fs.writeFileSync(offFile, '', 'utf8');
  check('T5 off switch silences the trigger', feed('conf-at') === '');
  fs.unlinkSync(offFile);
  const out = feed('conf-at');
  const missing = CLAUSES.filter(c => !out.includes(c));
  check('T1 at threshold: injected protocol carries every load-bearing clause',
    out !== '' && missing.length === 0, missing.length ? 'missing: ' + missing.join(' | ') : 'no output');
} finally {
  fs.rmSync(sb, { recursive: true, force: true });
}

const total = pass + fails.length;
console.log(`\nadapter '${manifest.name}': ${pass}/${total} conformance checks passed`);
if (fails.length) { fails.forEach(f => console.log(`  FAILED: ${f}`)); process.exit(1); }
process.exit(0);
