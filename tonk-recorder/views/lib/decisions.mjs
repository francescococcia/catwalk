// views/lib/decisions.mjs — load + fold the demo space's exported JSON mirror
// (demo/data/*.json, produced by demo/seed-space.mjs from `tonk query --json`)
// into the model behind the decision-history view (views/decisions.mjs).
//
// Shape of the input files (JSON mirror of contracts/records.md):
//   changes.json           [{ id, session, turn, agent, harness, prompt, response?,
//                            project, branch, base, head, commit, files[],
//                            linesAdded, linesRemoved, diff?, diffBlob?, redacted, at, this }]
//   decisions.json         [{ id, name?, title, chosen, why, by, at, rejected?, supersedes?, about[], this }]
//   decision-statuses.json [{ id, decision, status, by, at, this }]
//   sessions.json          [{ id, agent, harness, project, started, ended?, changes }]
//   meta.json              { space, site, project, tonk, revisions }
//
// Read-side rules implemented here (contracts/records.md §decision-status):
// current status = the status record with the latest `at` per decision;
// supersede chains are followed via `supersedes`; `about` targets that match
// a change entity link to that change.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeChange, slugFor } from './records.mjs';

export class DataError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.name = 'DataError';
    this.file = file;
  }
}

function loadJsonArray(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) throw new DataError(name, `missing ${p} — run demo/seed-space.mjs first`);
  const v = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(v)) throw new DataError(name, 'expected a JSON array');
  return v;
}

const timeOf = (r) => {
  const t = Date.parse(r?.at);
  return Number.isNaN(t) ? 0 : t;
};

function normalizeDecision(raw, file) {
  const d = { ...raw };
  for (const key of ['id', 'title', 'chosen', 'why', 'by', 'at']) {
    if (d[key] === undefined || d[key] === null || d[key] === '') {
      throw new DataError(file, `decision missing required field "${key}"`);
    }
  }
  d.rejected = d.rejected ?? null;
  d.supersedes = d.supersedes ?? null;
  d.about = Array.isArray(d.about) ? d.about : [];
  d.slug = slugFor(d.name ?? d.id);
  return d;
}

function normalizeStatus(raw, file) {
  const s = { ...raw };
  for (const key of ['decision', 'status', 'by', 'at']) {
    if (s[key] === undefined || s[key] === null || s[key] === '') {
      throw new DataError(file, `decision-status missing required field "${key}"`);
    }
  }
  return s;
}

/**
 * Load the whole demo data dir into a model:
 * { changes, decisions, statuses, sessions, meta,
 *   changeByEntity, decisionById, statusHistoryOf, currentStatusOf,
 *   supersededBy, timeline }
 * All lists newest first (by `at`, ties by id).
 */
export function loadDemoData(dir) {
  const changes = loadJsonArray(dir, 'changes.json').map((r) => normalizeChange(r, 'changes.json'));
  const decisions = loadJsonArray(dir, 'decisions.json').map((r) => normalizeDecision(r, 'decisions.json'));
  const statuses = loadJsonArray(dir, 'decision-statuses.json').map((r) => normalizeStatus(r, 'decision-statuses.json'));
  const sessions = loadJsonArray(dir, 'sessions.json');
  let meta = {};
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { meta = {}; }

  const byTimeDesc = (a, b) => timeOf(b) - timeOf(a) || String(a.id ?? a.at).localeCompare(String(b.id ?? b.at));
  changes.sort(byTimeDesc);
  decisions.sort(byTimeDesc);
  statuses.sort((a, b) => timeOf(a) - timeOf(b) || String(a.id).localeCompare(String(b.id))); // history oldest first

  const changeByEntity = new Map(changes.map((c) => [c.this ?? c.id, c]));
  const decisionById = new Map(decisions.map((d) => [d.id, d]));

  const statusHistoryOf = (decisionId) => statuses.filter((s) => s.decision === decisionId);
  const currentStatusOf = (decisionId) => {
    const h = statusHistoryOf(decisionId);
    return h.length ? h[h.length - 1].status : null;
  };
  const supersededBy = new Map();
  for (const d of decisions) if (d.supersedes) supersededBy.set(d.supersedes, d);

  // one merged activity feed: changes + decisions + status events, newest first
  const timeline = [
    ...changes.map((c) => ({ kind: 'change', at: c.at, ref: c, label: c.prompt.split('\n', 1)[0] })),
    ...decisions.map((d) => ({ kind: 'decision', at: d.at, ref: d, label: d.title })),
    ...statuses.map((s) => ({ kind: 'status', at: s.at, ref: s, label: `${decisionById.get(s.decision)?.title ?? s.decision} → ${s.status}` })),
  ].sort((a, b) => timeOf(b) - timeOf(a) || a.kind.localeCompare(b.kind));

  return {
    changes, decisions, statuses, sessions, meta,
    changeByEntity, decisionById, statusHistoryOf, currentStatusOf, supersededBy, timeline,
  };
}

