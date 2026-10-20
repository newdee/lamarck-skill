#!/usr/bin/env node
// lamarck store - the one write path for headless agents.
//
//   node scripts/store.js append <rel-path> [--line <text>]    # one line, from --line or stdin
//   node scripts/store.js write <rel-path>                      # whole file, content from stdin
//   node scripts/store.js edit <rel-path>                       # bounded edit, JSON on stdin:
//                                                               #   {"edits":[{"old":"...","new":"..."}]}
//   node scripts/store.js pending-drop --session <id>           # drop that session's pending lines
//
// Why this exists: Claude Code treats every file under ~/.claude as
// sensitive and refuses the Write/Edit tools there in headless (-p) mode,
// whatever allow rules say; shell commands are not refused. A background
// evaluator or evolver therefore writes through this script. Two things
// the protocol only asks the model for become mechanical here:
//   - the fence: paths must lie inside the lamarck directory or its parent
//     skills directory (symlinks resolved), never in lamarck's code
//     (scripts/, adapters/, bin/), its config, .git, .upstream,
//     node_modules or the worker's own state; pending.jsonl changes only
//     through pending-drop;
//   - the bound: an edit is at most 3 replacements, each old/new text at
//     most 10 lines, each old text occurring exactly once; a whole-file
//     write may create a file or replace maturity.json, cadence.json, a
//     rubric or a suggestion - never a genome, ledger or learnings file.
// pending-drop re-reads the file immediately before writing, so entries
// appended by concurrent sessions survive.
// This guards the trusted headless agent against its own mistakes. It is
// not a sandbox against a hostile model: the runner template already lets
// that agent run node and git.
// Exit 0 on success (prints one `ok` line), 2 on refusal (prints why).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skillsDir = path.resolve(root, '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const MAX_EDITS = 3;
const MAX_LINES = 10;
// Inside lamarck: code, config and git follow upstream or the user; the
// worker's own state is the worker's. Compared case-insensitively - NTFS
// and APFS are.
const DENY = ['scripts', 'adapters', 'bin', '.git', '.upstream', 'node_modules', 'config.json'];
const DENY_STATE = ['data/jobs.jsonl', 'data/.jobs.lock', 'data/.worker.lock', 'data/.no-runner', 'data/worker-logs', 'data/hook-errors.log'];
// pending.jsonl changes only through pending-drop (which re-reads first).
const PENDING = 'data/pending.jsonl';
// Whole-file writes are for state that is rewritten by design; a genome
// file, a ledger or a learnings file is never rewritten - append or edit.
const OVERWRITE_OK = /^(data\/maturity\.json|data\/cadence\.json|data\/rubrics\/(?!readme\.md$)[^/]+\.md|suggestions\/[^/]+\.md)$/;

const usage = () => {
  console.error('usage: store.js append <rel> [--line <text>] | write <rel> | edit <rel> | pending-drop --session <id>');
  return 2;
};
const refuse = (why) => { console.error(`refused: ${why}`); return 2; };
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const lines = (s) => s.split('\n').length;

// A target is legal when it lies inside the skills directory (lamarck's
// parent) and does not touch lamarck's code, state or config.
const outside = (relPath) => !relPath || relPath === '..' || relPath.startsWith('..' + path.sep) || relPath.startsWith('../') || path.isAbsolute(relPath);
// Symlinks: the deepest existing ancestor is resolved to its real path and
// the fence is judged on that, so a link inside the skills directory cannot
// point a write outside it.
function realAbs(abs) {
  let probe = abs;
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  try { return path.join(fs.realpathSync.native(probe), ...tail); } catch { return abs; }
}
function resolveTarget(rel) {
  if (!rel) return { err: 'missing path' };
  const abs = realAbs(path.resolve(root, rel));
  const realRoot = realAbs(root);
  const realSkills = realAbs(skillsDir);
  const relToSkills = path.relative(realSkills, abs);
  if (outside(relToSkills)) return { err: `outside the skills directory: ${abs}` };
  const segs = relToSkills.split(/[\\/]/);
  // Windows name tricks (trailing dot or space, 8.3 short names, alternate
  // data streams) are refused outright rather than normalized.
  if (segs.some(s => /[:]|[. ]$/.test(s) || /~\d/.test(s))) return { err: `illegal path segment in ${relToSkills}` };
  if (segs.some(s => s.toLowerCase() === '.git')) return { err: '.git is not writable' };
  const relToRoot = path.relative(realRoot, abs);
  const inRoot = !outside(relToRoot);
  const relNorm = (inRoot ? relToRoot : relToSkills).replace(/\\/g, '/');
  const first = relNorm.split('/')[0].toLowerCase();
  if (inRoot && DENY.includes(first)) return { err: `${first} is code or state that follows upstream - not writable by an agent` };
  const lower = relNorm.toLowerCase();
  if (inRoot && DENY_STATE.some(d => lower === d || lower.startsWith(d + '/'))) return { err: `${relNorm} is the worker's own state - not writable by an agent` };
  return { abs, rel: inRoot ? relNorm : '../' + relNorm, inRoot, key: inRoot ? lower : '' };
}

