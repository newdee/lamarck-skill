#!/usr/bin/env node
// lamarck mechanism self-test. Cross-platform (Node 18+), CI-able:
// exit 0 = all pass, exit 1 = failures. Runs the hook scripts in an isolated
// temp sandbox that mimics the real skills-directory layout; never touches
// the live data/ directory. Requires node and git.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
let passes = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passes++; console.log(`PASS  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}`); }
}

// --- sandbox: <tmp>/skills/lamarck mimics the real layout so the ver-stamp
// --- path resolution (sibling skill dirs) works.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-selftest-'));
const sb = path.join(base, 'skills', 'lamarck');
fs.mkdirSync(path.join(sb, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(sb, 'protocol'), { recursive: true });
fs.mkdirSync(path.join(base, 'skills', 'fakeskill'), { recursive: true });
fs.writeFileSync(path.join(base, 'skills', 'fakeskill', 'SKILL.md'), 'fake skill body', 'utf8');
fs.copyFileSync(path.join(repo, 'scripts', 'posttool-skill.js'), path.join(sb, 'scripts', 'posttool-skill.js'));
fs.copyFileSync(path.join(repo, 'scripts', 'stop-evaluate.js'), path.join(sb, 'scripts', 'stop-evaluate.js'));
fs.copyFileSync(path.join(repo, 'protocol', 'light-loop.md'), path.join(sb, 'protocol', 'light-loop.md'));
for (const ad of ['codex', 'cursor', 'generic']) {
  fs.mkdirSync(path.join(sb, 'adapters', ad), { recursive: true });
  for (const f of ['posttool.js', 'stop.js']) {
    fs.copyFileSync(path.join(repo, 'adapters', ad, f), path.join(sb, 'adapters', ad, f));
  }
}
const cfgPath = path.join(sb, 'config.json');
fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5}', 'utf8');

const post = path.join(sb, 'scripts', 'posttool-skill.js');
const stop = path.join(sb, 'scripts', 'stop-evaluate.js');
const pending = path.join(sb, 'data', 'pending.jsonl');
const offFile = path.join(sb, 'off');

