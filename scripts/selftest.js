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
fs.mkdirSync(path.join(base, 'skills', 'fakeskill'), { recursive: true });
fs.writeFileSync(path.join(base, 'skills', 'fakeskill', 'SKILL.md'), 'fake skill body', 'utf8');
fs.copyFileSync(path.join(repo, 'scripts', 'posttool-skill.js'), path.join(sb, 'scripts', 'posttool-skill.js'));
fs.copyFileSync(path.join(repo, 'scripts', 'stop-evaluate.js'), path.join(sb, 'scripts', 'stop-evaluate.js'));
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
  // Bilingual README sync: the zh-CN version must exist, cross-link, and
  // agree with the English one on the load-bearing facts.
  const zhPath = path.join(repo, 'README.zh-CN.md');
  if (fs.existsSync(zhPath)) {
    const en = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    const zh = fs.readFileSync(zhPath, 'utf8');
    // NOTE: no selftest count here - it changes with every added check.
    const facts = ['npx lamarck-skill', '4/5', '0/2', 'evolve / suggest / observe'];
    check('static: bilingual READMEs agree on key facts and cross-link',
      facts.every(f => en.includes(f) && zh.includes(f)) && en.includes('README.zh-CN.md') && zh.includes('README.md'));
  } else {
    check('static: bilingual READMEs agree on key facts and cross-link', false);
  }
  let localOk = true;
  if (fs.existsSync(path.join(repo, 'config.json'))) {
    try { localOk = ['every', 'manual', 'threshold'].includes(JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8')).mode); }
    catch { localOk = false; }
  }
  check('static: local config.json absent or legal', localOk);
  // Every relative markdown link in the READMEs must point at a file that
  // ships in the npm tarball - otherwise installed copies get dead links
  // (this is how the bench/ dangling reference was caught).
  const shipped = new Set(['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE',
    'SKILL.md', 'config.example.json', 'gitignore.template', 'package.json',
    'bin/install.js', 'scripts/posttool-skill.js', 'scripts/stop-evaluate.js',
    'scripts/selftest.js', 'data/rubrics/README.md']);
  const badLinks = [];
  for (const rf of ['README.md', 'README.zh-CN.md']) {
    const body = fs.readFileSync(path.join(repo, rf), 'utf8');
    for (const mm of body.matchAll(/\]\(([^)]+)\)/g)) {
      const t = mm[1].split('#')[0].trim();
      if (!t || t.startsWith('http')) continue;
      if (!shipped.has(t.replace(/^\.\//, ''))) badLinks.push(`${rf} -> ${t}`);
    }
  }
  check('static: README relative links all resolve inside the tarball', badLinks.length === 0);
  if (badLinks.length) badLinks.forEach(b => console.log(`        dead: ${b}`));
  check('static: gitignore.template matches .gitignore (no drift)',
    fs.readFileSync(path.join(repo, 'gitignore.template'), 'utf8') === fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'));
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
