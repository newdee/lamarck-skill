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
  check('stop: reason embeds protocol (4 dims, escalate, user gate, replay, ver)',
    o.includes('trigger_fit') && o.includes('ESCALATE ONLY IF') && o.includes('AskUserQuestion') && o.includes('replays') && o.includes('carry ver over'));
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