const postCall = (input) => spawnSync(process.execPath, [post], { input, encoding: 'utf8' }).status;
const stopCall = (input) => (spawnSync(process.execPath, [stop], { input, encoding: 'utf8' }).stdout || '');
const pendingLines = () => (fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8').split('\n').filter(l => l.trim()) : []);
const lastRec = () => JSON.parse(pendingLines().at(-1));
const gitIgnored = (p) => spawnSync('git', ['-C', repo, 'check-ignore', '-q', p]).status === 0;

try {
  // ---------- posttool ----------
  let rc = postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"fakeskill","args":"hello"},"transcript_path":"C:/tmp/session.jsonl"}');
  check('post: valid call logged, exit 0', rc === 0 && pendingLines().length === 1);
  const rec = lastRec();
  check('post: fields ts/session/skill/args/ver present', rec.session === 's1' && rec.skill === 'fakeskill' && rec.args === 'hello' && rec.ver !== undefined);
  check('post: harness defaults to claude-code on a real hook payload', rec.harness === 'claude-code');
  check('post: transcript pointer recorded when provided', rec.transcript === 'C:/tmp/session.jsonl');
  check('post: ver is 8-hex for resolvable skill', /^[0-9a-f]{8}$/.test(rec.ver));
  postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"fakeskill","args":"again"}}');
  check('post: ver deterministic across calls', lastRec().ver === rec.ver);
  check('post: transcript empty when absent', lastRec().transcript === '');
  postCall('{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}');
  check('post: non-Skill tool ignored', pendingLines().length === 2);
  postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"lamarck","args":""}}');
  check('post: self-invocation excluded', pendingLines().length === 2);
  rc = postCall('not json {{');
  check('post: malformed stdin exit 0, no append', rc === 0 && pendingLines().length === 2);
  rc = postCall('');
  check('post: empty stdin exit 0, no append', rc === 0 && pendingLines().length === 2);
  postCall(`{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"bigargs","args":"${'A'.repeat(500)}"}}`);
  check('post: args truncated to 200', lastRec().args.length === 200);
  check('post: ver empty for unresolvable skill', lastRec().ver === '');
  postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"plug:in","args":""}}');
  check('post: ver empty for plugin-style name', lastRec().ver === '');
  postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"uni","args":"把这篇做成网页文章"}}');
  check('post: unicode args roundtrip', lastRec().args === '把这篇做成网页文章');
  const bytes = fs.readFileSync(pending);
  check('post: pending.jsonl UTF-8 without BOM', !(bytes[0] === 0xef && bytes[1] === 0xbb));
  fs.writeFileSync(offFile, '', 'utf8');
  postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"nolog","args":""}}');
  check('post: off switch disables logging', !fs.readFileSync(pending, 'utf8').includes('nolog'));
  fs.unlinkSync(offFile);
  // Diagnosability: force a write failure (pending.jsonl as a directory) and
  // expect a hook-errors.log line while the hook still exits 0.
  const errLog = path.join(sb, 'data', 'hook-errors.log');
  const savedPending = fs.readFileSync(pending, 'utf8');
  fs.unlinkSync(pending);
  fs.mkdirSync(pending);
  rc = postCall('{"session_id":"s1","tool_name":"Skill","tool_input":{"skill":"errcase","args":""}}');
  check('post: unexpected error exits 0 AND leaves a diagnostic line',
    rc === 0 && fs.existsSync(errLog) && fs.readFileSync(errLog, 'utf8').includes('posttool-skill'));
  fs.rmdirSync(pending);
  fs.writeFileSync(pending, savedPending, 'utf8');

  // ---------- stop: threshold mode ----------
  fs.writeFileSync(pending, '', 'utf8');
  for (let i = 1; i <= 4; i++) postCall(`{"session_id":"s2","tool_name":"Skill","tool_input":{"skill":"sk${i}","args":""}}`);
  let o = stopCall('{"session_id":"s2","stop_hook_active":false}');
  check('stop: below threshold silent (4/5)', o === '');
  postCall('{"session_id":"s2","tool_name":"Skill","tool_input":{"skill":"sk5","args":""}}');
  o = stopCall('{"session_id":"s2","stop_hook_active":false}');
  check('stop: at threshold blocks (5/5)', o.includes('"decision":"block"'));
  check('stop: reason states mode and needed', o.includes('mode=threshold, needed=5'));
  check('stop: reason lists session and skills', o.includes('session_id=s2') && o.includes('sk1'));
  check('stop: reason embeds protocol (4 dims, escalate, user gate, replay, ver+harness)',
    o.includes('trigger_fit') && o.includes('ESCALATE ONLY IF') && o.includes('AskUserQuestion') && o.includes('replays') && o.includes('carry ver and harness over'));
  check('stop: reason fences cross-harness evidence as cross-scenario evidence',
    o.includes('cross-harness evidence is cross-scenario evidence') && o.includes('add a branch for that harness'));
  check('stop: reason downgrades proposals on harnesses that cannot ask or judge',
    o.includes('cannot ask a three-way') && o.includes('suggestions/<skill>.md'));
  // Context-pollution discipline: conclusions go to the data files, the
  // conversation gets at most a two-line summary.
  check('stop: reason demands quiet execution with a tiny visible summary',
    o.includes('QUIETLY') && o.includes('at most one or two summary lines'));
  check('stop: reason embeds maturity clause (stable-skip, wake, sample)',
    o.includes('maturity.json') && o.includes('stable-skip') && o.includes('wakes the skill back to active') && o.includes('stability.sample'));
  // The light loop is the ONLY automatic path that grows rubrics and replay
  // corpora; if these clauses fall out of the reason, both mechanisms are
  // declared in SKILL.md but never actually fire.
  check('stop: reason wires the rubric (scenario-matched judging + n=1 crystallization with provenance)',
    o.includes('rubrics') && o.includes('scenario tag matches this call') && o.includes('n=1 suffices') && o.includes('cite its ledger ts'));
  check('stop: replay harvesting covers uncovered clean scenarios, not only failures',
    o.includes('clean entry whose scenario is not yet represented'));
  // Plugin skill names carry a colon, which NTFS reads as an alternate data
  // stream - per-skill FILE paths must sanitize it, keys must not.
  // Pending cleanup is a read-modify-write on a file other sessions append to;
  // re-reading right before the write keeps a concurrent session's entry alive.
  check('stop: pending cleanup re-reads before rewriting (concurrent-append safety)',
    o.includes('re-read immediately before writing') && o.includes('must survive'));
  // suggestions/ matters most here: plugins are capped at the suggest tier, so
  // the colon-bearing names are exactly the ones that land in that directory.
  check('stop: reason sanitizes colons in every per-skill filename, suggestions included',
    o.includes("':' replaced by '__'") && o.includes('caveman__caveman-help') &&
    o.includes('suggestions alike') && o.includes('keep the real name'));
  const o2 = stopCall('{"session_id":"s2","stop_hook_active":false}');
  check('stop: output byte-identical across runs', o === o2);
  check('stop: other session silent', stopCall('{"session_id":"other","stop_hook_active":false}') === '');
  check('stop: missing session_id silent', stopCall('{"stop_hook_active":false}') === '');
  check('stop: stop_hook_active silent (loop guard)', stopCall('{"session_id":"s2","stop_hook_active":true}') === '');
  check('stop: malformed stdin silent', stopCall('garbage{{') === '');
  fs.writeFileSync(offFile, '', 'utf8');
  check('stop: off switch silent', stopCall('{"session_id":"s2","stop_hook_active":false}') === '');
  fs.unlinkSync(offFile);
  fs.appendFileSync(pending, 'CORRUPT-NOT-JSON\n', 'utf8');
  o = stopCall('{"session_id":"s2","stop_hook_active":false}');
  check('stop: corrupt pending line tolerated', o.includes('"decision":"block"'));

  // ---------- stop: single-source protocol injection ----------
  check('stop: reason declares the working directory for relative paths',
    o.includes('Working directory:') && o.includes('every relative path below resolves against it'));
  check('stop: no authoring comment or placeholder leaks into the reason',
    !o.includes('<!--') && !o.includes('{{'));
  const protoFile = path.join(sb, 'protocol', 'light-loop.md');
  const savedProto = fs.readFileSync(protoFile, 'utf8');
  fs.unlinkSync(protoFile);
  check('stop: missing protocol file stays silent (pending survives, one diagnostic logged)',
    stopCall('{"session_id":"s2","stop_hook_active":false}') === '' &&
    fs.readFileSync(path.join(sb, 'data', 'hook-errors.log'), 'utf8').includes('light-loop protocol'));
  fs.writeFileSync(protoFile, 'body with {{UNKNOWN}} placeholder', 'utf8');
  check('stop: unfilled placeholder stays silent instead of shipping a broken protocol',
    stopCall('{"session_id":"s2","stop_hook_active":false}') === '');
  fs.writeFileSync(protoFile, '<!-- unclosed comment\nprotocol body {{BACKLOG}}', 'utf8');
  check('stop: unclosed authoring comment stays silent instead of leaking into the reason',
    stopCall('{"session_id":"s2","stop_hook_active":false}') === '');
  fs.writeFileSync(protoFile, savedProto, 'utf8');
  check('stop: protocol restored, hook blocks again',
    stopCall('{"session_id":"s2","stop_hook_active":false}').includes('"decision":"block"'));

  // ---------- stop: other-session backlog (silent until actionable) ----------
  check('stop: no backlog note when other sessions are quiet',
    !o.includes('NOTE:'));
  for (let i = 1; i <= 4; i++) postCall(`{"session_id":"s9","tool_name":"Skill","tool_input":{"skill":"bk${i}","args":""}}`);
  check('stop: sub-threshold backlog stays silent',
    !stopCall('{"session_id":"s2","stop_hook_active":false}').includes('NOTE:'));
  postCall('{"session_id":"s9","tool_name":"Skill","tool_input":{"skill":"bk5","args":""}}');
  o = stopCall('{"session_id":"s2","stop_hook_active":false}');
  // The exact count also pins down what counts as backlog: a corrupt line
  // sits in pending.jsonl throughout this block and must NOT be tallied.
  check('stop: actionable backlog surfaced with exact count (corrupt lines excluded) and /lamarck pointer',
    o.includes('NOTE: 5 pending entries from other sessions') && o.includes("'/lamarck'"));
  check('stop: output stays byte-identical with the backlog clause present',
    stopCall('{"session_id":"s2","stop_hook_active":false}') === o);
  check('stop: backlog alone never blocks a session with no entries of its own',
    stopCall('{"session_id":"zzz","stop_hook_active":false}') === '');

  // ---------- stop: objective signals counted by code from the transcript ----------
  // A fabricated transcript with known counts; the hook must report them
  // exactly, stop counting at the next Skill activation, and answer null
  // (with a reason) when there is no pointer or no activation.
  const trFile = path.join(sb, 'data', 'obj-transcript.jsonl');
  const A = (ts, ...items) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: items } });
  const U = (ts, content, side) => JSON.stringify({ type: 'user', timestamp: ts, isSidechain: !!side, message: { role: 'user', content } });
  const tu = (name, input) => ({ type: 'tool_use', id: 'x', name, input });
  const tr = (content, isErr) => (isErr ? { type: 'tool_result', tool_use_id: 'x', content, is_error: true } : { type: 'tool_result', tool_use_id: 'x', content });
  fs.writeFileSync(trFile, [
    A('2026-09-01T10:00:00.000Z', tu('Skill', { skill: 'sk-a', args: '' })),
    A('2026-09-01T10:00:05.000Z', tu('Read', { path: 'a' })),
    U('2026-09-01T10:00:06.000Z', [tr('ok')]),
    A('2026-09-01T10:00:07.000Z', tu('Read', { path: 'a' })),
    U('2026-09-01T10:00:08.000Z', [tr('Exit code 2\n$ tsc\nerror TS2550', true)]),
    U('2026-09-01T10:00:09.000Z', 'please fix that'),
    U('2026-09-01T10:00:09.500Z', 'subagent chatter', true),
    A('2026-09-01T10:00:10.000Z', tu('Bash', { command: 'x' })),
    U('2026-09-01T10:00:11.000Z', [tr('Exit code 0\ndone')]),
    A('2026-09-01T10:05:00.000Z', tu('Skill', { skill: 'sk-b', args: '' })),
    A('2026-09-01T10:05:01.000Z', tu('Edit', { file: 'f' })),
    U('2026-09-01T10:05:02.000Z', [tr('boom', true)]),
    // 31 minutes after sk-b: outside the attribution window, must not count
    A('2026-09-01T10:36:30.000Z', tu('Bash', { command: 'late' })),
    U('2026-09-01T10:36:31.000Z', [tr('Exit code 1', true)])
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":4}', 'utf8');
  const pend = (ts, skill, transcript) => JSON.stringify({ ts, session: 'sobj', skill, args: '', ver: '', harness: 'claude-code', transcript });
  fs.writeFileSync(pending, [
    pend('2026-09-01T10:00:00Z', 'sk-a', trFile),
    pend('2026-09-01T10:05:00Z', 'sk-b', trFile),
    pend('2026-09-01T10:06:00Z', 'sk-c', ''),
    pend('2026-09-01T10:07:00Z', 'sk-z', trFile)
  ].join('\n') + '\n', 'utf8');
  o = stopCall('{"session_id":"sobj","stop_hook_active":false}');
  check('stop: objective header present and marked as code-counted',
    o.includes('Objective signals, counted by code') && o.includes('never estimate them'));
  check('stop: objective counts exact for the first activation window (tools/errors/exit/retries/user turns; sidechain excluded)',
    o.includes('sk-a@2026-09-01T10:00:00Z -> {\\"tools\\":3,\\"errors\\":1,\\"nonzero_exit\\":1,\\"retries\\":1,\\"user_turns\\":1,\\"lines\\":8}'));
  check('stop: objective window stops at the next Skill activation and at the 30-minute cap',
    o.includes('sk-b@2026-09-01T10:05:00Z -> {\\"tools\\":1,\\"errors\\":1,\\"nonzero_exit\\":0,\\"retries\\":0,\\"user_turns\\":0,\\"lines\\":2}'));
  check('stop: objective null with reason when the entry has no transcript pointer',
    o.includes('sk-c@2026-09-01T10:06:00Z -> null (no transcript pointer)'));
  check('stop: objective null with reason when the activation is not in the transcript',
    o.includes('sk-z@2026-09-01T10:07:00Z -> null (activation not found in transcript)'));
  check('stop: objective extraction is byte-reproducible',
    stopCall('{"session_id":"sobj","stop_hook_active":false}') === o);
  check('stop: protocol makes the model copy objective verbatim and demands quoted corrections',
    o.includes('copied verbatim or null') && o.includes('quoted verbatim in note'));
  fs.writeFileSync(pending, '', 'utf8');
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5}', 'utf8');

  // ---------- report.js: evidence numbers computed by code ----------
  // A fixture ledger with two versions of one skill, objective signals, a
  // regression in the second window, and verify records; every figure the
  // report prints must match what the fixture encodes.
  const rpSb = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-report-'));
  fs.mkdirSync(path.join(rpSb, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(rpSb, 'data'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts', 'report.js'), path.join(rpSb, 'scripts', 'report.js'));
  const row = (ts, skill, ver, outcome, objective, extra) => JSON.stringify(Object.assign({ ts, session: 's', skill, ver, harness: 'claude-code', objective, trigger_fit: 'ok', gaps: [], outcome, friction: '', note: '' }, extra || {}));
  const objv = (errors, nonzero_exit, retries) => ({ tools: 10, errors, nonzero_exit, retries, user_turns: 1, lines: 20 });
  fs.writeFileSync(path.join(rpSb, 'data', 'ledger.jsonl'), [
    row('2026-08-01T00:00:00Z', 'alpha', 'v1', 'clean', objv(0, 0, 0)),
    row('2026-08-02T00:00:00Z', 'alpha', 'v1', 'corrected', objv(2, 0, 0), { gaps: ['missing X, caused Y'], harness: 'codex' }),
    row('2026-08-03T00:00:00Z', 'alpha', 'v2', 'clean', objv(3, 1, 0)),
    row('2026-08-04T00:00:00Z', 'alpha', 'v2', 'clean', objv(3, 1, 2)),
    row('2026-08-05T00:00:00Z', 'alpha', 'v2', 'failed', objv(3, 0, 1), { gaps: ['missing X, caused Y'] }),
    row('2026-08-05T01:00:00Z', 'alpha', 'v2', 'stable-skip', null),
    row('2026-08-06T00:00:00Z', 'beta', '', 'clean', null),
    JSON.stringify({ ts: '2026-08-03T12:00:00Z', skill: 'alpha', type: 'verify', stage: 'replay', old_ver: 'v1', new_ver: 'v2', result: 'better', decision: 'keep', judges: 1, detail: '' }),
    JSON.stringify({ ts: '2026-08-05T12:00:00Z', skill: 'alpha', type: 'verify', stage: 'window', old_ver: 'v1', new_ver: 'v2', result: 'worse', decision: 'revert', judges: 0, detail: '' }),
    'CORRUPT LINE'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(rpSb, 'data', 'maturity.json'), '{"beta":{"state":"stable","clean_streak":12,"ver":""}}', 'utf8');
  fs.writeFileSync(path.join(rpSb, 'config.json'), '{"mode":"threshold","threshold":5,"evolution":{"default":"observe","evolve":["alpha"],"suggest":[],"auto":[]}}', 'utf8');
  fs.writeFileSync(path.join(rpSb, 'data', 'rejected.md'), '# rejected\n- one\n- two\n', 'utf8');
  const rp = (...args) => spawnSync(process.execPath, [path.join(rpSb, 'scripts', 'report.js'), ...args], { encoding: 'utf8' });
  const rj = JSON.parse(rp('--json').stdout);
  check('report: overview counts evaluations, skills, verify records, rejected proposals (corrupt line tolerated)',
    rj.overview.evaluations === 7 && rj.overview.skills === 2 && rj.overview.verify_records === 2 && rj.overview.rejected_proposals === 2 && rj.ledger_lines_total === 9);
  check('report: as_of is the ledger\'s latest timestamp, never the wall clock', rj.as_of === '2026-08-06T00:00:00Z');
  const al = rj.skills.alpha;
  check('report: correction rate counts only full evaluations (stable-skip excluded)', al.correction_rate === 0.4 && al.evaluations === 6);
  check('report: harness breakdown and tier from config', al.harness.codex === 1 && al.harness['claude-code'] === 5 && al.tier === 'evolve' && rj.skills.beta.tier === 'observe');
  check('report: per-version objective means exact', al.versions[0].objective.errors === 1 && al.versions[1].objective.errors === 3 && al.versions[1].objective.n === 3);
  check('report: version delta flags the objective regression per the veto rule (errors up, n>=3)',
    al.deltas.length === 1 && al.deltas[0].objective_delta.errors === 2 && al.deltas[0].objective_regression === true);
  check('report: verify tallies kept/reverted/judges/replay pass rate',
    al.verify.kept === 1 && al.verify.reverted === 1 && al.verify.judges_total === 1 && al.verify.replay_pass_rate === 1);
  check('report: top gap aggregated across versions', al.top_gaps[0].n === 2);
  check('report: maturity surfaces stable skills', rj.overview.stable_skills === 1 && rj.skills.beta.maturity.clean_streak === 12);
  const rSince = JSON.parse(rp('--json', '--since', '2d').stdout);
  // window = as_of (08-06) - 2d = 08-04: alpha 08-04, alpha 08-05, alpha stable-skip 08-05T01, beta 08-06
  check('report: --since anchors to as_of and drops older rows', rSince.overview.evaluations === 4 && rSince.since === '2026-08-04T00:00:00Z');
  const rSkill = JSON.parse(rp('--json', '--skill', 'beta').stdout);
  check('report: --skill filters to one skill', rSkill.overview.skills === 1 && rSkill.skills.beta && !rSkill.skills.alpha);
  const rmd = rp().stdout;
  check('report: markdown carries the skills table and the regression flag', rmd.includes('| alpha | evolve | 6 | 0.4 |') && rmd.includes('OBJECTIVE REGRESSION (veto)'));
  check('report: --brief omits the per-version detail', !rp('--brief').stdout.includes('### alpha - versions'));
  check('report: output byte-identical across runs', rp('--json').stdout === rp('--json').stdout && rp().stdout === rp().stdout);
  fs.rmSync(path.join(rpSb, 'data', 'ledger.jsonl'));
  const empty = rp('--json');
  check('report: missing ledger yields an empty report, exit 0', empty.status === 0 && JSON.parse(empty.stdout).overview.evaluations === 0);
  check('report: bad --since value exits 2 with a message', rp('--since', 'yesterday').status === 2);
  fs.rmSync(rpSb, { recursive: true, force: true });

  // ---------- adapters: codex + cursor shims over the reference scripts ----------
  // The shims translate each harness's documented stdin/stdout contract and
  // delegate all logic to scripts/. Fabricated inputs follow the published
  // field names; a live-session validation is out of selftest scope.
  const shim = (ad, f, input) => spawnSync(process.execPath, [path.join(sb, 'adapters', ad, f)], { input, encoding: 'utf8' });
  fs.writeFileSync(pending, '', 'utf8');
  let sr = shim('codex', 'posttool.js',
    '{"session_id":"cx1","hook_event_name":"PostToolUse","tool_name":"read","tool_input":{"path":"C:/Users/u/.codex/skills/myskill/SKILL.md"},"transcript_path":"C:/t/cx.jsonl"}');
  let rec2 = pendingLines().length ? lastRec() : null;
  check('codex posttool: SKILL.md read becomes a pending line with session and transcript',
    sr.status === 0 && rec2 && rec2.skill === 'myskill' && rec2.session === 'cx1' && rec2.transcript === 'C:/t/cx.jsonl' && rec2.args.startsWith('codex:read'));
  check('codex posttool: harness stamped as codex', rec2 && rec2.harness === 'codex');
  shim('codex', 'posttool.js', '{"session_id":"cx1","tool_name":"read","tool_input":{"path":"C:\\\\Users\\\\u\\\\.claude\\\\skills\\\\winskill\\\\SKILL.md"}}');
  check('codex posttool: windows backslash path detected (JSON-escaped haystack)',
    pendingLines().length === 2 && lastRec().skill === 'winskill');
  shim('codex', 'posttool.js', '{"session_id":"cx1","tool_name":"read","tool_input":{"path":"C:/x/notes.md"}}');
  check('codex posttool: non-skill read ignored', pendingLines().length === 2);
  shim('codex', 'posttool.js', '{"session_id":"cx1","tool_name":"read","tool_input":{"path":"C:/s/lamarck/SKILL.md"}}');
  check('codex posttool: lamarck self-read excluded', pendingLines().length === 2);
  check('codex posttool: garbage stdin exits 0, no append', shim('codex', 'posttool.js', '{{nope').status === 0 && pendingLines().length === 2);
  sr = shim('cursor', 'posttool.js',
    '{"conversation_id":"cu1","hook_event_name":"postToolUse","tool_call":{"path":"/home/u/.claude/skills/webskill/SKILL.md"},"transcript_path":"/tmp/cu.jsonl"}');
  rec2 = lastRec();
  check('cursor posttool: conversation_id maps to session, skill extracted',
    sr.status === 0 && rec2.skill === 'webskill' && rec2.session === 'cu1' && rec2.transcript === '/tmp/cu.jsonl');
  check('cursor posttool: harness stamped as cursor', rec2.harness === 'cursor');
  shim('cursor', 'posttool.js', '{"conversation_id":"cu1","transcript_path":"/skills/decoy/SKILL.md","workspace_roots":["/skills/decoy2/SKILL.md"],"tool_call":{"path":"/x/readme.md"}}');
  check('cursor posttool: SKILL.md inside transcript/workspace fields is not an activation', pendingLines().length === 3);
  // stop shims: fill to the threshold for one codex session, then evaluate
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":2}', 'utf8');
  shim('codex', 'posttool.js', '{"session_id":"cx1","tool_name":"read","tool_input":{"path":"/s/otherskill/SKILL.md"}}');
  const latchC = path.join(sb, 'data', '.codex-stop-latch.json');
  let so = shim('codex', 'stop.js', '{"session_id":"cx1","hook_event_name":"Stop","last_assistant_message":"done"}').stdout || '';
  check('codex stop: delegates and speaks the claude-compatible block contract',
    so.includes('"decision":"block"') && so.includes('lamarck LIGHT loop') && so.includes('trigger_fit'));
  check('codex stop: latch written after a block', fs.existsSync(latchC));
  check('codex stop: cooldown latch silences the immediate re-fire',
    (shim('codex', 'stop.js', '{"session_id":"cx1"}').stdout || '') === '');
  fs.writeFileSync(latchC, JSON.stringify({ session: 'cx1', ts: Date.now() - 600000 }), 'utf8');
  check('codex stop: expired latch fires again',
    (shim('codex', 'stop.js', '{"session_id":"cx1"}').stdout || '').includes('"decision":"block"'));
  fs.unlinkSync(latchC);
  shim('cursor', 'posttool.js', '{"conversation_id":"cu1","tool_call":{"path":"/home/u/.claude/skills/otherweb/SKILL.md"}}');
  so = shim('cursor', 'stop.js', '{"conversation_id":"cu1","hook_event_name":"stop"}').stdout || '';
  check('cursor stop: translates the block into a followup_message with the protocol',
    so.includes('"followup_message"') && !so.includes('"decision"') && so.includes('lamarck LIGHT loop'));
  check('cursor stop: no session id stays silent', (shim('cursor', 'stop.js', '{"hook_event_name":"stop"}').stdout || '') === '');
  fs.writeFileSync(pending, '', 'utf8');
  check('codex stop: empty pending stays silent (latch or not)',
    (shim('codex', 'stop.js', '{"session_id":"cx9"}').stdout || '') === '');
  // generic fallback: tolerant extraction across field conventions, and the
  // --emit envelope switch on the trigger.
  shim('generic', 'posttool.js', '{"thread_id":"g1","event":"tool_done","payload":{"target":"/opt/skills/alpha-skill/SKILL.md"}}');
  let grec = lastRec();
  check('generic posttool: thread_id + arbitrary nesting extracted',
    grec.skill === 'alpha-skill' && grec.session === 'g1');
  check('generic posttool: harness stamped (generic default, LAMARCK_HARNESS overridable)', grec.harness === 'generic');
  shim('generic', 'posttool.js', '{"sessionId":"g1","transcriptPath":"/skills/decoy/SKILL.md","workspaceFolders":["/skills/d2/SKILL.md"],"note":"no activation here"}');
  check('generic posttool: transcript/workspace variants excluded from the scan', lastRec().skill === 'alpha-skill');
  shim('generic', 'posttool.js', '{"session":"g1","x":{"p":"/s/beta-skill/SKILL.md"}}');
  const gLatch = path.join(sb, 'data', '.generic-stop-latch.json');
  const gStop = (input, emit) => (spawnSync(process.execPath,
    [path.join(sb, 'adapters', 'generic', 'stop.js'), `--emit=${emit}`],
    { input, encoding: 'utf8' }).stdout || '');
  let go = gStop('{"conversation_id":"g1"}', 'block');
  check('generic stop --emit=block: claude/codex envelope with the protocol',
    go.includes('"decision":"block"') && go.includes('lamarck LIGHT loop'));
  fs.unlinkSync(gLatch);
  go = gStop('{"session_id":"g1"}', 'followup');
  check('generic stop --emit=followup: cursor envelope', go.includes('"followup_message"') && !go.includes('"decision"'));
  fs.unlinkSync(gLatch);
  go = gStop('{"thread_id":"g1"}', 'text');
  check('generic stop --emit=text: bare protocol text (no JSON envelope)',
    go.startsWith('lamarck LIGHT loop') && !go.startsWith('{'));
  fs.unlinkSync(gLatch);
  check('generic stop: unknown emit value stays silent (never a malformed envelope)',
    gStop('{"thread_id":"g1"}', 'chaos') === '');
  check('generic stop: honors stop_hook_active when the harness sends one',
    gStop('{"thread_id":"g1","stop_hook_active":true}', 'block') === '');
  try { fs.unlinkSync(latchC); } catch { /* may not exist */ }
  try { fs.unlinkSync(path.join(sb, 'data', '.cursor-stop-latch.json')); } catch { /* may not exist */ }
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5}', 'utf8');

  // ---------- stop: mode variants & config fallbacks ----------
  fs.writeFileSync(cfgPath, '{"mode":"every"}', 'utf8');
  fs.writeFileSync(pending, '', 'utf8');
  postCall('{"session_id":"s3","tool_name":"Skill","tool_input":{"skill":"one","args":""}}');
  check('stop: every mode blocks at 1', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('mode=every, needed=1'));
  fs.writeFileSync(cfgPath, '{"mode":"manual"}', 'utf8');
  check('stop: manual mode never blocks', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":1}', 'utf8');
  check('stop: custom threshold honored', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('needed=1'));
  fs.writeFileSync(cfgPath, 'broken{{', 'utf8');
  check('stop: corrupt config falls back threshold/5', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  fs.writeFileSync(cfgPath, '{"mode":"chaos","threshold":-3}', 'utf8');
  check('stop: illegal config values fall back threshold/5', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  fs.unlinkSync(cfgPath);
  check('stop: missing config falls back threshold/5', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');

  // ---------- static checks against the real repo ----------
  const md = fs.readFileSync(path.join(repo, 'SKILL.md'), 'utf8');
  const fm = md.split('---')[1] || '';
  const name = (fm.match(/name: (\S+)/) || [])[1] || '';
  const desc = (fm.match(/description: (.+)/) || [])[1] || '';
  // Directory-name match only matters where Claude Code discovers skills
  // (a parent directory literally named "skills"); a dev checkout may be
  // cloned as lamarck-skill and that is fine.
  const deployed = path.basename(path.dirname(repo)) === 'skills';
  check('static: frontmatter name is lamarck; matches directory when deployed',
    name === 'lamarck' && (!deployed || path.basename(repo) === 'lamarck'));
  check('static: description within 1024 chars', desc.length > 0 && desc.length <= 1024);
  check('static: SKILL.md under 500 lines', md.split('\n').length < 500);
  // Git-boundary checks only make sense when this directory is itself the
  // repository root. An installed copy has no .git of its own - and if it
  // happens to sit inside some OTHER repository (e.g. a CI workspace),
  // git would walk up and judge our paths against the wrong .gitignore.
  let inGitRepo = false;
  const top = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status === 0) {
    inGitRepo = path.resolve(top.stdout.trim()).toLowerCase() === path.resolve(repo).toLowerCase();
  }
  if (inGitRepo) {
    check('static: telemetry ignored, rubrics+README tracked',
      gitIgnored('data/ledger.jsonl') && gitIgnored('data/pending.jsonl') && gitIgnored('data/replays/x.jsonl') &&
      !gitIgnored('data/rubrics/x.md') && !gitIgnored('README.md'));
    check('static: local config.json untracked (personal state)', gitIgnored('config.json'));
  } else {
    console.log('SKIP  static git-boundary checks (no .git here - installed copy)');
  }
  const cj = JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'));
  check('static: config.example.json valid, mode legal, evolution block sane',
    ['every', 'manual', 'threshold'].includes(cj.mode) && ['observe', 'suggest', 'evolve'].includes(cj.evolution.default));
  check('static: config.example.json stability block sane', cj.stability.streak >= 1 && cj.stability.sample >= 1);
  check('static: config.example.json auto tier is an array (trust ladder)', Array.isArray(cj.evolution.auto));
  const skillMd = fs.readFileSync(path.join(repo, 'SKILL.md'), 'utf8');
  check('static: auto tier documented with its forbidden zone (lamarck self, Iron Rules, plugins)',
    skillMd.includes('evolution.auto') && /永不受 auto 覆盖|永不适用 auto/.test(skillMd) && skillMd.includes('放行条件'));
  check('static: empty replay corpus demotes auto (no zero-validation landings)',
    skillMd.includes('replay 语料为空') && skillMd.includes('降级为三选一'));
  check('static: SKILL.md and the light loop agree on rubric wiring and clean-scenario harvesting',
    skillMd.includes('结晶进 `data/rubrics/') && skillMd.includes('场景尚未被语料覆盖的 clean'));
  check('static: SKILL.md documents the colon->__ filename rule for plugin skills',
    skillMd.includes('caveman__caveman-help') && skillMd.includes('文件名规则'));
  check('static: SKILL.md ledger schema and fencing carry the harness dimension',
    skillMd.includes('"harness"') && skillMd.includes('harness 即场景标签之一'));
  const contractEarly = fs.readFileSync(path.join(repo, 'protocol', 'adapter-contract.md'), 'utf8');
  check('static: contract schema documents the harness field and the executor downgrade rule',
    contractEarly.includes('"harness"') && contractEarly.includes('cross-harness evidence as cross-scenario evidence') &&
    contractEarly.includes('downgrades every gate-passing proposal'));
  // Single-source protocol: the file must exist with its one placeholder,
  // the adapter must reference it, and the adapter contract must describe
  // the collector's pending-line fields so a foreign adapter can implement
  // them without reading the claude-code hook source.
  // Judge the BODY the adapter injects, i.e. after stripping the authoring
  // comment (which may itself mention the placeholder while documenting it).
  const protoBody = fs.readFileSync(path.join(repo, 'protocol', 'light-loop.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  check('static: protocol body carries exactly one placeholder, {{BACKLOG}}',
    (protoBody.match(/\{\{BACKLOG\}\}/g) || []).length === 1 && (protoBody.match(/\{\{/g) || []).length === 1);
  check('static: protocol body keeps paths relative (no absolute or backslashed paths)',
    !/[A-Za-z]:\\/.test(protoBody) && protoBody.includes('data/pending.jsonl'));
  // The protocol is injected on every trigger; unlike SKILL.md it had no
  // growth budget until it quietly crossed 3.5k chars. Hard ceiling now -
  // raising it is a deliberate decision, not a side effect.
  check('static: injected protocol body stays under the 3600-char budget',
    protoBody.replace(/\s+/g, ' ').trim().length <= 3600);
  check('static: stop hook injects the single-source protocol file',
    fs.readFileSync(path.join(repo, 'scripts', 'stop-evaluate.js'), 'utf8').includes("'light-loop.md'"));
  const contract = fs.readFileSync(path.join(repo, 'protocol', 'adapter-contract.md'), 'utf8');
  check('static: adapter contract names the three roles and every pending-line field',
    ['collector', 'trigger', 'executor', '"ts"', '"session"', '"skill"', '"args"', '"ver"', '"transcript"']
      .every(k => contract.toLowerCase().includes(k.toLowerCase())));
  // Shipped adapters: each harness dir carries its shims (or extension),
  // wiring template and README; the pi extension must render the same
  // single-source protocol, never a fork of it.
  for (const ad of ['codex', 'cursor']) {
    const hj = JSON.parse(fs.readFileSync(path.join(repo, 'adapters', ad, 'hooks.json'), 'utf8'));
    check(`static: ${ad} hooks.json template is valid JSON and points at both shims`,
      JSON.stringify(hj).includes(`adapters/${ad}/posttool.js`) && JSON.stringify(hj).includes(`adapters/${ad}/stop.js`) &&
      fs.existsSync(path.join(repo, 'adapters', ad, 'README.md')));
  }
  const piExt = fs.readFileSync(path.join(repo, 'adapters', 'pi', 'lamarck.ts'), 'utf8');
  check('static: pi extension renders the single-source protocol (no fork) and fails closed',
    piExt.includes("'light-loop.md'") || piExt.includes('"light-loop.md"'));
  check('static: pi extension supports LAMARCK_HOME override and the off switch',
    piExt.includes('LAMARCK_HOME') && piExt.includes('offSwitch'));
  check('static: every adapter README states its verification status honestly',
    ['codex', 'cursor', 'pi'].every(ad =>
      fs.readFileSync(path.join(repo, 'adapters', ad, 'README.md'), 'utf8').includes('Verification status')));
  // Conformance verifier: the executable half of the adapter contract.
  // Every shipped command-style adapter must pass it end to end.
  for (const ad of ['claude-code', 'codex', 'cursor', 'generic']) {
    const vr = spawnSync(process.execPath,
      [path.join(repo, 'scripts', 'verify-adapter.js'), path.join(repo, 'adapters', ad, 'manifest.json')],
      { encoding: 'utf8', timeout: 120000 });
    const sum = ((vr.stdout || '').match(/conformance checks passed/) || [])[0];
    check(`conformance: ${ad} adapter passes the verifier end to end`, vr.status === 0 && !!sum);
  }
  check('static: contract documents the agent-writes-lamarck-verifies workflow with a paste-ready prompt',
    contract.includes('verify-adapter.js') && contract.includes('the agent writes, lamarck verifies') &&
    contract.includes('Paste this to the new harness'));
  check('static: contract sets the three-attempt budget with the generic fallback',
    contract.includes('THREE verifier runs') && contract.includes('adapters/generic/') &&
    contract.includes('never generic by default'));
  // Post-install onboarding: the installer's closing block is the one
  // message every npx user is guaranteed to see - it must name the restart,
  // the liveness probe, the other harnesses and the observe-only default.
  if (fs.existsSync(path.join(repo, 'bin', 'install.js'))) {
    const inst = fs.readFileSync(path.join(repo, 'bin', 'install.js'), 'utf8');
    check('static: installer ends with the full next-steps block',
      inst.includes('next steps') && inst.includes('Prove it is alive') &&
      inst.includes("adapters', 'codex'") && inst.includes('adapter-contract.md') &&
      inst.includes('observe-only'));
  }
  check('static: manual /lamarck opens with the wiring self-check for users who never ran the installer',
    skillMd.includes('接线自检') && skillMd.includes('接线指引') &&
    skillMd.includes('接线正常、数据未至') && skillMd.includes('不发接线指引'));
  check('static: historical backlog drain is delegated to a subagent (transcript evidence travels, context does not)',
    skillMd.includes('派独立 subagent 清算') && skillMd.includes('主上下文只收每条一行结论'));
  // Bilingual README sync: the zh-CN version must exist, cross-link, and
  // agree with the English one on the load-bearing facts.
  const zhPath = path.join(repo, 'README.zh-CN.md');
  if (fs.existsSync(zhPath)) {
    const en = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    const zh = fs.readFileSync(zhPath, 'utf8');
    // NOTE: no selftest count here - it changes with every added check.
    // Whitespace is collapsed first so hard-wrapped lines still match.
    const facts = ['npx lamarck-skill', '4/5', '0/2', 'auto / evolve / suggest / observe'];
    const norm = (s) => s.replace(/\s+/g, ' ');
    check('static: bilingual READMEs agree on key facts and cross-link',
      facts.every(f => norm(en).includes(f) && norm(zh).includes(f)) && en.includes('README.zh-CN.md') && zh.includes('README.md'));
  } else {
    check('static: bilingual READMEs agree on key facts and cross-link', false);
  }
  let localOk = true;
  if (fs.existsSync(path.join(repo, 'config.json'))) {
    try { localOk = ['every', 'manual', 'threshold'].includes(JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8')).mode); }
    catch { localOk = false; }
  }
  check('static: local config.json absent or legal', localOk);
  // Tarball invariants run only in the dev checkout (installed copies ship
  // neither package.json nor bin/). There, links are checked against disk.
  const pjPath = path.join(repo, 'package.json');
  const mdLinks = (rf) => {
    const out = [];
    for (const mm of fs.readFileSync(path.join(repo, rf), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      const t = mm[1].split('#')[0].trim();
      if (t && !t.startsWith('http')) out.push(t.replace(/^\.\//, ''));
    }
    return out;
  };
  if (fs.existsSync(pjPath)) {
    // The tarball file set is DERIVED from package.json (single source of
    // truth, no hand-maintained copy to drift), plus npm's auto-includes.
    const pjFiles = JSON.parse(fs.readFileSync(pjPath, 'utf8')).files || [];
    const shipped = new Set(['README.md', 'LICENSE', 'package.json']);
    for (const f of pjFiles) {
      if (f.endsWith('/')) { for (const e of fs.readdirSync(path.join(repo, f))) shipped.add(f + e); }
      else shipped.add(f);
    }
    // Invariant 1: everything the installer copies must actually ship
    // (the v5.4.1 missing-template bug, closed as a class).
    const coreSrc = fs.readFileSync(path.join(repo, 'bin', 'install.js'), 'utf8');
    const coreItems = [...coreSrc.match(/const CORE = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    const unshipped = coreItems.filter(c => !shipped.has(c));
    check('static: installer CORE list ships entirely in the tarball', unshipped.length === 0);
    if (unshipped.length) unshipped.forEach(c => console.log(`        missing: ${c}`));
    // Invariant 2: every relative markdown link in every shipped .md must
    // resolve inside the tarball - installed copies get no dead links.
    const badLinks = [];
    for (const rf of [...shipped].filter(f => f.endsWith('.md'))) {
      for (const t of mdLinks(rf)) if (!shipped.has(t)) badLinks.push(`${rf} -> ${t}`);
    }
    check('static: all shipped-markdown relative links resolve inside the tarball', badLinks.length === 0);
    if (badLinks.length) badLinks.forEach(b => console.log(`        dead: ${b}`));
  } else {
    console.log('SKIP  tarball invariants (installed copy - no package.json)');
    const mds = ['README.md', 'README.zh-CN.md', 'SKILL.md', 'CHANGELOG.md', 'data/rubrics/README.md']
      .filter(f => fs.existsSync(path.join(repo, f)));
    const dead = [];
    for (const rf of mds) for (const t of mdLinks(rf)) if (!fs.existsSync(path.join(repo, t))) dead.push(`${rf} -> ${t}`);
    check('static: markdown relative links resolve on disk', dead.length === 0);
    if (dead.length) dead.forEach(b => console.log(`        dead: ${b}`));
  }
  // npm never packs a .gitignore, so an unpacked tarball has only the
  // template - the installer writes the real file from it. Assert the
  // template always, compare only where both exist; a missing optional file
  // must not abort the suite.
  const tpl = path.join(repo, 'gitignore.template');
  const gi = path.join(repo, '.gitignore');
  check('static: gitignore.template present and non-empty',
    fs.existsSync(tpl) && fs.readFileSync(tpl, 'utf8').trim().length > 0);
  if (fs.existsSync(gi)) {
    check('static: gitignore.template matches .gitignore (no drift)',
      fs.readFileSync(tpl, 'utf8') === fs.readFileSync(gi, 'utf8'));
  } else {
    console.log('SKIP  gitignore drift check (unpacked tarball has no .gitignore - the installer writes it)');
  }
  check('static: both hooks reference the diagnostic hook-errors.log',
    fs.readFileSync(path.join(repo, 'scripts', 'posttool-skill.js'), 'utf8').includes('hook-errors.log') &&
    fs.readFileSync(path.join(repo, 'scripts', 'stop-evaluate.js'), 'utf8').includes('hook-errors.log'));
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('');
const total = passes + fails.length;
console.log(`lamarck selftest: ${passes}/${total} passed`);
if (fails.length) { fails.forEach(f => console.log(`  FAILED: ${f}`)); process.exit(1); }
process.exit(0);
