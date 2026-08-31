#!/usr/bin/env node
// lamarck installer: npx github:newdee/lamarck-skill  (or: npx lamarck-skill)
// Copies the skill into ~/.claude/skills/lamarck, initializes local config,
// wires the two hooks into ~/.claude/settings.json (backup first, idempotent,
// add-only), then runs the selftest so the install proves itself.
// Commands: install (default) | uninstall.  Flag: --home <dir> (for testing).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) || 'install';
const homeIdx = argv.indexOf('--home');
const home = homeIdx >= 0 ? argv[homeIdx + 1] : os.homedir();

const claudeDir = path.join(home, '.claude');
const target = path.join(claudeDir, 'skills', 'lamarck');
const settingsPath = path.join(claudeDir, 'settings.json');
const src = path.resolve(__dirname, '..');

const CORE = [
  'SKILL.md', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE',
  'config.example.json', 'gitignore.template',
  'scripts/posttool-skill.js', 'scripts/stop-evaluate.js', 'scripts/selftest.js', 'scripts/verify-adapter.js',
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

function install() {
  // 0. upgrade safety: if the target is already a git repo (it is, since
  // v5.4.1 installs git-init), snapshot local state BEFORE overwriting -
  // locally-evolved skill files must never be destroyed by an upgrade.
  const isUpgrade = fs.existsSync(path.join(target, '.git'));
  if (isUpgrade) {
    spawnSync('git', ['-C', target, 'add', '-A']);
    const snap = spawnSync('git', ['-C', target,
      '-c', 'user.name=lamarck-install', '-c', 'user.email=lamarck@localhost',
      'commit', '-m', 'pre-upgrade snapshot']);
    if (snap.status === 0) console.log('git     pre-upgrade snapshot committed');
  }

  // 1. copy core files (upgrades overwrite code; data/ and config.json are never touched)
  for (const rel of CORE) {
    const to = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, ...rel.split('/')), to);
  }
  console.log(`copied  ${CORE.length} files -> ${target}`);

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
      'commit', '-m', 'lamarck upgrade']);
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
  const st = spawnSync(process.execPath, [path.join(target, 'scripts', 'selftest.js')], { encoding: 'utf8' });
  const lines = (st.stdout || '').trim().split('\n');
  console.log(st.status === 0 ? `verify  ${lines[lines.length - 1]}` : `verify  FAILED\n${st.stdout}${st.stderr}`);

  console.log('\nnext: restart Claude Code (or open /hooks once) so the hooks load.');
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
