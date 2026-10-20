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
fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5,"isolation":"inline"}', 'utf8');

const post = path.join(sb, 'scripts', 'posttool-skill.js');
const stop = path.join(sb, 'scripts', 'stop-evaluate.js');
const pending = path.join(sb, 'data', 'pending.jsonl');
const offFile = path.join(sb, 'off');

const postCall = (input) => spawnSync(process.execPath, [post], { input, encoding: 'utf8' }).status;
// LAMARCK_NO_SPAWN: background isolation must never launch a real worker
// from inside the selftest sandbox.
const stopCall = (input, env) => (spawnSync(process.execPath, [stop], { input, encoding: 'utf8', env: Object.assign({}, process.env, { LAMARCK_NO_SPAWN: '1' }, env || {}) }).stdout || '');
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
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":4,"isolation":"inline"}', 'utf8');
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
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5,"isolation":"inline"}', 'utf8');

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

  // ---------- evolve-worker: background evolution pipeline ----------
  // A fake headless runner stands in for claude/codex/pi: it parses the job
  // id out of the prompt and writes the inbox line the real agent would.
  const wkSb = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-worker-'));
  fs.mkdirSync(path.join(wkSb, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(wkSb, 'data'), { recursive: true });
  fs.mkdirSync(path.join(wkSb, 'suggestions'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts', 'evolve-worker.js'), path.join(wkSb, 'scripts', 'evolve-worker.js'));
  const fakeRunner = path.join(wkSb, 'fake-runner.js');
  // On Windows a {prompt} template receives a pointer to the brief on disk
  // (cmd.exe cannot carry JSON quotes); the fakes dereference it like a
  // real agent would.
  const DEREF = "let p=process.argv.slice(2).join(' ');const mm=/^Read the file (.+?) and follow it/.exec(p);if(mm){p=fs.readFileSync(mm[1],'utf8')}";
  fs.writeFileSync(fakeRunner,
    "const fs=require('fs');" + DEREF + "const m=/\\[([a-z0-9-]+)\\]/.exec(p);" +
    "const f=/to the file (\\S+?) \\(|to (\\S+?inbox\\.md) that/.exec(p);const file=(f&&(f[1]||f[2]))||'';" +
    "if(process.env.FAKE_AGENT_FAIL){fs.appendFileSync(file, `- [${m[1]}] FAILED: fake agent could not apply the proposal\\n`);process.exit(0)}" +
    "if(process.env.FAKE_FAIL){process.exit(3)}" +
    "fs.writeFileSync(require('path').join(require('path').dirname(process.argv[1]), 'last-prompt.txt'), p);" +
    "fs.appendFileSync(file, `- [${m[1]}] fake agent: applied, replay better, kept\\n`);", 'utf8');
  fs.writeFileSync(path.join(wkSb, 'suggestions', 'demo.md'), '# proposal\n- replace line 3 with X\n', 'utf8');
  fs.writeFileSync(path.join(wkSb, 'config.json'), JSON.stringify({
    mode: 'threshold', threshold: 5,
    background: { runner: 'fake', runners: { fake: ['node', fakeRunner, '{prompt}'] } }
  }), 'utf8');
  const wk = (args, env) => spawnSync(process.execPath, [path.join(wkSb, 'scripts', 'evolve-worker.js'), ...args],
    { encoding: 'utf8', env: Object.assign({}, process.env, { LAMARCK_NO_NOTIFY: '1' }, env || {}) });
  let w = wk(['enqueue', '--skill', 'demo', '--proposal', 'suggestions/demo.md', '--auth', 'user', '--no-spawn']);
  const jobsFile = path.join(wkSb, 'data', 'jobs.jsonl');
  check('worker: enqueue writes a queued job with the proposal path and authorization',
    w.status === 0 && w.stdout.includes('queued ') && fs.readFileSync(jobsFile, 'utf8').includes('"auth":"user"') && fs.readFileSync(jobsFile, 'utf8').includes('"status":"queued"'));
  check('worker: enqueue refuses a bad authorization and a missing proposal file',
    wk(['enqueue', '--skill', 'demo', '--proposal', 'suggestions/demo.md', '--auth', 'boss', '--no-spawn']).status === 2 &&
    wk(['enqueue', '--skill', 'demo', '--proposal', 'suggestions/nope.md', '--auth', 'user', '--no-spawn']).status === 2);
  w = wk(['run']);
  const jobsAfter = fs.readFileSync(jobsFile, 'utf8');
  const inboxAfter = fs.readFileSync(path.join(wkSb, 'data', 'inbox.md'), 'utf8');
  check('worker: run hands the job to the configured headless runner and marks it done',
    w.status === 0 && jobsAfter.includes('"status":"done"') && jobsAfter.includes('"runner":"fake"'));
  check('worker: the runner\'s inbox line is kept verbatim (worker adds none of its own)',
    inboxAfter.includes('fake agent: applied, replay better, kept') && (inboxAfter.match(/^- \[/gm) || []).length === 1);
  const lastPrompt = fs.readFileSync(path.join(wkSb, 'last-prompt.txt'), 'utf8');
  check('worker: the brief binds the agent to SKILL.md gate rules, names the proposal, the authorization and the confinement',
    lastPrompt.includes('SKILL.md') && lastPrompt.includes('Iron Rules') && lastPrompt.includes(path.join(wkSb, 'suggestions', 'demo.md')) &&
    lastPrompt.includes('approved this proposal') && lastPrompt.includes('never touch anything outside') && lastPrompt.includes('revert'));
  check('worker: every brief routes writes through store.js (headless file-editing tools are refused under the agent directory)',
    lastPrompt.includes(path.join(wkSb, 'scripts', 'store.js')) && lastPrompt.includes("'edit <rel>'") && lastPrompt.includes('at most 3 replacements') &&
    lastPrompt.includes('refuses scripts/, adapters/, bin/, config.json'));
  check('worker: lock released after the run', !fs.existsSync(path.join(wkSb, 'data', '.worker.lock')));
  const doneId = (JSON.parse(jobsAfter.split('\n')[0]) || {}).id;
  const runLog = path.join(wkSb, 'data', 'worker-logs', `${doneId}.log`);
  check('worker: the runner\'s command, brief and full output are kept per job under data/worker-logs/',
    fs.existsSync(runLog) && fs.readFileSync(runLog, 'utf8').includes('--- brief ---') && fs.readFileSync(runLog, 'utf8').includes('--- output (exit 0) ---') &&
    fs.readFileSync(runLog, 'utf8').includes('Iron Rules'));
  const cmdLine = fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf8').split('\n')[0] : '';
  check(process.platform === 'win32'
    ? 'worker: on Windows a {prompt} template gets a pointer to the brief file, never the brief through cmd.exe'
    : 'worker: a {prompt} template gets the brief itself as the argument',
    process.platform === 'win32'
      ? (cmdLine.includes('.brief.md') && !cmdLine.includes('Iron Rules') && !cmdLine.includes('\\"') && fs.existsSync(path.join(wkSb, 'data', 'worker-logs', `${doneId}.brief.md`)))
      : cmdLine.includes('Iron Rules'));
  w = wk(['status']);
  check('worker: status reports one unread result with its inbox line', w.stdout.includes('1 unread') && w.stdout.includes('fake agent'));
  w = wk(['status', '--ack']);
  check('worker: status --ack marks it read', w.stdout.includes('acknowledged 1') && wk(['status']).stdout.includes('0 unread'));
  check('worker: the runner inherits LAMARCK_HEADLESS and a headless enqueue cannot claim user authorization',
    wk(['enqueue', '--skill', 'demo', '--proposal', 'suggestions/demo.md', '--auth', 'user', '--no-spawn'], { LAMARCK_HEADLESS: '1' }).status === 2 &&
    wk(['enqueue', '--upgrade', '--from', '1', '--to', '2', '--notes', 'suggestions/demo.md', '--files', 'SKILL.md', '--no-spawn'], { LAMARCK_HEADLESS: '1' }).status === 2 &&
    wk(['enqueue', '--skill', 'demo', '--proposal', 'suggestions/demo.md', '--auth', 'auto', '--no-spawn'], { LAMARCK_HEADLESS: '1' }).status === 0 &&
    fs.readFileSync(path.join(wkSb, 'scripts', 'evolve-worker.js'), 'utf8').includes("LAMARCK_HEADLESS: '1'"));
  wk(['run'], { FAKE_AGENT_FAIL: '1' });
  check('worker: an agent that writes its own FAILED line yields a failed job, not done',
    /"auth":"auto"[^\n]*"status":"failed"/.test(fs.readFileSync(jobsFile, 'utf8')) && fs.readFileSync(jobsFile, 'utf8').includes('agent reported failure'));
  wk(['status', '--ack']);
  wk(['enqueue', '--ping', '--no-spawn']);
  w = wk(['run'], { FAKE_FAIL: '1' });
  check('worker: a failing runner yields a failed job and a FAILED inbox line, exit 0',
    w.status === 0 && fs.readFileSync(jobsFile, 'utf8').includes('"status":"failed"') && fs.readFileSync(path.join(wkSb, 'data', 'inbox.md'), 'utf8').includes('FAILED: runner exited 3'));
  fs.writeFileSync(path.join(wkSb, 'data', '.worker.lock'), String(process.pid), 'utf8');
  wk(['enqueue', '--ping', '--no-spawn']);
  check('worker: a lock held by a live process makes a second run stand down', wk(['run']).stdout.includes('already running') && fs.readFileSync(jobsFile, 'utf8').split('"status":"queued"').length === 2);
  fs.writeFileSync(path.join(wkSb, 'data', '.worker.lock'), '2147483646', 'utf8');
  check('worker: a lock whose owner is dead is taken over at once (no two-hour wait)',
    !wk(['run'], { FAKE_FAIL: '1' }).stdout.includes('already running') && fs.readFileSync(jobsFile, 'utf8').split('"status":"queued"').length === 1 &&
    !fs.existsSync(path.join(wkSb, 'data', '.worker.lock')));
  check('worker: the queue mutex is released after enqueue, run and ack', !fs.existsSync(path.join(wkSb, 'data', '.jobs.lock')));
  wk(['enqueue', '--ping', '--no-spawn']); // the stdin-channel run below expects one queued ping
  // stdin channel (claude-style template without {prompt}) + verdict by
  // inbox content: a runner that exits 0 but writes nothing is NOT done.
  const stdinRunner = path.join(wkSb, 'stdin-runner.js');
  fs.writeFileSync(stdinRunner,
    "const fs=require('fs');const p=fs.readFileSync(0,'utf8');fs.writeFileSync(require('path').join(__dirname,'stdin-prompt.txt'),p);" +
    "if(process.env.FAKE_SILENT){process.exit(0)}const m=/\\[([a-z0-9-]+)\\]/.exec(p);const f=/to the file (\\S+?) \\(/.exec(p);" +
    "fs.appendFileSync(f[1], `- [${m[1]}] ping ok\\n`);", 'utf8');
  fs.writeFileSync(path.join(wkSb, 'config.json'), JSON.stringify({ background: { runner: 'sr', runners: { sr: ['node', stdinRunner, '--flag', 'has space here'] } } }), 'utf8');
  w = wk(['run']);
  const stdinPrompt = fs.readFileSync(path.join(wkSb, 'stdin-prompt.txt'), 'utf8');
  check('worker: a template without {prompt} delivers the whole brief on stdin (no shell splitting)',
    stdinPrompt.includes('ping ok') && stdinPrompt.includes('lamarck pipeline check') && fs.readFileSync(jobsFile, 'utf8').includes('"status":"done"'));
  wk(['enqueue', '--ping', '--no-spawn']);
  wk(['run'], { FAKE_SILENT: '1' });
  check('worker: exit 0 without an inbox line is recorded as unverified, never done',
    fs.readFileSync(jobsFile, 'utf8').includes('"status":"unverified"') && fs.readFileSync(path.join(wkSb, 'data', 'inbox.md'), 'utf8').includes('UNVERIFIED'));
  // upgrade kind: the brief binds the agent to the notes, the saved conflicts, the gate and the code/genome split
  fs.writeFileSync(path.join(wkSb, 'notes.md'), '# notes\n- entry\n', 'utf8');
  fs.writeFileSync(path.join(wkSb, 'config.json'), JSON.stringify({ background: { runner: 'fake', runners: { fake: ['node', fakeRunner, '{prompt}'] } } }), 'utf8');
  check('worker: enqueue --upgrade validates its arguments',
    wk(['enqueue', '--upgrade', '--from', '1', '--to', '2', '--notes', 'missing.md', '--files', 'SKILL.md', '--no-spawn']).status === 2 &&
    wk(['enqueue', '--upgrade', '--from', '5.19.0', '--to', '5.20.0', '--notes', 'notes.md', '--files', 'SKILL.md,protocol/light-loop.md', '--no-spawn']).status === 0);
  wk(['run']);
  const upPrompt = fs.readFileSync(path.join(wkSb, 'last-prompt.txt'), 'utf8');
  check('worker: upgrade brief carries from/to, notes path, evolved files, conflicts dir, gate rules and the code-follows-upstream rule',
    upPrompt.includes('5.19.0 -> 5.20.0') && upPrompt.includes(path.join(wkSb, 'notes.md')) && upPrompt.includes('SKILL.md,protocol/light-loop.md') &&
    upPrompt.includes(path.join('upgrade-conflicts', '5.20.0')) && upPrompt.includes('Iron Rules') && upPrompt.includes('never change scripts/ or adapters/') &&
    upPrompt.includes('semantic coherence'));
  check('worker: upgrade job verified by its inbox line like any evolve job',
    fs.readFileSync(jobsFile, 'utf8').includes('"kind":"upgrade"') && /"kind":"upgrade"[^\n]*"status":"done"/.test(fs.readFileSync(jobsFile, 'utf8')));
  // evaluate kind (background isolation): the stop hook writes the job
  // directly; the worker's brief must hand the headless agent everything
  // the subagent brief carries, plus the non-interactive rules.
  const evalJob = {
    id: 'ev1-test', ts: '2026-10-20T00:00:00Z', kind: 'evaluate', session: 'sess-9', harness: 'claude-code',
    entries: [{ skill: 'alpha', ts: '2026-10-20T00:00:00Z', transcript: 'C:/tmp/t1.jsonl' }, { skill: 'beta', ts: '2026-10-20T00:01:00Z', transcript: '' }],
    objective: ['alpha@2026-10-20T00:00:00Z -> {"tools":3,"errors":0,"nonzero_exit":0,"retries":0,"user_turns":1,"lines":9}', 'beta@2026-10-20T00:01:00Z -> null (no transcript pointer)'],
    cadence: 'weekly', window_open: false, next_window: '2026-10-27T00:00:00Z', backlog: 2, status: 'queued', seen: false
  };
  const evalRunner = path.join(wkSb, 'eval-runner.js');
  fs.writeFileSync(evalRunner,
    "const fs=require('fs');" + DEREF + "const m=/\\[([a-z0-9-]+)\\]/.exec(p);const f=/to the file (\\S+?) \\(|to (\\S+?inbox\\.md) that/.exec(p);const file=f[1]||f[2];" +
    "if(/pipeline check/.test(p)){fs.appendFileSync(file, `- [${m[1]}] ping ok\\n`);process.exit(0)}" +
    "fs.writeFileSync(require('path').join(__dirname,'last-prompt.txt'),p);" +
    "if(process.env.FAKE_CHAIN){require('child_process').spawnSync(process.execPath,[require('path').join(__dirname,'scripts','evolve-worker.js'),'enqueue','--ping','--no-spawn'],{stdio:'ignore'})}" +
    "fs.appendFileSync(file, `- [${m[1]}] evaluated 2, gaps 0, user: ${process.env.FAKE_USER||'no'} - all clean\\n`);", 'utf8');
  fs.writeFileSync(path.join(wkSb, 'config.json'), JSON.stringify({ background: { runner: 'ev', runners: { ev: ['node', evalRunner, '{prompt}'] } } }), 'utf8');
  fs.writeFileSync(jobsFile, JSON.stringify(evalJob) + '\n', 'utf8');
  wk(['status', '--ack']);
  w = wk(['run']);
  const evPrompt = fs.readFileSync(path.join(wkSb, 'last-prompt.txt'), 'utf8');
  check('worker: evaluate brief names the protocol file, the session, every entry, the transcript and the objective lines verbatim',
    evPrompt.includes(path.join('protocol', 'light-loop.md')) && evPrompt.includes('session sess-9') && evPrompt.includes('alpha@2026-10-20T00:00:00Z') &&
    evPrompt.includes('beta@2026-10-20T00:01:00Z') && evPrompt.includes('C:/tmp/t1.jsonl') && evPrompt.includes('"tools":3') && evPrompt.includes('null (no transcript pointer)'));
  check('worker: evaluate brief names store.js, the pending-drop for its session and (ping) the store command for the inbox line',
    evPrompt.includes('pending-drop --session sess-9') && evPrompt.includes(path.join(wkSb, 'scripts', 'store.js')) &&
    stdinPrompt.includes('store.js append data/inbox.md --line'));
  check('worker: evaluate brief carries the closed cadence window, the backlog, the non-interactive proposal rule and the auto-tier route',
    evPrompt.includes('next window 2026-10-27T00:00:00Z - log only') && evPrompt.includes('2 pending entries from other sessions') &&
    evPrompt.includes('cannot ask the user') && evPrompt.includes('suggestions/<skill>.md') && evPrompt.includes('--auth auto --no-spawn') &&
    evPrompt.includes("'- [ev1-test] '") && evPrompt.includes('user: yes|no'));
  let evJobs = fs.readFileSync(jobsFile, 'utf8');
  check('worker: a quiet evaluation (user: no) is done, pre-acknowledged and raises no unread result',
    /"kind":"evaluate"[^\n]*"status":"done"/.test(evJobs) && /"kind":"evaluate"[^\n]*"seen":true/.test(evJobs) && wk(['status']).stdout.includes('0 unread'));
  fs.writeFileSync(jobsFile, JSON.stringify(Object.assign({}, evalJob, { id: 'ev2-test', window_open: true })) + '\n', 'utf8');
  wk(['run'], { FAKE_USER: 'yes' });
  evJobs = fs.readFileSync(jobsFile, 'utf8');
  check('worker: an evaluation that needs the user (user: yes) stays unread and the open window is briefed',
    /"id":"ev2-test"[^\n]*"seen":false/.test(evJobs) && wk(['status']).stdout.includes('1 unread') &&
    fs.readFileSync(path.join(wkSb, 'last-prompt.txt'), 'utf8').includes('the update window is open'));
  fs.writeFileSync(jobsFile, JSON.stringify(Object.assign({}, evalJob, { id: 'ev3-test' })) + '\n', 'utf8');
  wk(['run'], { FAKE_CHAIN: '1' });
  evJobs = fs.readFileSync(jobsFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  check('worker: a job enqueued during the run is drained by the same run (the auto-tier chain)',
    evJobs.length === 2 && evJobs.every(j => j.status === 'done') && evJobs[1].kind === 'ping');
  check('worker: a run with a runner clears .no-runner', !fs.existsSync(path.join(wkSb, 'data', '.no-runner')));
  fs.writeFileSync(path.join(wkSb, 'config.json'), '{"background":{"runner":"none"}}', 'utf8');
  wk(['enqueue', '--ping', '--no-spawn']);
  wk(['run']);
  check('worker: runner none fails the job gracefully with a clear inbox reason',
    fs.readFileSync(path.join(wkSb, 'data', 'inbox.md'), 'utf8').includes('no headless runner available'));
  check('worker: runner none leaves the .no-runner flag for the stop hook\'s inline fallback',
    fs.existsSync(path.join(wkSb, 'data', '.no-runner')) && fs.readFileSync(path.join(wkSb, 'data', '.no-runner'), 'utf8').includes('no headless runner'));
  fs.rmSync(wkSb, { recursive: true, force: true });

  // ---------- store.js: the headless write path (fence + bound mechanical) ----------
  const stBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-store-'));
  const stRoot = path.join(stBase, 'skills', 'lamarck');
  fs.mkdirSync(path.join(stRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(stRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(stBase, 'skills', 'other'), { recursive: true });
  fs.mkdirSync(path.join(stBase, 'elsewhere'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'scripts', 'store.js'), path.join(stRoot, 'scripts', 'store.js'));
  const st = (args, input) => spawnSync(process.execPath, [path.join(stRoot, 'scripts', 'store.js'), ...args], { input, encoding: 'utf8' });
  let s = st(['append', 'data/ledger.jsonl', '--line', '{"ts":"t1"}']);
  st(['append', 'data/ledger.jsonl'], '{"ts":"t2"}\n');
  check('store: append adds one line from --line or stdin, creating the file',
    s.status === 0 && s.stdout.includes('ok append data/ledger.jsonl') && fs.readFileSync(path.join(stRoot, 'data', 'ledger.jsonl'), 'utf8') === '{"ts":"t1"}\n{"ts":"t2"}\n');
  s = st(['write', 'data/maturity.json'], '{"alpha":{"state":"active"}}\n');
  check('store: write replaces a whole file from stdin', s.status === 0 && fs.readFileSync(path.join(stRoot, 'data', 'maturity.json'), 'utf8') === '{"alpha":{"state":"active"}}\n');
  fs.writeFileSync(path.join(stBase, 'skills', 'other', 'SKILL.md'), 'line a\r\nline b\r\nline c\r\n', 'utf8');
  s = st(['edit', '../other/SKILL.md'], JSON.stringify({ edits: [{ old: 'line b', new: 'line B\nline B2' }] }));
  check('store: edit applies a bounded replacement in a sibling skill and keeps its CRLF line endings',
    s.status === 0 && fs.readFileSync(path.join(stBase, 'skills', 'other', 'SKILL.md'), 'utf8') === 'line a\r\nline B\r\nline B2\r\nline c\r\n');
  // Each refused case would apply if its one rule were missing - so a
  // removed rule is a named failure, not a pass by accident.
  fs.writeFileSync(path.join(stBase, 'skills', 'other', 'FOUR.md'), 'one\ntwo\nthree\nfour\n', 'utf8');
  check('store: edit refuses ambiguous, oversized and too many replacements',
    st(['edit', '../other/SKILL.md'], JSON.stringify({ edits: [{ old: 'line', new: 'x' }] })).status === 2 &&
    st(['edit', '../other/SKILL.md'], JSON.stringify({ edits: [{ old: 'line a', new: 'x\n'.repeat(11) }] })).status === 2 &&
    st(['edit', '../other/FOUR.md'], JSON.stringify({ edits: ['one', 'two', 'three', 'four'].map(w => ({ old: w, new: w.toUpperCase() })) })).status === 2 &&
    fs.readFileSync(path.join(stBase, 'skills', 'other', 'FOUR.md'), 'utf8') === 'one\ntwo\nthree\nfour\n' &&
    fs.readFileSync(path.join(stBase, 'skills', 'other', 'SKILL.md'), 'utf8') === 'line a\r\nline B\r\nline B2\r\nline c\r\n');
  check('store: fence refuses code, config, .git and anything outside the skills directory',
    st(['append', 'scripts/store.js', '--line', 'x']).status === 2 && st(['append', 'adapters/x.js', '--line', 'x']).status === 2 &&
    st(['append', 'bin/install.js', '--line', 'x']).status === 2 && st(['append', 'config.json', '--line', 'x']).status === 2 &&
    st(['append', '.git/HEAD', '--line', 'x']).status === 2 && st(['append', '../other/.git/config', '--line', 'x']).status === 2 &&
    st(['append', '../../elsewhere/x.md', '--line', 'x']).status === 2 && st(['append', path.join(stBase, 'elsewhere', 'y.md'), '--line', 'x']).status === 2 &&
    !fs.existsSync(path.join(stRoot, 'adapters')) && !fs.existsSync(path.join(stBase, 'elsewhere', 'x.md')));
  check('store: genome files inside lamarck stay writable (SKILL.md, protocol, rubrics, suggestions)',
    st(['append', 'suggestions/alpha.md', '--line', '# p']).status === 0 && st(['append', 'data/rubrics/alpha.md', '--line', '- r']).status === 0 &&
    st(['write', 'SKILL.md'], 'x\n').status === 0 && st(['write', 'protocol/light-loop.md'], 'y\n').status === 0);
  check('store: write never rewrites an existing genome, ledger or learnings file - only designated state files',
    st(['write', 'SKILL.md'], 'z\n').status === 2 && st(['write', 'data/ledger.jsonl'], '{}\n').status === 2 && st(['write', '../other/SKILL.md'], 'z\n').status === 2 &&
    st(['write', 'data/maturity.json'], '{}\n').status === 0 && st(['write', 'suggestions/alpha.md'], '# p2\n').status === 0 && st(['write', 'data/rubrics/alpha.md'], '- r2\n').status === 0 &&
    st(['write', 'data/learnings/alpha.md'], 'new\n').status === 0 && st(['write', 'data/learnings/alpha.md'], 'again\n').status === 2 &&
    fs.readFileSync(path.join(stRoot, 'SKILL.md'), 'utf8') === 'x\n');
  check('store: the worker\'s own state and pending.jsonl are refused (pending changes only through pending-drop)',
    st(['append', 'data/jobs.jsonl', '--line', '{}']).status === 2 && st(['write', 'data/.worker.lock'], '1').status === 2 && st(['append', 'data/worker-logs/x.log', '--line', 'x']).status === 2 &&
    st(['append', 'data/pending.jsonl', '--line', '{}']).status === 2 && st(['write', 'data/pending.jsonl'], '{}\n').status === 2 && st(['append', 'data/hook-errors.log', '--line', 'x']).status === 2);
  check('store: the fence is case-insensitive and refuses Windows name tricks (trailing dot/space, 8.3 names, streams)',
    st(['append', 'SCRIPTS/x.js', '--line', 'x']).status === 2 && st(['append', 'Config.JSON', '--line', 'x']).status === 2 && st(['append', 'data/JOBS.jsonl', '--line', 'x']).status === 2 &&
    st(['append', 'config.json.', '--line', 'x']).status === 2 && st(['append', 'config.json ', '--line', 'x']).status === 2 && st(['append', 'CONFIG~1.JSO', '--line', 'x']).status === 2 &&
    st(['append', 'config.json::$DATA', '--line', 'x']).status === 2 && !fs.existsSync(path.join(stRoot, 'scripts', 'x.js')) && st(['append', 'data/..notes.md', '--line', 'ok']).status === 0);
  let linkOk = false;
  try { fs.symlinkSync(path.join(stBase, 'elsewhere'), path.join(stBase, 'skills', 'other', 'escape'), 'junction'); linkOk = true; } catch { /* no symlink privilege: skip */ }
  if (linkOk) {
    check('store: a symlink inside the skills directory cannot point a write outside it',
      st(['append', '../other/escape/leak.md', '--line', 'x']).status === 2 && !fs.existsSync(path.join(stBase, 'elsewhere', 'leak.md')));
  }
  fs.writeFileSync(path.join(stRoot, 'data', 'pending.jsonl'), '{"session":"a","skill":"s1"}\n{"session":"b","skill":"s2"}\nnot json\n{"session":"a","skill":"s3"}\n', 'utf8');
  s = st(['pending-drop', '--session', 'a']);
  check('store: pending-drop removes only that session\'s lines and keeps corrupt ones',
    s.status === 0 && s.stdout.includes('2 dropped, 2 kept') && fs.readFileSync(path.join(stRoot, 'data', 'pending.jsonl'), 'utf8') === '{"session":"b","skill":"s2"}\nnot json\n');
  check('store: unknown command and empty input are refused with exit 2',
    st(['frobnicate']).status === 2 && st(['append', 'data/x.md'], '').status === 2 && st(['write', 'data/x.md'], '').status === 2 && st(['pending-drop']).status === 2);
  fs.rmSync(stBase, { recursive: true, force: true });

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
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":2,"isolation":"inline"}', 'utf8');
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
    go.startsWith('[lamarck: ephemeral') && go.includes('lamarck LIGHT loop') && !go.startsWith('{'));
  fs.unlinkSync(gLatch);
  check('generic stop: unknown emit value stays silent (never a malformed envelope)',
    gStop('{"thread_id":"g1"}', 'chaos') === '');
  check('generic stop: honors stop_hook_active when the harness sends one',
    gStop('{"thread_id":"g1","stop_hook_active":true}', 'block') === '');
  try { fs.unlinkSync(latchC); } catch { /* may not exist */ }
  try { fs.unlinkSync(path.join(sb, 'data', '.cursor-stop-latch.json')); } catch { /* may not exist */ }
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":5,"isolation":"inline"}', 'utf8');

  // ---------- stop: mode variants & config fallbacks ----------
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline"}', 'utf8');
  fs.writeFileSync(pending, '', 'utf8');
  postCall('{"session_id":"s3","tool_name":"Skill","tool_input":{"skill":"one","args":""}}');
  check('stop: every mode blocks at 1', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('mode=every, needed=1'));
  fs.writeFileSync(cfgPath, '{"mode":"manual","isolation":"inline"}', 'utf8');
  check('stop: manual mode never blocks', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":1,"isolation":"inline"}', 'utf8');
  check('stop: custom threshold honored', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('needed=1'));
  fs.writeFileSync(cfgPath, 'broken{{', 'utf8');
  check('stop: corrupt config falls back threshold/5', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  fs.writeFileSync(cfgPath, '{"mode":"chaos","threshold":-3,"isolation":"inline"}', 'utf8');
  check('stop: illegal config values fall back threshold/5', stopCall('{"session_id":"s3","stop_hook_active":false}') === '');
  // ---------- stop: context isolation ----------
  // inline: the protocol body is injected. subagent: a short delegation
  // brief replaces it - the protocol is read from disk by the subagent and
  // the main context gets one line back. Both carry the ephemeral marker.
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline"}', 'utf8');
  let iso = stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: inline mode injects the protocol body and starts with the ephemeral marker',
    iso.includes('ESCALATE ONLY IF') && iso.includes('"reason":"[lamarck: ephemeral - omit from compaction summaries] '));
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"subagent"}', 'utf8');
  iso = stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: subagent mode injects a delegation brief instead of the protocol body',
    iso.includes('ISOLATION MODE') && iso.includes('Spawn ONE subagent') && iso.includes('BRIEF:') && !iso.includes('ESCALATE ONLY IF'));
  check('stop: subagent brief carries the objective signals, the protocol path and the inline fallback',
    iso.includes('Objective signals, counted by code') && iso.includes('light-loop.md') && iso.includes('run it inline instead'));
  check('stop: subagent mode still starts with the ephemeral marker and is byte-reproducible',
    iso.includes('"reason":"[lamarck: ephemeral') && stopCall('{"session_id":"s3","stop_hook_active":false}') === iso);
  // background (default): the hook never blocks - it queues one evaluate job
  // for the worker and the session output stays empty.
  const jobsSb = path.join(sb, 'data', 'jobs.jsonl');
  const jobsOf = () => (fs.existsSync(jobsSb) ? fs.readFileSync(jobsSb, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []);
  fs.writeFileSync(cfgPath, '{"mode":"every"}', 'utf8');
  let bg = stopCall('{"session_id":"s3","stop_hook_active":false}');
  let bj = jobsOf();
  check('stop: background is the default - no block, no injection, one evaluate job queued',
    bg === '' && bj.length === 1 && bj[0].kind === 'evaluate' && bj[0].status === 'queued' && bj[0].session === 's3');
  check('stop: the evaluate job carries entries, objective lines, cadence state and the harness',
    !!bj[0] && Array.isArray(bj[0].entries) && bj[0].entries.length >= 1 && bj[0].entries[0].skill && bj[0].entries[0].ts &&
    Array.isArray(bj[0].objective) && bj[0].objective.length === bj[0].entries.length && bj[0].objective[0].includes('->') &&
    bj[0].cadence === 'weekly' && bj[0].window_open === true && typeof bj[0].backlog === 'number' && bj[0].harness === 'claude-code');
  stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: a session with a queued evaluate job is not queued twice', jobsOf().length === 1);
  if (bj[0]) { bj[0].status = 'done'; fs.writeFileSync(jobsSb, JSON.stringify(bj[0]) + '\n', 'utf8'); }
  stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: once the job is done the next stop queues a new one', jobsOf().length === 2 && jobsOf()[1].status === 'queued');
  check('stop: background stays silent below the trigger and in manual mode', (() => {
    fs.writeFileSync(cfgPath, '{"mode":"threshold","threshold":50}', 'utf8');
    const a = stopCall('{"session_id":"s3","stop_hook_active":false}');
    fs.writeFileSync(cfgPath, '{"mode":"manual"}', 'utf8');
    const b = stopCall('{"session_id":"s3","stop_hook_active":false}');
    return a === '' && b === '' && jobsOf().length === 2;
  })());
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"background","background":{"runner":"none"}}', 'utf8');
  check('stop: background with runner none evaluates inline instead',
    stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF') && jobsOf().length === 2);
  fs.writeFileSync(cfgPath, '{"mode":"every"}', 'utf8');
  check('stop: LAMARCK_RUNNER=none in the environment means inline too (same rule as the worker)',
    stopCall('{"session_id":"s3","stop_hook_active":false}', { LAMARCK_RUNNER: 'none' }).includes('ESCALATE ONLY IF') && jobsOf().length === 2);
  fs.writeFileSync(path.join(sb, 'data', '.jobs.lock'), '1', 'utf8');
  const t0 = Date.now();
  check('stop: a fresh queue mutex held by someone else is waited for at most 2 s, then the job is skipped and logged',
    stopCall('{"session_id":"s3","stop_hook_active":false}') === '' && jobsOf().length === 2 && Date.now() - t0 >= 1900 &&
    fs.readFileSync(errLog, 'utf8').includes('jobs mutex not acquired'));
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(sb, 'data', '.jobs.lock'), stale, stale);
  check('stop: a stale queue mutex (older than 10 s) is removed and the job is queued',
    stopCall('{"session_id":"s3","stop_hook_active":false}') === '' && jobsOf().length === 2 && !fs.existsSync(path.join(sb, 'data', '.jobs.lock')));
  fs.writeFileSync(cfgPath, '{"mode":"every"}', 'utf8');
  const noRunner = path.join(sb, 'data', '.no-runner');
  fs.writeFileSync(noRunner, 'none', 'utf8');
  bj = jobsOf(); bj.forEach(j => { j.status = 'done'; }); fs.writeFileSync(jobsSb, bj.map(j => JSON.stringify(j)).join('\n') + '\n', 'utf8');
  check('stop: the worker\'s .no-runner flag makes background fall back to inline',
    stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF') && jobsOf().length === 2);
  const old = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(noRunner, old, old);
  check('stop: a .no-runner flag older than a day is ignored (a CLI installed later is found again)',
    stopCall('{"session_id":"s3","stop_hook_active":false}') === '' && jobsOf().length === 3);
  fs.unlinkSync(noRunner);
  fs.writeFileSync(jobsSb, 'garbage {{\n', 'utf8');
  const errLogBefore = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '';
  check('stop: a corrupt queue line is tolerated - the hook stays silent, still queues, logs nothing',
    stopCall('{"session_id":"s3","stop_hook_active":false}') === '' && fs.readFileSync(jobsSb, 'utf8').split('\n').filter(l => l.trim()).length === 2 &&
    (fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '') === errLogBefore);
  fs.unlinkSync(jobsSb);
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"chaos"}', 'utf8');
  check('stop: unknown isolation value falls back to the default (background)',
    stopCall('{"session_id":"s3","stop_hook_active":false}') === '' && jobsOf().length === 1);
  fs.unlinkSync(jobsSb);

  // ---------- stop: cadence (updates batched, telemetry continuous) ----------
  // No data/cadence.json = never opened = window due. A fresh stamp closes
  // it for the cadence period; continuous ignores the stamp entirely.
  const cadFile = path.join(sb, 'data', 'cadence.json');
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline"}', 'utf8');
  let cad = stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: default cadence is weekly and a never-opened window is open (escalation allowed, stamping instructed)',
    cad.includes('ESCALATE ONLY IF') && cad.includes('cadence=weekly') && cad.includes('write data/cadence.json'));
  fs.writeFileSync(cadFile, JSON.stringify({ last: new Date().toISOString() }), 'utf8');
  cad = stopCall('{"session_id":"s3","stop_hook_active":false}');
  check('stop: a fresh stamp closes the weekly window - log only, next window dated, no escalation',
    !cad.includes('ESCALATE ONLY IF') && cad.includes('Do NOT escalate this turn') && cad.includes('next window opens 20'));
  check('stop: closed window is byte-reproducible', stopCall('{"session_id":"s3","stop_hook_active":false}') === cad);
  fs.writeFileSync(cadFile, JSON.stringify({ last: new Date(Date.now() - 8 * 86400000).toISOString() }), 'utf8');
  check('stop: a stamp older than the period reopens the window',
    stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF'));
  fs.writeFileSync(cadFile, JSON.stringify({ last: new Date().toISOString() }), 'utf8');
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline","cadence":"continuous"}', 'utf8');
  check('stop: cadence continuous ignores the stamp',
    stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF'));
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline","cadence":"daily"}', 'utf8');
  fs.writeFileSync(cadFile, JSON.stringify({ last: new Date(Date.now() - 2 * 86400000).toISOString() }), 'utf8');
  check('stop: cadence daily reopens after one day', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('cadence=daily') && stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF'));
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"inline","cadence":"hourly"}', 'utf8');
  check('stop: unknown cadence falls back to weekly', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('cadence=weekly'));
  fs.writeFileSync(cadFile, 'not json', 'utf8');
  check('stop: corrupt cadence.json is treated as never opened', stopCall('{"session_id":"s3","stop_hook_active":false}').includes('ESCALATE ONLY IF'));
  fs.unlinkSync(cadFile);
  fs.writeFileSync(cfgPath, '{"mode":"every","isolation":"subagent"}', 'utf8');
  check('stop: subagent brief carries the cadence state too',
    stopCall('{"session_id":"s3","stop_hook_active":false}').includes('Cadence: the update window is open'));
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
  const skillMdEarly = fs.readFileSync(path.join(repo, 'SKILL.md'), 'utf8');
  check('static: config.example.json ships isolation=background (the session never sees the loop) and SKILL.md documents all three modes',
    cj.isolation === 'background' && skillMdEarly.includes('`isolation`') && skillMdEarly.includes('ephemeral') &&
    skillMdEarly.includes('`background`') && skillMdEarly.includes('`subagent`') && skillMdEarly.includes('`inline`') && skillMdEarly.includes('.no-runner'));
  check('static: both READMEs document background isolation as the default with the inline fallback',
    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('| `isolation` | `background` |') &&
    fs.readFileSync(path.join(repo, 'README.zh-CN.md'), 'utf8').includes('| `isolation` | `background` |'));
  check('static: SKILL.md and both READMEs document the merge-not-overwrite upgrade (base copy, conflicts dir, integration job)',
    skillMdEarly.includes('`.upstream/`') && skillMdEarly.includes('data/upgrade-conflicts/') && skillMdEarly.includes('data/upgrade-notes/') &&
    fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('three-way merges') &&
    fs.readFileSync(path.join(repo, 'README.zh-CN.md'), 'utf8').includes('三方合并'));
  check('static: config.example.json ships cadence=weekly and SKILL.md documents the batching semantics',
    cj.cadence === 'weekly' && skillMdEarly.includes('`cadence`') && skillMdEarly.includes('data/cadence.json') && skillMdEarly.includes('显式开窗'));
  check('static: config.example.json background block ships least-privilege headless templates for claude/codex/pi',
    cj.background && cj.background.runner === 'auto' && ['claude', 'codex', 'pi'].every(n => Array.isArray(cj.background.runners[n])) &&
    !cj.background.runners.claude.includes('{prompt}') /* brief via stdin - survives Windows shell splitting */ &&
    cj.background.runners.codex.includes('{prompt}') && cj.background.runners.pi.includes('{prompt}') &&
    cj.background.runners.claude.includes('--add-dir') && cj.background.runners.claude.includes('PowerShell(git:*)') &&
    !cj.background.runners.claude.join(' ').includes('dangerously'));
  check('static: SKILL.md routes approved and auto-tier edits through the background worker',
    skillMdEarly.includes('evolve-worker.js enqueue') && skillMdEarly.includes('默认不在本会话施工') && skillMdEarly.includes('status --ack'));
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
  check('static: protocol body carries exactly two placeholders, {{BACKLOG}} and {{ESCALATE}}',
    (protoBody.match(/\{\{BACKLOG\}\}/g) || []).length === 1 && (protoBody.match(/\{\{ESCALATE\}\}/g) || []).length === 1 &&
    (protoBody.match(/\{\{/g) || []).length === 2);
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

    // ---------- installer: upgrades merge, never silently overwrite ----------
    // A sandbox home gets a fresh install, then a "next upstream" copy of the
    // repo with known changes upgrades it twice: once with a clean local
    // edit (must survive), once with a conflicting one (upstream wins the
    // hunk, local saved, inbox informed, clean local hunks still survive).
    const ihome = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-ihome-'));
    const isrc2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-isrc-'));
    const itarget = path.join(ihome, '.claude', 'skills', 'lamarck');
    const inst = (from, extra) => spawnSync(process.execPath, [path.join(from, 'bin', 'install.js'), 'install', '--home', ihome, '--no-selftest', '--no-worker', ...(extra || [])], { encoding: 'utf8' });
    const ijobs = () => (fs.existsSync(path.join(itarget, 'data', 'jobs.jsonl')) ? rf(path.join(itarget, 'data', 'jobs.jsonl')).split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : []);
    // a missing file must FAIL the check that reads it, never crash the suite
    const rf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
    let ir = inst(repo);
    check('installer: fresh install copies CORE and records the pristine base with its version',
      ir.status === 0 && ir.stdout.includes(`copied  ${coreItems.length} files`) && fs.existsSync(path.join(itarget, '.upstream', 'SKILL.md')) &&
      rf(path.join(itarget, '.upstream', 'VERSION')).trim() === JSON.parse(fs.readFileSync(pjPath, 'utf8')).version);
    check('installer: installed .gitignore keeps the pristine base out of git',
      rf(path.join(itarget, '.gitignore')).includes('.upstream/') &&
      spawnSync('git', ['-C', itarget, 'check-ignore', '-q', '.upstream/VERSION']).status === 0);
    // next upstream: bump version, change a script, change one SKILL.md line
    for (const item of ['bin', 'scripts', 'protocol', 'adapters', 'data', 'SKILL.md', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'config.example.json', 'gitignore.template', 'package.json']) {
      fs.cpSync(path.join(repo, item), path.join(isrc2, item), { recursive: true });
    }
    const bumpSrc = (v) => {
      fs.writeFileSync(path.join(isrc2, 'package.json'), rf(path.join(isrc2, 'package.json')).replace(/"version": "[^"]+"/, `"version": "${v}"`), 'utf8');
      fs.writeFileSync(path.join(isrc2, 'SKILL.md'), rf(path.join(isrc2, 'SKILL.md')).replace(/^  version: "[^"]+"/m, `  version: "${v}"`), 'utf8');
    };
    bumpSrc('99.1.0');
    fs.appendFileSync(path.join(isrc2, 'scripts', 'report.js'), '\n// upstream 99.1 change\n', 'utf8');
    // local evolution: a new section at the end of SKILL.md (clean region)
    fs.appendFileSync(path.join(itarget, 'SKILL.md'), '\n## local evolution\n- a locally crystallized rule\n', 'utf8');
    ir = inst(isrc2);
    const sk1 = rf(path.join(itarget, 'SKILL.md'));
    check('installer: upgrade merges - local section survives AND upstream change lands in the same file',
      ir.status === 0 && sk1.includes('a locally crystallized rule') && sk1.includes('version: "99.1.0"') && ir.stdout.includes('1 merged, 0 conflict'));
    // the local file was appended with LF; the merge must neither flip its dominant ending nor leave conflict noise
    const eolOf = (s) => ((s.match(/\r\n/g) || []).length > (s.match(/(?<!\r)\n/g) || []).length ? 'crlf' : 'lf');
    check('installer: merge is line-ending insensitive and writes back the local file\'s dominant ending',
      eolOf(sk1) === eolOf(rf(path.join(repo, 'SKILL.md'))) && !sk1.includes('<<<<<<<'));
    check('installer: untouched files follow upstream, base refreshed to the new version',
      rf(path.join(itarget, 'scripts', 'report.js')).includes('upstream 99.1 change') && rf(path.join(itarget, '.upstream', 'VERSION')).trim() === '99.1.0' &&
      rf(path.join(itarget, '.upstream', 'SKILL.md')) === rf(path.join(isrc2, 'SKILL.md')));
    // the local genome had evolved -> a semantic-integration job is queued with upstream's notes
    const uj = ijobs().filter(j => j.kind === 'upgrade');
    check('installer: evolved genome queues one upgrade job carrying from/to, the evolved files and a notes file',
      uj.length === 1 && uj[0].to === '99.1.0' && uj[0].files === 'SKILL.md' && uj[0].auth === 'user' && uj[0].status === 'queued' &&
      fs.existsSync(uj[0].notes) && rf(uj[0].notes).includes('## What upstream changed') && ir.stdout.includes('queued  semantic integration'));
    // bump the changelog in the next upstream so the notes carry exactly the new entry
    fs.writeFileSync(path.join(isrc2, 'CHANGELOG.md'), rf(path.join(isrc2, 'CHANGELOG.md')).replace(/\n- /, '\n- 2099-01-01 | (自身) | v99.2.0:upstream test entry\n- '), 'utf8');
    // conflict: local and upstream both edit the version line; local also keeps its clean section
    fs.writeFileSync(path.join(itarget, 'SKILL.md'), sk1.replace('version: "99.1.0"', 'version: "99.1.0-local"'), 'utf8');
    bumpSrc('99.2.0');
    ir = inst(isrc2);
    const sk2 = rf(path.join(itarget, 'SKILL.md'));
    check('installer: conflict - upstream wins the conflicting hunk, the clean local hunk still survives',
      ir.status === 0 && sk2.includes('version: "99.2.0"') && !sk2.includes('99.1.0-local') && sk2.includes('a locally crystallized rule') && !sk2.includes('<<<<<<<'));
    check('installer: conflict - full local version saved, inbox informed, terminal says so',
      rf(path.join(itarget, 'data', 'upgrade-conflicts', '99.2.0', 'SKILL.md')).includes('99.1.0-local') &&
      rf(path.join(itarget, 'data', 'inbox.md')).includes('[upgrade-99.2.0]') && ir.stdout.includes('CONFLICT upstream 99.2.0'));
    const uj2 = ijobs().filter(j => j.kind === 'upgrade' && j.to === '99.2.0');
    check('installer: upgrade notes carry exactly the CHANGELOG entries new since the installed version',
      uj2.length === 1 && rf(uj2[0].notes).includes('v99.2.0:upstream test entry') && !rf(uj2[0].notes).includes('v5.19.0') &&
      rf(uj2[0].notes).includes('Conflicts (upstream won the hunk') && rf(uj2[0].notes).includes('SKILL.md'));
    // reinstalling the same version changes nothing
    const before = rf(path.join(itarget, 'SKILL.md'));
    ir = inst(isrc2);
    // SKILL.md still carries the clean local section, so it is "kept local" (base == upstream); everything else unchanged
    check('installer: same-version reinstall is a no-op (nothing updated or merged, no new conflict, no new inbox line)',
      ir.stdout.includes(`0 updated, ${coreItems.length - 1} unchanged, 1 kept local, 0 merged, 0 conflict`) && rf(path.join(itarget, 'SKILL.md')) === before &&
      rf(path.join(itarget, 'data', 'inbox.md')).split('[upgrade-99.2.0]').length === 2);
    // upgrade with no local edits is byte-identical to a plain copy (the old behavior).
    // Only package.json is bumped here so upstream does NOT touch SKILL.md this time.
    fs.writeFileSync(path.join(isrc2, 'package.json'), rf(path.join(isrc2, 'package.json')).replace(/"version": "[^"]+"/, '"version": "99.3.0"'), 'utf8');
    fs.appendFileSync(path.join(isrc2, 'protocol', 'adapter-contract.md'), '\nupstream 99.3 note\n', 'utf8');
    inst(isrc2);
    check('installer: upgrade without local edits reproduces upstream byte for byte',
      coreItems.filter(c => c !== 'SKILL.md').every(c => fs.readFileSync(path.join(itarget, ...c.split('/'))).equals(fs.readFileSync(path.join(isrc2, ...c.split('/'))))));
    // upstream did not touch SKILL.md in 99.3 (only the contract) -> local-only divergence queues nothing new
    check('installer: a genome file only the local side changed queues no integration job',
      ijobs().filter(j => j.kind === 'upgrade' && j.to === '99.3.0').length === 0);
    // a pristine local genome must queue nothing either - check with a fresh home
    const ihome2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-ihome2-'));
    const inst2 = (from) => spawnSync(process.execPath, [path.join(from, 'bin', 'install.js'), 'install', '--home', ihome2, '--no-selftest', '--no-worker'], { encoding: 'utf8' });
    inst2(repo); const r2 = inst2(isrc2);
    check('installer: upgrade with a pristine local genome queues NO integration job',
      r2.status === 0 && !r2.stdout.includes('semantic integration') && !fs.existsSync(path.join(ihome2, '.claude', 'skills', 'lamarck', 'data', 'jobs.jsonl')));
    fs.rmSync(ihome2, { recursive: true, force: true });
    // pre-5.20 install (no .upstream/): bootstrap the base from the last installer commit
    fs.rmSync(path.join(itarget, '.upstream'), { recursive: true, force: true });
    fs.appendFileSync(path.join(itarget, 'protocol', 'light-loop.md'), '\nlocal protocol note\n', 'utf8');
    bumpSrc('99.4.0');
    ir = inst(isrc2);
    check('installer: an install without .upstream/ bootstraps its base from git and still merges local edits',
      ir.status === 0 && rf(path.join(itarget, 'protocol', 'light-loop.md')).includes('local protocol note') && ir.stdout.includes('0 conflict'));
    check('installer: git history reads snapshot -> upgrade with the version named',
      spawnSync('git', ['-C', itarget, 'log', '--format=%s', '-n', '2'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] === 'lamarck upgrade to 99.4.0');
    fs.rmSync(ihome, { recursive: true, force: true });
    fs.rmSync(isrc2, { recursive: true, force: true });
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
