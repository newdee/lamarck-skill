#!/usr/bin/env node
// lamarck installer: npx github:newdee/lamarck-skill  (or: npx lamarck-skill)
// Copies the skill into ~/.claude/skills/lamarck, initializes local config,
// wires the two hooks into ~/.claude/settings.json (backup first, idempotent,
// add-only), then runs the selftest so the install proves itself.
// Commands: install (default) | uninstall.
// Flags: --home <dir> (for testing), --no-selftest (skip the final selftest).
//
// Upgrades MERGE, they do not overwrite. lamarck evolves itself (it ships in
// the evolve tier), so the installed SKILL.md and protocol may legitimately
// differ from what was shipped. The installer keeps a pristine copy of the
// last shipped files in .upstream/ and three-way merges base / local / new
// per file (git merge-file). Clean merge -> landed. Conflict -> upstream
// wins, the local version is saved under data/upgrade-conflicts/<version>/
// and one line goes to data/inbox.md so the next /lamarck surfaces it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) || 'install';
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? argv[homeIdx + 1] : os.homedir();
const skipSelftest = argv.includes('--no-selftest');
const noWorker = argv.includes('--no-worker'); // queue the upgrade job but do not spawn the worker (tests)
// Genome = what the local lamarck may have evolved. Code follows upstream.
const GENOME = ['SKILL.md', 'protocol/light-loop.md', 'protocol/adapter-contract.md', 'data/rubrics/README.md'];

const claudeDir = path.join(home, '.claude');
const target = path.join(claudeDir, 'skills', 'lamarck');
const settingsPath = path.join(claudeDir, 'settings.json');
const src = path.resolve(__dirname, '..');

