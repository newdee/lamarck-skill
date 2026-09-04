#!/usr/bin/env node
// lamarck background evolver - evolution happens OUTSIDE the user's session.
//
//   node scripts/evolve-worker.js enqueue --skill <name> --proposal <file> --auth user|auto [--no-spawn]
//   node scripts/evolve-worker.js enqueue --ping [--no-spawn]        # pipeline smoke test
//   node scripts/evolve-worker.js run                                # drain the queue (spawned detached by enqueue)
//   node scripts/evolve-worker.js status [--ack]                     # queue + unread results
//
// The session that reaches an approved (or auto-tier) proposal does NOT
// apply it. It enqueues a job and returns to the user's work. This worker,
// spawned detached, hands the job to the harness's headless CLI (claude -p,
// codex exec, pi -p - templates in config.json `background.runners`, least
// privilege: the lamarck directory and the skills directory only). That
// headless agent applies the edit under SKILL.md's gate rules, runs replay
// validation, ledgers the verify record, and appends one paragraph to
// data/inbox.md. The worker then sends an OS notification. The next
// `/lamarck` (or `status --ack`) surfaces unread results. Iron Rules hold:
// the user's decision (or an explicitly granted auto tier) precedes every
// job; nothing edits without it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const jobsPath = path.join(dataDir, 'jobs.jsonl');
const inboxPath = path.join(dataDir, 'inbox.md');
const lockPath = path.join(dataDir, '.worker.lock');
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';

