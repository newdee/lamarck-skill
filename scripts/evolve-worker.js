#!/usr/bin/env node
// lamarck background evolver - evolution happens OUTSIDE the user's session.
//
//   node scripts/evolve-worker.js enqueue --skill <name> --proposal <file> --auth user|auto [--no-spawn]
//   node scripts/evolve-worker.js enqueue --ping [--no-spawn]        # pipeline smoke test
//   node scripts/evolve-worker.js enqueue --upgrade --from <v> --to <v> --notes <file> --files <a,b>   # installer: integrate an upstream release into a locally evolved genome
//   node scripts/evolve-worker.js run                                # drain the queue (spawned detached by enqueue / the stop hook)
//   node scripts/evolve-worker.js status [--ack]                     # queue + unread results
//
// Job kinds: `evaluate` (the light loop itself, queued by the stop hook when
// isolation=background - the session never sees the evaluation), `evolve`
// (an approved or auto-tier proposal), `upgrade` (semantic integration of
// an upstream release), `ping` (pipeline smoke test).
//
// The session that reaches an approved (or auto-tier) proposal does NOT
// apply it. It enqueues a job and returns to the user's work. This worker,
// spawned detached, hands the job to the harness's headless CLI (claude -p,
// codex exec, pi -p - templates in config.json `background.runners`, least
// privilege: the lamarck directory and the skills directory only). That
// headless agent applies the edit under SKILL.md's gate rules, runs replay
// validation, ledgers the verify record, and appends one paragraph to
// data/inbox.md. The worker then sends an OS notification (for evaluate
// jobs only when the agent reported something that needs the user). The
// next `/lamarck` (or `status --ack`) surfaces unread results. Iron Rules
// hold: the user's decision (or an explicitly granted auto tier) precedes
// every edit; a headless evaluation can only write proposals.
// No headless CLI on PATH: jobs fail with a clear inbox line and the worker
// leaves data/.no-runner, which makes the stop hook evaluate inline until
// a later run finds a runner and clears the flag.
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
const noRunnerPath = path.join(dataDir, '.no-runner');
const logsDir = path.join(dataDir, 'worker-logs');
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
// Every mutation of jobs.jsonl (the stop hook's append, this worker's
// read-modify-write, status --ack) runs under one short mutex, so a
// rewrite can never drop a line appended between its read and its write.
// wx-open is atomic; a holder older than 10 s is dead and is removed.
const jobsLockPath = path.join(dataDir, '.jobs.lock');
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: busy-wait */ const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } } };
function withJobsLock(fn) {
  fs.mkdirSync(dataDir, { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.writeFileSync(jobsLockPath, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(jobsLockPath).mtimeMs > 10000) fs.unlinkSync(jobsLockPath); } catch { /* gone */ }
      if (Date.now() > deadline) throw new Error('jobs.jsonl mutex held for more than 5 s');
      sleepMs(25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(jobsLockPath); } catch { /* gone */ } }
}
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
// The worker lock: wx-open is the atomic test-and-set. A holder whose pid
// is dead, or whose heartbeat (the file's mtime, touched every pass) is
// older than LOCK_STALE_MS, is taken over.
function acquireWorkerLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS || !pidAlive(pid);
      } catch { stale = true; }
      if (!stale) return false;
      try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    }
  }
  return false;
}
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
  const store = path.join(root, 'scripts', 'store.js');
  // Claude Code refuses its Write/Edit tools under ~/.claude in headless
  // mode (sensitive-file protection, not lifted by allow rules); shell
  // commands are not refused. store.js is therefore the only write path
  // in every brief, and it enforces the edit bound and the code fence.
  const WRITES = `WRITES: file-editing tools are refused under the user's agent directory in headless mode, so write ONLY by running node ${store} - ` +
    `'append <rel> --line <text>' (one line; text may also come on stdin), 'write <rel>' (whole file on stdin), 'edit <rel>' (stdin JSON {"edits":[{"old":"...","new":"..."}]}; at most 3 replacements of at most 10 lines each, old text must occur exactly once), 'pending-drop --session <id>' (removes that session's pending lines, re-reading first). ` +
    `Relative paths resolve against ${root}; another skill is ../<skill>/SKILL.md. It refuses scripts/, adapters/, bin/, config.json, .git and the worker's own state (jobs, locks, logs); pending.jsonl changes only through pending-drop; 'write' overwrites only maturity.json, cadence.json, rubrics and suggestions - everything else is append or edit. Reading is unrestricted. `;
  if (job.kind === 'ping') {
    return `lamarck pipeline check, no investigation needed. Append exactly this one line to the file ${inboxPath} (create it if missing): - [${job.id}] ping ok   ` +
      `Do it by running: node ${store} append data/inbox.md --line "- [${job.id}] ping ok"   (file-editing tools are refused there in headless mode). Then stop. Output nothing else.`;
  }
  if (job.kind === 'evaluate') {
    // The light loop, run backstage. Same brief the subagent isolation mode
    // hands its delegate: protocol from disk, evidence from the on-disk
    // transcript, objective signals as counted by the hook. Headless means
    // non-interactive: the protocol's own clause routes every gate-passing
    // proposal to suggestions/ instead of asking; the auto tier is the one
    // exception and goes through this same worker as an evolve job.
    const entries = (job.entries || []).map(e => `${e.skill}@${e.ts}`).join(', ');
    const transcripts = [...new Set((job.entries || []).map(e => e.transcript).filter(Boolean))].join(' | ') || '(no transcript)';
    const objective = (job.objective || []).join('; ') || '(none)';
    return `You are the lamarck evaluator for session ${job.session}, running in the background (the user is not present; output nothing to them). Working directory: ${root} (the skills directory is ${skillsDir}); never touch anything outside these two except reading the transcript files named below. ` +
      WRITES +
      `Read ${path.join(root, 'protocol', 'light-loop.md')} and execute it for the pending entries of session ${job.session}: ${entries} (the protocol's final pending rewrite is 'pending-drop --session ${job.session}'). ` +
      `In-context evidence means the transcript slice around each activation in ${transcripts} - locate by ts and skill name, read only that slice; an entry with no transcript, or whose transcript is gone, is archived per the protocol. ` +
      `Objective signals, counted by code from the transcript (copy each verbatim into that ledger line's objective field; never estimate them): ${objective}. ` +
      `Cadence: ${job.window_open ? `the update window is open (cadence=${job.cadence}) - if the gate opens, run SKILL.md's optimization gate and stamp data/cadence.json` : `updates are batched (cadence=${job.cadence}), next window ${job.next_window} - log only, do not escalate`}. ` +
      `This is a non-interactive run: you cannot ask the user. A proposal that passes the gate goes to suggestions/<skill>.md; only for a skill listed under evolution.auto in config.json (with a non-empty data/replays/<skill>.jsonl) run: node ${path.join(root, 'scripts', 'evolve-worker.js')} enqueue --skill <skill> --proposal suggestions/<skill>.md --auth auto --no-spawn - this worker picks it up after you finish. ` +
      `${job.backlog ? `${job.backlog} pending entries from other sessions are also on file; leave them, '/lamarck' drains that backlog. ` : ''}` +
      `Finish by appending ONE line to ${inboxPath} that starts with '- [${job.id}] ' and continues 'evaluated N, gaps M, user: yes|no - ' followed by a one-sentence summary; 'user: yes' only when a proposal was written, a correction was crystallized, or something failed. Output nothing else.`;
  }
  if (job.kind === 'upgrade') {
    // Semantic integration of an upstream release into a locally evolved
    // lamarck. The installer already did the mechanical three-way merge;
    // this pass checks that the result still makes sense and re-applies
    // local intent that lost a conflict - through the gate, never by hand.
    return `You are lamarck's background evolver, integrating an upstream upgrade. Working directory: ${root} (the skills directory is ${skillsDir}); never touch anything outside these two. ` +
      WRITES +
      `Read ${path.join(root, 'SKILL.md')} - the optimization gate, bounded-edit rules, replay validation, rollback semantics and Iron Rules bind you. ` +
      `Job ${job.id}: lamarck was upgraded ${job.from} -> ${job.to} by the user running the installer (that is the authorization). ` +
      `Upstream's own account of what changed and why is in ${job.notes}. The installer merged upstream into the locally evolved genome mechanically; the files where local evolution existed are: ${job.files}. ` +
      `Where a conflict occurred, upstream won that hunk and the full local version is saved under ${path.join(root, 'data', 'upgrade-conflicts', job.to)}. ` +
      `Your task: (1) read the notes and the current genome files and judge semantic coherence - a local rule may now contradict or duplicate a new upstream rule even though no lines overlapped; (2) for each saved local version, decide whether its intent is still valid against the new base and, if so, re-apply it as a bounded gate edit (at most 3 edits of at most 10 lines each, git commit before and after, replay validation, verify record to ${path.join(root, 'data', 'ledger.jsonl')}); drop what upstream has made redundant and say so; (3) never change scripts/ or adapters/ - code follows upstream. ` +
      `Append one line to ${path.join(root, 'CHANGELOG.md')}. ` +
      `Finish by appending ONE line to ${inboxPath} that starts with '- [${job.id}] ' and states: files reviewed, local intents re-applied / dropped / needing the user, replay results. Output nothing else.`;
  }
  const auth = job.auth === 'auto'
    ? 'the auto tier (verify in config.json that the skill is listed under evolution.auto and that data/replays/<skill>.jsonl is non-empty; if either fails, abort and say so)'
    : `the user, who approved this proposal at ${job.ts}`;
  return `You are lamarck's background evolver. Working directory: ${root} (the skills directory is ${skillsDir}); never touch anything outside these two. ` +
    WRITES +
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
  // On Windows the .cmd shims force shell:true and cmd.exe has no reliable
  // escape for quotes inside an argument - and a brief carries JSON. So on
  // Windows a {prompt} template receives a one-line pointer to the brief
  // saved on disk; the brief itself never crosses the shell.
  let promptArg = prompt;
  if (win && !viaStdin) {
    fs.mkdirSync(logsDir, { recursive: true });
    const briefPath = path.join(logsDir, `${job.id}.brief.md`);
    fs.writeFileSync(briefPath, prompt, 'utf8');
    promptArg = `Read the file ${briefPath} and follow it as your complete brief.`;
  }
  const q = (a) => (win && /\s/.test(a) ? `"${a}"` : a);
  const args = runner.template.slice(1)
    .map(a => a.replace('{prompt}', promptArg).replace('{root}', root).replace('{skills}', skillsDir))
    .map(q);
  const r = spawnSync(runner.template[0], args, {
    encoding: 'utf8', cwd: root, timeout: 30 * 60 * 1000,
    input: viaStdin ? prompt : undefined,
    // LAMARCK_HEADLESS lets enqueue refuse user-level authorization that
    // only a user can give.
    env: Object.assign({}, process.env, { LAMARCK_HEADLESS: '1' }),
    shell: win, windowsHide: true
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  // The runner's full output is kept per job: an agent that exits 0 but
  // did nothing is otherwise impossible to diagnose.
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${job.id}.log`), `${runner.template[0]} ${args.join(' ')}\n--- brief ---\n${prompt}\n--- output (exit ${r.status}) ---\n${out}\n`, 'utf8');
  } catch { /* diagnostics are best-effort */ }
  return { ok: r.status === 0, status: r.status, tail: out.slice(-400) };
}
// The exit code says the runner ran; only the inbox says the agent did the
// job. A ping must literally report "ping ok"; an evolve job must have
// written its own "- [id] " line.
const inboxLine = (job) => {
  const text = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
  return text.split('\n').find(l => l.includes(`[${job.id}]`)) || '';
};
// Verdict from the agent's own line: none -> unverified; a line that
// says FAILED -> failed (the agent reporting a failure is not success);
// a ping must say "ping ok"; anything else -> done.
const verdict = (job) => {
  const line = inboxLine(job);
  if (!line) return { status: 'unverified', result: 'runner exited 0 but wrote no inbox line for this job - treat as not done' };
  if (/\]\s*FAILED\b/i.test(line)) return { status: 'failed', result: 'the agent reported failure in its inbox line' };
  if (job.kind === 'ping' && !/ping ok/i.test(line)) return { status: 'unverified', result: 'ping line present but does not say "ping ok"' };
  return { status: 'done', result: 'runner exited 0, inbox line verified' };
};
// An evaluate job asks for attention only when its own line says so.
const needsUser = (job) => /user:\s*yes/i.test(inboxLine(job));

function run() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!acquireWorkerLock()) { console.log('worker already running'); return 0; }
  const MAX_PASSES = 50;
  let exhausted = false;
  try {
    const cfg = readConfig();
    const runner = resolveRunner(cfg);
    if (runner) { try { fs.unlinkSync(noRunnerPath); } catch { /* was not set */ } }
    else fs.writeFileSync(noRunnerPath, `${nowIso()} no headless runner available (config background.runner / PATH)\n`, 'utf8');
    // Drain until the queue is empty: a job may enqueue another (an evaluate
    // job that opens the auto tier), and stop hooks keep appending while a
    // run is in progress. Bounded so a job that re-queues itself cannot
    // spin forever.
    for (let pass = 0; ; pass++) {
      if (pass >= MAX_PASSES) { exhausted = true; break; }
      // Heartbeat: a live worker's lock is never stale.
      try { const t = new Date(); fs.utimesSync(lockPath, t, t); } catch { /* lock removed underneath us - keep going */ }
      const jobs = readJobs();
      const next = jobs.find(j => j.status === 'queued');
      if (!next) break;
      const job = next;
      job.started = nowIso();
      if (!runner) {
        job.status = 'failed'; job.result = 'no headless runner available (config background.runner / PATH)';
        inbox(`- [${job.id}] FAILED: ${job.result}`);
      } else {
        job.runner = runner.name;
        const res = runJob(job, runner);
        if (!res.ok) { job.status = 'failed'; job.result = `runner exited ${res.status}: ${res.tail}`; }
        else { const v = verdict(job); job.status = v.status; job.result = v.result; }
        const inboxNow = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
        if (!inboxNow.includes(`[${job.id}]`)) inbox(`- [${job.id}] ${job.status.toUpperCase()}: ${job.result}`);
      }
      job.finished = nowIso();
      // A routine evaluation that found nothing for the user is read by
      // default: it only appears in status when it asks for attention.
      job.seen = job.kind === 'evaluate' && job.status === 'done' && !needsUser(job);
      // Read-modify-write under the queue mutex: the queue may have grown
      // during the run and nothing appended meanwhile may be lost.
      withJobsLock(() => {
        const now = readJobs();
        const i = now.findIndex(j => j.id === job.id);
        if (i >= 0) now[i] = job; else now.push(job);
        writeJobs(now);
      });
      if (!job.seen) notify(`lamarck: job ${job.id} ${job.status} (${job.kind === 'ping' ? 'ping' : job.kind === 'upgrade' ? `upgrade ${job.from} -> ${job.to}` : job.kind === 'evaluate' ? `evaluation of session ${job.session}` : job.skill}) - see data/inbox.md`);
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
  // A job queued between the last read and the lock release would wait for
  // the next stop; hand it to a fresh worker instead. Not after an
  // exhausted run - that queue is spinning and must stay put.
  if (!exhausted && !process.env.LAMARCK_NO_SPAWN && readJobs().some(j => j.status === 'queued')) {
    const child = spawn(process.execPath, [__filename, 'run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  return 0;
}

function enqueue() {
  const ping = has('--ping');
  const upgrade = has('--upgrade');
  const skill = opt('--skill');
  const proposal = opt('--proposal');
  const auth = opt('--auth');
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // Iron Rule, mechanically: a headless agent (LAMARCK_HEADLESS is set by
  // runJob) cannot claim the user's authorization. It may queue a ping or
  // an auto-tier job; user-authorized evolve and upgrade jobs come only
  // from a session the user is in, or from the installer the user ran.
  if (process.env.LAMARCK_HEADLESS && (upgrade || (!ping && auth !== 'auto'))) {
    console.error('refused: a headless agent cannot grant user authorization (only --auth auto or --ping)');
    return 2;
  }
  let job;
  if (upgrade) {
    const from = opt('--from'), to = opt('--to'), notes = opt('--notes'), files = opt('--files');
    if (!from || !to || !notes || !files || !fs.existsSync(path.resolve(root, notes))) {
      console.error('usage: enqueue --upgrade --from <ver> --to <ver> --notes <file> --files <a,b,c>');
      return 2;
    }
    job = { id, ts: nowIso(), kind: 'upgrade', skill: 'lamarck', from, to, notes: path.resolve(root, notes), files, auth: 'user', status: 'queued', seen: false };
  } else {
    if (!ping && (!skill || !proposal || !['user', 'auto'].includes(auth || ''))) {
      console.error('usage: enqueue --skill <name> --proposal <file> --auth user|auto   |   enqueue --ping   |   enqueue --upgrade ...');
      return 2;
    }
    if (!ping && !fs.existsSync(path.resolve(root, proposal))) { console.error(`proposal file not found: ${proposal}`); return 2; }
    job = {
      id, ts: nowIso(), kind: ping ? 'ping' : 'evolve',
      skill: ping ? '' : skill, proposal: ping ? '' : path.resolve(root, proposal), auth: ping ? 'user' : auth,
      status: 'queued', seen: false
    };
  }
  withJobsLock(() => fs.appendFileSync(jobsPath, JSON.stringify(job) + '\n', 'utf8'));
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
  const quiet = jobs.filter(j => j.kind === 'evaluate' && j.status === 'done' && j.seen === true).length;
  console.log(`jobs: ${jobs.length} total, ${queued} queued, ${unread.length} unread result(s), ${quiet} quiet evaluation(s) done backstage`);
  const inboxText = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8').split('\n') : [];
  for (const j of unread) {
    const line = inboxText.find(l => l.includes(`[${j.id}]`));
    console.log(line || `- [${j.id}] ${j.status}: ${j.result || ''}`);
  }
  if (has('--ack') && unread.length) {
    const ids = new Set(unread.map(j => j.id));
    withJobsLock(() => { const now = readJobs(); for (const j of now) if (ids.has(j.id)) j.seen = true; writeJobs(now); });
    console.log(`acknowledged ${unread.length}`);
  }
  return 0;
}

try {
  const code = cmd === 'run' ? run() : cmd === 'enqueue' ? enqueue() : cmd === 'status' ? status() : (console.error(`unknown command: ${cmd}`), 2);
  process.exit(code);
} catch (e) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, 'hook-errors.log'), `${new Date().toISOString()} evolve-worker: ${e && e.message}\n`, 'utf8'); } catch { /* ignore */ }
  process.exit(1);
}