const CORE = [
  'SKILL.md', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE',
  'config.example.json', 'gitignore.template',
  'scripts/posttool-skill.js', 'scripts/stop-evaluate.js', 'scripts/selftest.js', 'scripts/verify-adapter.js', 'scripts/report.js', 'scripts/evolve-worker.js',
  'protocol/light-loop.md', 'protocol/adapter-contract.md',
  'adapters/claude-code/manifest.json',
  'adapters/codex/posttool.js', 'adapters/codex/stop.js', 'adapters/codex/hooks.json', 'adapters/codex/README.md', 'adapters/codex/manifest.json',
  'adapters/cursor/posttool.js', 'adapters/cursor/stop.js', 'adapters/cursor/hooks.json', 'adapters/cursor/README.md', 'adapters/cursor/manifest.json',
  'adapters/pi/lamarck.ts', 'adapters/pi/README.md',
  'adapters/generic/posttool.js', 'adapters/generic/stop.js', 'adapters/generic/README.md', 'adapters/generic/manifest.json',
  'data/rubrics/README.md'
];
const HOOK_DEFS = [
  { event: 'PostToolUse', matcher: 'Skill', script: 'posttool-skill.js', status: 'lamarck: logging skill call...' },
  { event: 'Stop', matcher: null, script: 'stop-evaluate.js', status: 'lamarck: light evaluation check...' }
];

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}
function backupSettings() {
  if (!fs.existsSync(settingsPath)) return null;
  const bak = `${settingsPath}.bak-lamarck-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
  fs.copyFileSync(settingsPath, bak);
  return bak;
}
function entryIsOurs(entry, script) {
  const s = JSON.stringify(entry);
  return s.includes('lamarck') && s.includes(script);
}

// ---- upgrade merge -------------------------------------------------------
const UPSTREAM_DIR = '.upstream';
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const same = (a, b) => !!a && !!b && a.equals(b);
function shippedVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version); } catch { /* no package.json */ }
  const m = /version:\s*"?([\d.]+)"?/.exec(String(readIf(path.join(src, 'SKILL.md')) || ''));
  return m ? m[1] : 'unknown';
}
// Pre-5.20 installs have no .upstream/. Their last installer commit ("lamarck
// install baseline" / "lamarck upgrade") holds pristine CORE files - use it
// as the base once, so the first merging upgrade still sees local edits.
function bootstrapBaseCommit() {
  const r = spawnSync('git', ['-C', target, 'log', '--author=lamarck-install', '--extended-regexp',
    '--grep=^lamarck (install baseline|upgrade)', '--format=%H', '-n', '1'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
function baseFor(rel, bootstrapCommit, localBuf) {
  const fromDir = readIf(path.join(target, UPSTREAM_DIR, ...rel.split('/')));
  if (fromDir) return fromDir;
  if (!bootstrapCommit) return null;
  const r = spawnSync('git', ['-C', target, 'show', `${bootstrapCommit}:${rel}`], { encoding: 'buffer' });
  return r.status === 0 ? r.stdout : null;
}
// Line endings are not content. A file an agent appended to may mix CRLF and
// LF, git normalizes blobs to LF, tarballs ship LF, checkouts may be CRLF -
// so every comparison and merge runs on LF-normalized text, and a merged
// result is written back in the local file's dominant ending. Files copied
// from upstream keep upstream's exact bytes.
const toLF = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
const prefersCRLF = (b) => { const s = b.toString('utf8'); return (s.match(/\r\n/g) || []).length > (s.match(/(?<!\r)\n/g) || []).length; };
const withEol = (lfBuf, crlf) => (crlf ? Buffer.from(lfBuf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8') : lfBuf);
// git merge-file on three temp files. Clean -> { ok: true, merged }.
// Conflict -> { ok: false, merged } where merged resolves only the
// conflicting hunks in upstream's favor and keeps every clean local hunk
// (--theirs). null when git is unavailable (caller overwrites and saves).
function threeWay(localBuf, baseBuf, newBuf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-merge-'));
  try {
    const L = path.join(dir, 'local'), B = path.join(dir, 'base'), N = path.join(dir, 'new');
    fs.writeFileSync(L, localBuf); fs.writeFileSync(B, baseBuf); fs.writeFileSync(N, newBuf);
    const labels = ['-L', 'local', '-L', 'base', '-L', 'upstream'];
    const r = spawnSync('git', ['merge-file', '-p', ...labels, L, B, N], { encoding: 'buffer' });
    if (r.error || r.status === null || r.status < 0 || r.status >= 128) return null;
    if (r.status === 0) return { ok: true, merged: r.stdout };
    const t = spawnSync('git', ['merge-file', '-p', '--theirs', ...labels, L, B, N], { encoding: 'buffer' });
    if (t.error || t.status === null || t.status < 0 || t.status >= 128) return null;
    return { ok: false, merged: t.stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function saveConflict(version, rel, localBuf) {
  const p = path.join(target, 'data', 'upgrade-conflicts', version, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, localBuf);
  return p;
}

function install() {
  // 0. upgrade safety: snapshot local state BEFORE touching anything, so
  // every local edit stays recoverable from history whatever the merge does.
  const isUpgrade = fs.existsSync(path.join(target, 'SKILL.md'));
  if (isUpgrade && fs.existsSync(path.join(target, '.git'))) {
    spawnSync('git', ['-C', target, 'add', '-A']);
    const snap = spawnSync('git', ['-C', target,
      '-c', 'user.name=lamarck-install', '-c', 'user.email=lamarck@localhost',
      'commit', '-m', 'pre-upgrade snapshot']);
    if (snap.status === 0) console.log('git     pre-upgrade snapshot committed');
  }

  // 1. land core files. Fresh install: plain copy. Upgrade: three-way merge
  //    per file against the pristine base (see header). data/ and
  //    config.json are never touched.
  const version = shippedVersion();
  const bootstrap = (isUpgrade && !fs.existsSync(path.join(target, UPSTREAM_DIR))) ? bootstrapBaseCommit() : '';
  if (isUpgrade && !fs.existsSync(path.join(target, UPSTREAM_DIR))) {
    console.log(bootstrap
      ? `base    no ${UPSTREAM_DIR}/ yet - using the last installer commit ${bootstrap.slice(0, 7)} as the merge base (exact for pre-5.20 installs; local edits stay in git history either way)`
      : `base    no ${UPSTREAM_DIR}/ and no installer commit - upstream wins this once, local versions of changed files are saved`);
  }
  const tally = { copied: 0, unchanged: 0, kept: 0, merged: 0, conflict: 0, nobase: 0 };
  const conflicts = [];
  const evolved = []; // genome files BOTH sides changed (merged / conflict / no-base) - the ones with upstream intent to integrate
  const oldVersion = (readIf(path.join(target, UPSTREAM_DIR, 'VERSION')) || '').toString().trim() || (isUpgrade ? 'pre-5.20' : '');
  const oldChangelog = (readIf(path.join(target, UPSTREAM_DIR, 'CHANGELOG.md')) || readIf(path.join(target, 'CHANGELOG.md')) || Buffer.alloc(0)).toString('utf8');
  for (const rel of CORE) {
    const to = path.join(target, ...rel.split('/'));
    const newBuf = fs.readFileSync(path.join(src, ...rel.split('/')));
    const localBuf = readIf(to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!localBuf) { fs.writeFileSync(to, newBuf); tally.copied++; continue; }
    const L = toLF(localBuf), N = toLF(newBuf);
    if (same(L, N)) { tally.unchanged++; continue; }
    const baseRaw = isUpgrade ? baseFor(rel, bootstrap) : null;
    if (!baseRaw) {
      // no base to merge against: upstream wins, but the local file is saved
      if (GENOME.includes(rel)) evolved.push(rel);
      conflicts.push(rel); saveConflict(version, rel, localBuf);
      fs.writeFileSync(to, newBuf); tally.nobase++; continue;
    }
    const B = toLF(baseRaw);
    if (same(L, B)) { fs.writeFileSync(to, newBuf); tally.copied++; continue; } // user never touched it
    if (same(B, N)) { tally.kept++; continue; }                                 // upstream never touched it
    // both sides touched this file: the only case with new upstream intent to integrate
    if (GENOME.includes(rel)) evolved.push(rel);
    const crlf = prefersCRLF(localBuf);
    const m = threeWay(L, B, N);
    if (m && m.ok) { fs.writeFileSync(to, withEol(m.merged, crlf)); tally.merged++; continue; }
    // conflict: upstream wins the conflicting hunks only (clean local hunks
    // survive); without git, upstream wins the whole file. Local saved either way.
    conflicts.push(rel); saveConflict(version, rel, localBuf);
    fs.writeFileSync(to, m ? withEol(m.merged, crlf) : newBuf); tally.conflict++;
  }
  // refresh the pristine base for the next upgrade
  const upDir = path.join(target, UPSTREAM_DIR);
  fs.rmSync(upDir, { recursive: true, force: true });
  for (const rel of CORE) {
    const p = path.join(upDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split('/')), p);
  }
  fs.writeFileSync(path.join(upDir, 'VERSION'), version + '\n', 'utf8');
  console.log(isUpgrade
    ? `merged  ${CORE.length} files -> ${target}: ${tally.copied} updated, ${tally.unchanged} unchanged, ${tally.kept} kept local, ${tally.merged} merged, ${tally.conflict + tally.nobase} conflict(s)`
    : `copied  ${CORE.length} files -> ${target}`);
  if (conflicts.length) {
    const where = path.join(target, 'data', 'upgrade-conflicts', version);
    console.log(`CONFLICT upstream ${version} won the conflicting hunks in: ${conflicts.join(', ')}\n        your full local versions are saved under ${where}\n        re-apply what you still want through /lamarck (the gate), the local edit needs re-approval against the new base`);
    fs.mkdirSync(path.join(target, 'data'), { recursive: true });
    fs.appendFileSync(path.join(target, 'data', 'inbox.md'),
      `- [upgrade-${version}] ${conflicts.length} local edit(s) could not be merged (${conflicts.join(', ')}); upstream version landed, local versions saved under data/upgrade-conflicts/${version}/ - re-apply through the gate if still wanted\n`, 'utf8');
  }
  // Semantic integration: when the local genome had evolved, the mechanical
  // merge is not the last word. Hand the local lamarck upstream's own account
  // of the release (the CHANGELOG entries new since the installed version)
  // and let it integrate - through the gate - in the background.
  if (isUpgrade && evolved.length) {
    const newChangelog = fs.readFileSync(path.join(src, 'CHANGELOG.md'), 'utf8');
    const oldEntries = new Set(oldChangelog.split('\n').filter(l => l.startsWith('- ')));
    let delta = newChangelog.split('\n').filter(l => l.startsWith('- ') && !oldEntries.has(l));
    if (!delta.length) delta = newChangelog.split('\n').filter(l => l.startsWith('- ')).slice(0, 5);
    const notesDir = path.join(target, 'data', 'upgrade-notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const notesPath = path.join(notesDir, `${version}.md`);
    fs.writeFileSync(notesPath,
      `# lamarck upgrade ${oldVersion} -> ${version}\n\nGenome files with local evolution: ${evolved.join(', ')}\n` +
      `Conflicts (upstream won the hunk, local saved under data/upgrade-conflicts/${version}/): ${conflicts.join(', ') || 'none'}\n\n` +
      `## What upstream changed since ${oldVersion} (CHANGELOG entries)\n\n${delta.join('\n')}\n`, 'utf8');
    const q = spawnSync(process.execPath, [path.join(target, 'scripts', 'evolve-worker.js'), 'enqueue', '--upgrade',
      '--from', oldVersion, '--to', version, '--notes', notesPath, '--files', evolved.join(','), ...(noWorker ? ['--no-spawn'] : [])],
      { encoding: 'utf8', cwd: target });
    console.log(q.status === 0
      ? `queued  semantic integration of ${evolved.length} evolved genome file(s) -> background worker (${(q.stdout || '').trim()}); notes: ${notesPath}`
      : `WARN    could not queue the semantic integration job: ${(q.stderr || q.stdout || '').trim()}`);
  }
  // old installs: make sure the pristine base never gets committed
  const giPath = path.join(target, '.gitignore');
  if (fs.existsSync(giPath) && !fs.readFileSync(giPath, 'utf8').includes(`${UPSTREAM_DIR}/`)) {
    fs.appendFileSync(giPath, `# Pristine copy of the last shipped files - the base for upgrade merges\n${UPSTREAM_DIR}/\n`, 'utf8');
  }

  // 2. local config from example, only if absent
  const cfg = path.join(target, 'config.json');
  if (!fs.existsSync(cfg)) {
    fs.copyFileSync(path.join(target, 'config.example.json'), cfg);
    console.log('created config.json from config.example.json');
  } else {
    console.log('kept    existing config.json');
  }

  // 2b. version control: npm never ships .gitignore, so it travels as
  // gitignore.template. Materialize it and git-init the skill directory so
  // installed users get the same git-versioned rubrics and rollback the
  // repo README promises. Best-effort: no git, no problem (.bak fallback).
  const gi = path.join(target, '.gitignore');
  const tpl = path.join(src, 'gitignore.template');
  if (fs.existsSync(tpl) && !fs.existsSync(gi)) {
    fs.copyFileSync(tpl, gi);
    console.log('created .gitignore from template');
  }
  if (!fs.existsSync(path.join(target, '.git'))) {
    const init = spawnSync('git', ['-C', target, 'init', '-b', 'main']);
    if (init.status === 0) {
      spawnSync('git', ['-C', target, 'add', '-A']);
      const ci = spawnSync('git', ['-C', target,
        '-c', 'user.name=lamarck-install', '-c', 'user.email=lamarck@localhost',
        'commit', '-m', 'lamarck install baseline']);
      console.log(ci.status === 0
        ? 'git     initialized with an install-baseline commit'
        : 'git     initialized (baseline commit skipped)');
    } else {
      console.log('git     not available - rollback falls back to .bak files');
    }
  } else if (isUpgrade) {
    // record the upgrade itself so the local history reads snapshot -> upgrade
    spawnSync('git', ['-C', target, 'add', '-A']);
    const up = spawnSync('git', ['-C', target,
      '-c', 'user.name=lamarck-install', '-c', 'user.email=lamarck@localhost',
      'commit', '-m', `lamarck upgrade to ${version}`]);
    if (up.status === 0) console.log('git     upgrade committed');
  }

  // 3. wire hooks (add-only, idempotent)
  const settings = loadSettings();
  settings.hooks = settings.hooks || {};
  let changed = false;
  for (const def of HOOK_DEFS) {
    const arr = settings.hooks[def.event] = settings.hooks[def.event] || [];
    if (arr.some(e => entryIsOurs(e, def.script))) {
      console.log(`kept    existing ${def.event} hook`);
      continue;
    }
    const entry = {
      hooks: [{
        type: 'command',
        command: 'node',
        args: [path.join(target, 'scripts', def.script)],
        timeout: 10,
        statusMessage: def.status
      }]
    };
    if (def.matcher) entry.matcher = def.matcher;
    arr.push(entry);
    changed = true;
    console.log(`added   ${def.event}${def.matcher ? `(${def.matcher})` : ''} hook -> ${def.script}`);
  }
  if (changed) {
    const bak = backupSettings();
    if (bak) console.log(`backup  ${bak}`);
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`wrote   ${settingsPath}`);
  }

  // 4. the install proves itself
  let st = { status: 0 };
  if (skipSelftest) {
    console.log('verify  skipped (--no-selftest)');
  } else {
    st = spawnSync(process.execPath, [path.join(target, 'scripts', 'selftest.js')], { encoding: 'utf8' });
    const lines = (st.stdout || '').trim().split('\n');
    console.log(st.status === 0 ? `verify  ${lines[lines.length - 1]}` : `verify  FAILED\n${st.stdout}${st.stderr}`);
  }

  // 5. the user must leave knowing what still needs their hands: hooks only
  // load on restart, other harnesses wire manually, defaults are observe-only.
  console.log(`
──── next steps ────────────────────────────────────────────────
 1. Restart Claude Code (or open /hooks once) - hooks load then.
 2. Prove it is alive: use any skill, then check that one line was
    appended to ${path.join(target, 'data', 'pending.jsonl')}
 3. Use other agents too? Each wires in about a minute, and all of
    them feed the same ledger:
      Codex   ${path.join(target, 'adapters', 'codex', 'README.md')}
      Cursor  ${path.join(target, 'adapters', 'cursor', 'README.md')}
      pi      ${path.join(target, 'adapters', 'pi', 'README.md')}
    Another harness entirely: paste the Self-service prompt from
    ${path.join(target, 'protocol', 'adapter-contract.md')}
    to that harness's agent - it writes the adapter, the bundled
    verifier (scripts/verify-adapter.js) checks it, and after three
    red runs it falls back to adapters/generic/.
 4. Check progress any time, no agent needed - every number comes
    from the ledger, reproducibly:
      node ${path.join(target, 'scripts', 'report.js')} --since 30d
    (add --json to archive it as evidence)
 Defaults until you touch config.json: evaluation batches at 5
 calls, updates (proposals, background edits, reminders) batch into
 one WEEKLY window, every skill is observe-only (evidence accumulates,
 nothing is ever edited). Whitelist per skill later: /lamarck evolve add
────────────────────────────────────────────────────────────────`);
  process.exit(st.status === 0 ? 0 : 1);
}

function uninstall() {
  if (!fs.existsSync(settingsPath)) { console.log('no settings.json - nothing to unwire'); return; }
  const settings = loadSettings();
  let removed = 0;
  for (const def of HOOK_DEFS) {
    const arr = (settings.hooks && settings.hooks[def.event]) || [];
    const kept = arr.filter(e => !entryIsOurs(e, def.script));
    removed += arr.length - kept.length;
    if (settings.hooks) settings.hooks[def.event] = kept;
  }
  if (removed) {
    const bak = backupSettings();
    if (bak) console.log(`backup  ${bak}`);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  console.log(`removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'} from settings.json`);
  console.log(`kept    ${target} (telemetry included) - delete manually if you want it gone.`);
}

try {
  if (cmd === 'uninstall') uninstall();
  else if (cmd === 'install') install();
  else { console.error(`unknown command: ${cmd} (use install | uninstall)`); process.exit(2); }
} catch (e) {
  console.error(`lamarck installer failed: ${e.message}`);
  process.exit(1);
}
