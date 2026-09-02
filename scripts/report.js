#!/usr/bin/env node
// lamarck evidence report - computed by code, never by the model.
//
//   node scripts/report.js [--since 30d|12h|<ISO>] [--skill <name>] [--json|--md] [--brief]
//
// Reads data/ledger.jsonl (+ maturity.json, config.json, rejected.md) and
// prints per-skill health, per-version windows with objective-signal means,
// version-to-version deltas (flagging objective regressions the way the
// optimization gate's veto rule does), and the verify record. Every number
// is reproducible from the ledger lines; the only clock used is the ledger's
// own latest timestamp ("as_of"), so the same data always yields the same
// bytes. `/lamarck report` and `/lamarck stats` narrate over this output;
// they do not compute anything themselves.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const sinceArg = opt('--since');
const skillFilter = opt('--skill');
const asJson = has('--json');
const brief = has('--brief');

const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch { /* tolerate corrupt lines */ }
  }
  return out;
};
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const ledgerAll = readLines(path.join(root, 'data', 'ledger.jsonl'));
const maturity = readJson(path.join(root, 'data', 'maturity.json'), {});
const config = readJson(path.join(root, 'config.json'), {});
const rejectedEntries = (() => {
  try { return fs.readFileSync(path.join(root, 'data', 'rejected.md'), 'utf8').split('\n').filter(l => /^- /.test(l)).length; }
  catch { return 0; }
})();

// --- time window, anchored to the ledger's own latest timestamp
const tsOf = (r) => Date.parse(r.ts || '');
const asOfMs = ledgerAll.reduce((m, r) => Math.max(m, Number.isFinite(tsOf(r)) ? tsOf(r) : -Infinity), -Infinity);
const asOf = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString().slice(0, 19) + 'Z' : null;
let sinceMs = -Infinity;
if (sinceArg) {
  const m = /^(\d+)([dh])$/.exec(sinceArg);
  if (m) sinceMs = (Number.isFinite(asOfMs) ? asOfMs : 0) - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
  else if (Number.isFinite(Date.parse(sinceArg))) sinceMs = Date.parse(sinceArg);
  else { console.error(`bad --since value: ${sinceArg} (use 30d, 12h or an ISO timestamp)`); process.exit(2); }
}
const inWindow = (r) => { const t = tsOf(r); return !Number.isFinite(t) ? sinceMs === -Infinity : t >= sinceMs; };
const ledger = ledgerAll.filter(inWindow).filter(r => !skillFilter || r.skill === skillFilter);

const evals = ledger.filter(r => r.type !== 'verify' && r.skill);
const verifies = ledger.filter(r => r.type === 'verify');