function append() {
  const t = resolveTarget(argv[1]);
  if (t.err) return refuse(t.err);
  if (t.key === PENDING) return refuse('pending.jsonl changes only through pending-drop');
  let line = opt('--line');
  if (line === undefined) line = readStdin();
  line = line.replace(/\r?\n$/, '');
  if (!line.trim()) return refuse('empty line');
  if (lines(line) > MAX_LINES) return refuse(`a line is at most ${MAX_LINES} lines (got ${lines(line)})`);
  fs.mkdirSync(path.dirname(t.abs), { recursive: true });
  const existing = fs.existsSync(t.abs) ? fs.readFileSync(t.abs, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(t.abs, sep + line + '\n', 'utf8');
  console.log(`ok append ${t.rel} (${lines(line)} line${lines(line) === 1 ? '' : 's'})`);
  return 0;
}

function write() {
  const t = resolveTarget(argv[1]);
  if (t.err) return refuse(t.err);
  if (t.key === PENDING) return refuse('pending.jsonl changes only through pending-drop');
  if (fs.existsSync(t.abs) && !(t.inRoot && OVERWRITE_OK.test(t.key))) return refuse(`${t.rel} exists - a genome, ledger or learnings file is never rewritten; use append or edit`);
  const content = readStdin();
  if (!content.length) return refuse('empty content on stdin');
  fs.mkdirSync(path.dirname(t.abs), { recursive: true });
  fs.writeFileSync(t.abs, content, 'utf8');
  console.log(`ok write ${t.rel} (${content.length} bytes)`);
  return 0;
}

function edit() {
  const t = resolveTarget(argv[1]);
  if (t.err) return refuse(t.err);
  if (t.key === PENDING) return refuse('pending.jsonl changes only through pending-drop');
  if (!fs.existsSync(t.abs)) return refuse(`no such file: ${t.rel}`);
  let spec;
  try { spec = JSON.parse(readStdin()); } catch { return refuse('stdin is not JSON {"edits":[{"old","new"}]}'); }
  const edits = spec && Array.isArray(spec.edits) ? spec.edits : null;
  if (!edits || !edits.length) return refuse('no edits');
  if (edits.length > MAX_EDITS) return refuse(`at most ${MAX_EDITS} edits per call (got ${edits.length})`);
  let text = fs.readFileSync(t.abs, 'utf8');
  const crlf = /\r\n/.test(text);
  let work = crlf ? text.replace(/\r\n/g, '\n') : text;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    if (typeof e.old !== 'string' || typeof e.new !== 'string' || !e.old.length) return refuse(`edit ${i + 1}: old and new must be strings, old non-empty`);
    if (lines(e.old) > MAX_LINES || lines(e.new) > MAX_LINES) return refuse(`edit ${i + 1}: old/new are at most ${MAX_LINES} lines each`);
    const oldN = e.old.replace(/\r\n/g, '\n');
    const n = work.split(oldN).length - 1;
    if (n !== 1) return refuse(`edit ${i + 1}: old text occurs ${n} times, must be exactly once`);
    work = work.replace(oldN, () => e.new.replace(/\r\n/g, '\n'));
  }
  text = crlf ? work.replace(/\n/g, '\r\n') : work;
  fs.writeFileSync(t.abs, text, 'utf8');
  console.log(`ok edit ${t.rel} (${edits.length} replacement${edits.length === 1 ? '' : 's'})`);
  return 0;
}

function pendingDrop() {
  const sid = opt('--session');
  if (!sid) return usage();
  const file = path.join(root, 'data', 'pending.jsonl');
  if (!fs.existsSync(file)) { console.log('ok pending-drop data/pending.jsonl (0 dropped, no file)'); return 0; }
  // Re-read immediately before writing: concurrent sessions append.
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const keep = all.filter(l => { try { return JSON.parse(l).session !== sid; } catch { return true; } });
  fs.writeFileSync(file, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
  console.log(`ok pending-drop data/pending.jsonl (${all.length - keep.length} dropped, ${keep.length} kept)`);
  return 0;
}

let code;
try {
  code = cmd === 'append' ? append() : cmd === 'write' ? write() : cmd === 'edit' ? edit() : cmd === 'pending-drop' ? pendingDrop() : usage();
} catch (e) {
  console.error(`error: ${(e && e.message) || e}`);
  code = 1;
}
process.exit(code);