/** Extra CSS for the decision-history pages (appended after html.mjs's CSS). */
export const DECISION_CSS = `
.nav { display:flex; gap:1rem; margin:0 0 1.5rem; font-size:.9rem; }
.nav a { color:var(--aubergine); text-decoration:none; font-weight:600; }
.nav a:hover { text-decoration:underline; }
.dstatus { display:inline-block; min-width:5.2em; text-align:center; border-radius:4px;
  font-size:.72rem; font-weight:600; padding:.1rem .4rem; }
.ds-accepted { background:var(--add); color:var(--add-ink); }
.ds-proposed { background:var(--aubergine-soft); color:var(--aubergine); }
.ds-rejected { background:var(--del); color:var(--del-ink); }
.ds-none { background:var(--stone-3); color:var(--muted); }
table.decisions td { border-bottom:1px solid var(--stone-3); padding:.55rem .6rem; vertical-align:top; }
table.decisions tr:hover td { background:var(--stone-2); }
.dec-title { font-weight:600; }
.dec-title a { color:var(--ink); text-decoration:none; }
.dec-title a:hover { color:var(--aubergine); }
.dec-chosen { color:var(--muted); font-size:.85rem; margin:.15rem 0 0; }
.chip { display:inline-block; background:var(--stone-2); border:1px solid var(--stone-3);
  border-radius:10px; padding:.05rem .5rem; margin:.1rem .3rem .1rem 0;
  font-family:ui-monospace, Menlo, monospace; font-size:.72rem; color:var(--muted); }
a.chip { color:var(--aubergine); text-decoration:none; }
a.chip:hover { border-color:var(--aubergine); }
.sup { font-size:.75rem; color:var(--aubergine); white-space:nowrap; }
ul.status-history { list-style:none; margin:0; padding:0; }
ul.status-history li { padding:.3rem 0 .3rem 1.4rem; position:relative; border-left:2px solid var(--stone-3); margin-left:.4rem; font-size:.88rem; }
ul.status-history li::before { content:""; position:absolute; left:-6px; top:.75rem; width:10px; height:10px;
  border-radius:50%; background:var(--aubergine); }
ul.status-history .when { color:var(--muted); font-size:.78rem; margin-right:.5rem; }
table.feed td { border-bottom:1px solid var(--stone-3); padding:.5rem .6rem; vertical-align:top; }
.kind { display:inline-block; min-width:4.8em; text-align:center; border-radius:4px; font-size:.72rem;
  font-weight:600; padding:.1rem .4rem; }
.k-change { background:var(--stone-3); color:var(--ink); }
.k-decision { background:var(--aubergine-soft); color:var(--aubergine); }
.k-status { background:var(--add); color:var(--add-ink); }
.feed a { color:var(--ink); text-decoration:none; }
.feed a:hover { color:var(--aubergine); }
.block { background:var(--stone-2); border:1px solid var(--stone-3); border-radius:8px;
  padding:.75rem 1rem; margin:0 0 1rem; font-size:.9rem; }
.block h3 { margin:0 0 .35rem; font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.cards { display:flex; gap:1rem; flex-wrap:wrap; margin:0 0 1.5rem; }
.card { border:1px solid var(--stone-3); border-radius:8px; padding:.75rem 1rem; min-width:9rem;
  background:var(--stone-2); text-decoration:none; color:var(--ink); }
.card:hover { border-color:var(--aubergine); }
.card .n { font-size:1.4rem; font-weight:700; color:var(--aubergine); }
.card .l { font-size:.78rem; color:var(--muted); }
`;