// --- helpers
const round = (x) => Math.round(x * 1000) / 1000;
const mean = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const OBJ_KEYS = ['tools', 'errors', 'nonzero_exit', 'retries', 'user_turns'];
const harnessOf = (r) => r.harness || 'claude-code';
const counted = (r) => ['clean', 'corrected', 'failed'].includes(r.outcome); // full evaluations only
const tierOf = (skill) => {
  const ev = (config && config.evolution) || {};
  for (const t of ['auto', 'evolve', 'suggest']) if (Array.isArray(ev[t]) && ev[t].includes(skill)) return t;
  return ev.default || 'observe';
};
const tally = (rows, key) => {
  const m = {};
  for (const r of rows) { const k = key(r); m[k] = (m[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
};
const objectiveMeans = (rows) => {
  const withObj = rows.filter(r => r.objective && typeof r.objective === 'object');
  const out = { n: withObj.length };
  for (const k of OBJ_KEYS) out[k] = mean(withObj.map(r => Number(r.objective[k]) || 0));
  return out;
};
const correctionRate = (rows) => {
  const full = rows.filter(counted);
  if (!full.length) return null;
  return round(full.filter(r => r.outcome !== 'clean').length / full.length);
};

// --- per skill
const skills = [...new Set(evals.map(r => r.skill))].sort((a, b) => a.localeCompare(b));
const perSkill = {};
for (const s of skills) {
  const rows = evals.filter(r => r.skill === s);
  const gapCounts = {};
  for (const r of rows) for (const g of (Array.isArray(r.gaps) ? r.gaps : [])) {
    const k = String(g).trim().toLowerCase().slice(0, 80);
    if (k) gapCounts[k] = (gapCounts[k] || 0) + 1;
  }
  const topGaps = Object.entries(gapCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([gap, n]) => ({ gap, n }));
  // version windows in first-seen order
  const versOrder = [];
  for (const r of rows) { const v = r.ver || 'unstamped'; if (!versOrder.includes(v)) versOrder.push(v); }
  const versions = versOrder.map(v => {
    const vr = rows.filter(r => (r.ver || 'unstamped') === v);
    return { ver: v, n: vr.length, outcomes: tally(vr, r => r.outcome || 'unknown'),
      correction_rate: correctionRate(vr), objective: objectiveMeans(vr) };
  });
  const deltas = [];
  for (let i = 1; i < versions.length; i++) {
    const a = versions[i - 1], b = versions[i];
    const d = { from: a.ver, to: b.ver, n_before: a.n, n_after: b.n, correction_rate_delta: null, objective_delta: {}, objective_regression: false };
    if (a.correction_rate !== null && b.correction_rate !== null) d.correction_rate_delta = round(b.correction_rate - a.correction_rate);
    for (const k of OBJ_KEYS) {
      d.objective_delta[k] = (a.objective[k] !== null && b.objective[k] !== null) ? round(b.objective[k] - a.objective[k]) : null;
    }
    // mirrors the gate's veto rule: errors / nonzero_exit / retries up, n >= 3
    if (b.objective.n >= 3 && a.objective.n >= 1) {
      d.objective_regression = ['errors', 'nonzero_exit', 'retries'].some(k => d.objective_delta[k] !== null && d.objective_delta[k] > 0);
    }
    deltas.push(d);
  }
  const vs = verifies.filter(r => r.skill === s);
  perSkill[s] = {
    tier: tierOf(s),
    maturity: maturity[s] || null,
    evaluations: rows.length,
    outcomes: tally(rows, r => r.outcome || 'unknown'),
    harness: tally(rows, harnessOf),
    correction_rate: correctionRate(rows),
    objective: objectiveMeans(rows),
    top_gaps: topGaps,
    versions, deltas,
    verify: {
      records: vs.length,
      kept: vs.filter(r => r.decision === 'keep').length,
      reverted: vs.filter(r => r.decision === 'revert').length,
      judges_total: vs.reduce((a, r) => a + (Number(r.judges) || 0), 0),
      replay_pass_rate: (() => { const rp = vs.filter(r => r.stage === 'replay'); return rp.length ? round(rp.filter(r => r.result !== 'worse').length / rp.length) : null; })(),
      entries: vs.map(r => ({ ts: r.ts, stage: r.stage, result: r.result, decision: r.decision, judges: r.judges, old_ver: r.old_ver, new_ver: r.new_ver }))
    }
  };
}

const report = {
  as_of: asOf,
  since: sinceMs === -Infinity ? null : new Date(sinceMs).toISOString().slice(0, 19) + 'Z',
  skill_filter: skillFilter || null,
  ledger_lines_total: ledgerAll.length,
  overview: {
    evaluations: evals.length,
    skills: skills.length,
    sessions: new Set(evals.map(r => r.session || '')).size,
    outcomes: tally(evals, r => r.outcome || 'unknown'),
    harness: tally(evals, harnessOf),
    correction_rate: correctionRate(evals),
    objective: objectiveMeans(evals),
    stable_skills: skills.filter(s => maturity[s] && maturity[s].state === 'stable').length,
    verify_records: verifies.length,
    edits_kept: verifies.filter(r => r.decision === 'keep').length,
    edits_reverted: verifies.filter(r => r.decision === 'revert').length,
    rejected_proposals: rejectedEntries
  },
  skills: perSkill
};

if (asJson) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exit(0); }

// --- markdown
const fmt = (x) => (x === null || x === undefined ? '-' : String(x));
const obj = (o) => OBJ_KEYS.map(k => `${k}=${fmt(o[k])}`).join(' ') + ` (n=${o.n})`;
const L = [];
L.push(`# lamarck evidence report`);
L.push(`as_of: ${fmt(asOf)}  since: ${fmt(report.since)}  skill: ${fmt(skillFilter)}  ledger lines: ${ledgerAll.length}`);
L.push('');
const ov = report.overview;
L.push(`## Overview`);
L.push(`evaluations ${ov.evaluations} | skills ${ov.skills} | sessions ${ov.sessions} | stable ${ov.stable_skills} | correction rate ${fmt(ov.correction_rate)}`);
L.push(`outcomes: ${Object.entries(ov.outcomes).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
L.push(`harness: ${Object.entries(ov.harness).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);
L.push(`objective means: ${obj(ov.objective)}`);
L.push(`verify: ${ov.verify_records} records, kept ${ov.edits_kept}, reverted ${ov.edits_reverted}; rejected proposals ${ov.rejected_proposals}`);
L.push('');
L.push(`## Skills`);
L.push(`| skill | tier | evals | correction | maturity | objective (errors/exit/retries) | top gap |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const s of skills) {
  const p = perSkill[s];
  const mat = p.maturity ? `${p.maturity.state} (${p.maturity.clean_streak || 0})` : '-';
  L.push(`| ${s} | ${p.tier} | ${p.evaluations} | ${fmt(p.correction_rate)} | ${mat} | ${fmt(p.objective.errors)}/${fmt(p.objective.nonzero_exit)}/${fmt(p.objective.retries)} | ${p.top_gaps[0] ? `${p.top_gaps[0].gap} (x${p.top_gaps[0].n})` : '-'} |`);
}
if (!brief) {
  for (const s of skills) {
    const p = perSkill[s];
    if (p.versions.length < 2 && !p.verify.records) continue;
    L.push('');
    L.push(`### ${s} - versions`);
    L.push(`| ver | n | correction | ${OBJ_KEYS.join(' | ')} |`);
    L.push(`|---|---|---|${OBJ_KEYS.map(() => '---').join('|')}|`);
    for (const v of p.versions) L.push(`| ${v.ver} | ${v.n} | ${fmt(v.correction_rate)} | ${OBJ_KEYS.map(k => fmt(v.objective[k])).join(' | ')} |`);
    for (const d of p.deltas) {
      L.push(`- ${d.from} -> ${d.to}: correction ${fmt(d.correction_rate_delta)}; ` +
        OBJ_KEYS.map(k => `${k} ${fmt(d.objective_delta[k])}`).join(', ') +
        (d.objective_regression ? '  **OBJECTIVE REGRESSION (veto)**' : ''));
    }
    if (p.verify.records) {
      L.push(`verify: ${p.verify.records} records, kept ${p.verify.kept}, reverted ${p.verify.reverted}, judges ${p.verify.judges_total}, replay pass ${fmt(p.verify.replay_pass_rate)}`);
      for (const e of p.verify.entries) L.push(`- ${e.ts} ${e.stage} ${e.result} -> ${e.decision} (judges ${fmt(e.judges)}, ${fmt(e.old_ver)} -> ${fmt(e.new_ver)})`);
    }
  }
}
process.stdout.write(L.join('\n') + '\n');