const readJobs = () => {
  if (!fs.existsSync(jobsPath)) return [];
  const out = [];
  for (const l of fs.readFileSync(jobsPath, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* tolerate */ }
  }
  return out;
};
const writeJobs = (jobs) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(jobsPath, jobs.map(j => JSON.stringify(j)).join('\n') + (jobs.length ? '\n' : ''), 'utf8'); };
const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch { return {}; } };
// A template without {prompt} receives the brief on stdin (claude -p reads
// it there) - the safest cross-platform channel. Templates with {prompt}
// get it as an argument, quoted for the shell on Windows.
const DEFAULT_RUNNERS = {
  claude: ['claude', '-p', '--add-dir', '{root}', '--add-dir', '{skills}', '--allowedTools',
    'Read', 'Write', 'Edit', 'Agent', 'Bash(git:*)', 'Bash(node:*)', 'PowerShell(git:*)', 'PowerShell(node:*)'],
  codex: ['codex', 'exec', '-C', '{root}', '-s', 'workspace-write', '{prompt}'],
  pi: ['pi', '-p', '{prompt}']
};
const onPath = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
const resolveRunner = (cfg) => {
  const bg = (cfg && cfg.background) || {};
  const runners = Object.assign({}, DEFAULT_RUNNERS, bg.runners || {});
  let name = process.env.LAMARCK_RUNNER || bg.runner || 'auto';
  if (name === 'none') return null;
  if (name === 'auto') name = ['claude', 'codex', 'pi'].find(n => onPath(n)) || null;
  if (!name || !runners[name]) return null;
  return { name, template: runners[name] };
};
const notify = (text) => {
  if (process.env.LAMARCK_NO_NOTIFY) return;
  try {
    if (process.platform === 'win32') spawnSync('msg', ['*', '/TIME:30', text], { stdio: 'ignore', timeout: 5000 });
    else if (process.platform === 'darwin') spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "lamarck"`], { stdio: 'ignore', timeout: 5000 });
    else spawnSync('notify-send', ['lamarck', text], { stdio: 'ignore', timeout: 5000 });
  } catch { /* notification is best-effort */ }
};
const inbox = (line) => { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(inboxPath, line.replace(/\r?\n/g, ' ') + '\n', 'utf8'); };

function brief(job) {
  const skillsDir = path.resolve(root, '..');
  if (job.kind === 'ping') {
    return `lamarck pipeline check, no investigation needed. Append exactly this one line to the file ${inboxPath} (create it if missing): - [${job.id}] ping ok   Then stop. Output nothing else.`;
  }
  const auth = job.auth === 'auto'
    ? 'the auto tier (verify in config.json that the skill is listed under evolution.auto and that data/replays/<skill>.jsonl is non-empty; if either fails, abort and say so)'
    : `the user, who approved this proposal at ${job.ts}`;
  return `You are lamarck's background evolver. Working directory: ${root} (the skills directory is ${skillsDir}); never touch anything outside these two. ` +
    `Read ${path.join(root, 'SKILL.md')} - the optimization gate, bounded-edit rules, replay validation, rollback semantics and Iron Rules bind you. ` +
    `Job ${job.id}: skill '${job.skill}', proposal file ${job.proposal}, authorized by ${auth}. ` +
    `Apply the proposal exactly as written (git commit before and after, or SKILL.md.bak when the skill is not in a git repo; at most 3 edits of at most 10 lines each; never rewrite the file). ` +
    `Then run replay validation from ${path.join(root, 'data', 'replays')} for that skill, old version against new, and write the verify record to ${path.join(root, 'data', 'ledger.jsonl')}; if the new version is worse, revert and record the reason in ${path.join(root, 'data', 'rejected.md')}. ` +
    `Append one line to ${path.join(root, 'CHANGELOG.md')}. ` +
    `Finish by appending ONE line to ${inboxPath} that starts with '- [${job.id}] ' and states: skill, old and new ver, replay result, decision (kept or reverted), and anything the user must look at. Output nothing else.`;
}

function runJob(job, runner) {
  const skillsDir = path.resolve(root, '..');
  const prompt = brief(job);
  const viaStdin = !runner.template.includes('{prompt}');
  const win = process.platform === 'win32';
  // On Windows the .cmd shims force shell:true, and the shell splits on
  // whitespace - so every argument that contains any is quoted explicitly.
  const q = (a) => (win && /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const args = runner.template.slice(1)
    .map(a => a.replace('{prompt}', prompt).replace('{root}', root).replace('{skills}', skillsDir))
    .map(q);
  const r = spawnSync(runner.template[0], args, {
    encoding: 'utf8', cwd: root, timeout: 30 * 60 * 1000,
    input: viaStdin ? prompt : undefined,
    shell: win, windowsHide: true
  });
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().slice(-400);
  return { ok: r.status === 0, status: r.status, tail };
}
// The exit code says the runner ran; only the inbox says the agent did the
// job. A ping must literally report "ping ok"; an evolve job must have
// written its own "- [id] " line.
const verified = (job) => {
  const text = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
  const line = text.split('\n').find(l => l.includes(`[${job.id}]`));
  if (!line) return false;
  return job.kind === 'ping' ? /ping ok/i.test(line) : true;
};

function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) { console.log('worker already running'); return 0; }
  } catch { /* no lock */ }
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  try {
    const cfg = readConfig();
    const runner = resolveRunner(cfg);
    let jobs = readJobs();
    for (const job of jobs.filter(j => j.status === 'queued')) {
      job.started = nowIso();
      if (!runner) {
        job.status = 'failed'; job.result = 'no headless runner available (config background.runner / PATH)';
        inbox(`- [${job.id}] FAILED: ${job.result}`);
      } else {
        job.runner = runner.name;
        const res = runJob(job, runner);
        if (!res.ok) { job.status = 'failed'; job.result = `runner exited ${res.status}: ${res.tail}`; }
        else if (verified(job)) { job.status = 'done'; job.result = 'runner exited 0, inbox line verified'; }
        else { job.status = 'unverified'; job.result = 'runner exited 0 but wrote no inbox line for this job - treat as not done'; }
        const inboxNow = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
        if (!inboxNow.includes(`[${job.id}]`)) inbox(`- [${job.id}] ${job.status.toUpperCase()}: ${job.result}`);
      }
      job.finished = nowIso();
      job.seen = false;
      writeJobs(jobs);
      notify(`lamarck: job ${job.id} ${job.status} (${job.kind === 'ping' ? 'ping' : job.skill}) - see data/inbox.md`);
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
  return 0;
}

function enqueue() {
  const ping = has('--ping');
  const skill = opt('--skill');
  const proposal = opt('--proposal');
  const auth = opt('--auth');
  if (!ping && (!skill || !proposal || !['user', 'auto'].includes(auth || ''))) {
    console.error('usage: enqueue --skill <name> --proposal <file> --auth user|auto   |   enqueue --ping');
    return 2;
  }
  if (!ping && !fs.existsSync(path.resolve(root, proposal))) { console.error(`proposal file not found: ${proposal}`); return 2; }
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: nowIso(), kind: ping ? 'ping' : 'evolve',
    skill: ping ? '' : skill, proposal: ping ? '' : path.resolve(root, proposal), auth: ping ? 'user' : auth,
    status: 'queued', seen: false
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(jobsPath, JSON.stringify(job) + '\n', 'utf8');
  if (!has('--no-spawn')) {
    const child = spawn(process.execPath, [__filename, 'run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  console.log(`queued ${job.id}${has('--no-spawn') ? '' : ' (worker spawned in the background)'}`);
  return 0;
}

function status() {
  const jobs = readJobs();
  const queued = jobs.filter(j => j.status === 'queued').length;
  const unread = jobs.filter(j => j.status !== 'queued' && j.seen === false);
  console.log(`jobs: ${jobs.length} total, ${queued} queued, ${unread.length} unread result(s)`);
  const inboxText = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8').split('\n') : [];
  for (const j of unread) {
    const line = inboxText.find(l => l.includes(`[${j.id}]`));
    console.log(line || `- [${j.id}] ${j.status}: ${j.result || ''}`);
  }
  if (has('--ack') && unread.length) { for (const j of unread) j.seen = true; writeJobs(jobs); console.log(`acknowledged ${unread.length}`); }
  return 0;
}

try {
  const code = cmd === 'run' ? run() : cmd === 'enqueue' ? enqueue() : cmd === 'status' ? status() : (console.error(`unknown command: ${cmd}`), 2);
  process.exit(code);
} catch (e) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, 'hook-errors.log'), `${new Date().toISOString()} evolve-worker: ${e && e.message}\n`, 'utf8'); } catch { /* ignore */ }
  process.exit(1);
}
