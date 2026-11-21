#!/usr/bin/env node
// views/decisions.mjs — decision-history view over a demo Tonk space
// (SPEC §5.2/§7 read path; browses the same records `tonk log decision` shows).
//
// Input: the JSON mirror exported by demo/seed-space.mjs (`tonk query --json`
// over the recorder concepts, lenses folded — see views/lib/decisions.mjs).
// Output: static HTML under --out, same shell/styling as views/render.mjs:
//
//   <out>/index.html                 landing — counts + links
//   <out>/decisions/index.html       decision history, newest first, with the
//                                    CURRENT status badge (latest status record
//                                    by `at`), supersedes chips, about chips
//   <out>/decisions/<slug>.html      one decision: full status history, supersede
//                                    chain, related changes, chosen/why/rejected
//   <out>/timeline.html              merged activity feed: changes + decisions +
//                                    status events, newest first
//   <out>/changes/…                  the change log (reused from render.mjs)
//
// Usage:
//   node views/decisions.mjs [--in DIR] [--out DIR] [--base PATH]
//     --in    default <repo>/demo/data     (run demo/seed-space.mjs first)
//     --out   default <repo>/dist/views    (dist/ is gitignored)
//     --base  URL/path prefix for links (default ".")
//
// Offline, zero-dependency, Node ESM.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, fmtAt, page, statusBadge } from './lib/html.mjs';
import { promptFirstLine, slugFor } from './lib/records.mjs';
import { loadDemoData, DECISION_CSS } from './lib/decisions.mjs';
import { renderAll } from './render.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [], in: join(REPO, 'demo', 'data'), out: join(REPO, 'dist', 'views'), base: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in' || a === '--out' || a === '--base') out[a.slice(2)] = argv[++i];
    else if (a.startsWith('--in=')) out.in = a.slice(5);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--base=')) out.base = a.slice(7);
    else out._.push(a);
  }
  return out;
}

const shell = (title, body, route) =>
  page({ title, body: `<style>${DECISION_CSS}</style>\n${body}`, route });

const statusBadgeHtml = (status) =>
  status
    ? `<span class="dstatus ds-${esc(status)}">${esc(status)}</span>`
    : `<span class="dstatus ds-none">no status</span>`;

// `root` is the relative prefix from the current page to the out root
// ('.' for root pages, '..' for pages in decisions/).
/** Chips for a decision's `about` targets — linked when the target is a change. */
function aboutChips(model, d, root) {
  return d.about
    .map((target) => {
      const change = model.changeByEntity.get(target);
      if (change) {
        return `<a class="chip" href="${esc(root)}/changes/change/${esc(slugFor(change.id))}.html" title="change ${esc(change.id)}">${esc(change.id)}</a>`;
      }
      return `<span class="chip">${esc(target)}</span>`;
    })
    .join('');
}

function supersedesChip(model, d, root) {
  if (!d.supersedes) return '';
  const prev = model.decisionById.get(d.supersedes);
  return prev
    ? `<div class="sup">supersedes → <a href="${esc(root)}/decisions/${esc(prev.slug)}.html">${esc(prev.title)}</a></div>`
    : `<div class="sup">supersedes → <span class="chip">${esc(d.supersedes)}</span></div>`;
}

function nav(root, current) {
  const link = (href, label, key) =>
    key === current
      ? `<strong>${esc(label)}</strong>`
      : `<a href="${esc(root)}/${esc(href)}">${esc(label)}</a>`;
  return `<p class="nav">${link('index.html', 'home', 'home')} ${link('decisions/index.html', 'decisions', 'decisions')} ${link('timeline.html', 'timeline', 'timeline')} ${link('changes/index.html', 'changes', 'changes')}</p>`;
}

// --- pages -------------------------------------------------------------------

export function renderHome(model, base) {
  const root = base;
  const cards = [
    [`${model.decisions.length}`, 'decisions', 'decisions/index.html'],
    [`${model.changes.length}`, 'changes', 'changes/index.html'],
    [`${model.statuses.length}`, 'status records', 'timeline.html'],
    [`${model.sessions.length}`, 'sessions', 'timeline.html'],
  ]
    .map(([n, l, href]) => `<a class="card" href="${esc(root)}/${esc(href)}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></a>`)
    .join('');
  const meta = model.meta ?? {};
  return `${nav(root, 'home')}
<h1>Decision history — ${esc(meta.space ?? 'tonk demo space')}</h1>
<p class="hint">What was decided, by whom, and how each decision's status moved over time —
add-only: a change of mind is a new decision with <code>supersedes</code>, never an edit
(contracts/records.md). Rendered from the space's exported records
(<code>tonk query --json</code>; browse the space itself with <code>tonk-dev log decision</code>).</p>
<div class="cards">${cards}</div>
${meta.revisions ? `<p class="hint">space <code>${esc(meta.space)}</code> · ${esc(String(meta.revisions))} revisions · site <code>${esc(meta.site ?? '')}</code></p>` : ''}`;
}

export function renderDecisionList(model, base) {
  const root = base === '.' ? '..' : join(base, '..'); // list lives in decisions/
  const rows = model.decisions
    .map((d) => {
      const status = model.currentStatusOf(d.id);
      return `    <tr>
      <td class="when">${esc(fmtAt(d.at))}</td>
      <td>${statusBadgeHtml(status)}</td>
      <td><div class="dec-title"><a href="${esc(d.slug)}.html">${esc(d.title)}</a></div>
        <p class="dec-chosen">${esc(d.chosen)}</p>${supersedesChip(model, d, root)}</td>
      <td class="agent">${esc(d.by)}</td>
      <td>${aboutChips(model, d, root)}</td>
    </tr>`;
    })
    .join('\n');
  return `${nav(root, 'decisions')}
<h1>Decisions</h1>
<p class="hint">${model.decisions.length} decisions, newest first. Badge = current status (latest status record by <code>at</code>).
<code>supersedes</code> marks the add-only chain: the linked decision is the earlier one this replaces.</p>
<table class="list decisions">
  <thead><tr><th>when</th><th>status</th><th>decision</th><th>by</th><th>about</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

export function renderDecisionDetail(model, d, base) {
  const root = base === '.' ? '..' : join(base, '..'); // detail lives in decisions/
  const status = model.currentStatusOf(d.id);
  const history = model.statusHistoryOf(d.id);
  const supersededBy = model.supersededBy.get(d.id);

  const metaRows = [
    ['title', d.title],
    ['id', d.name ? `${d.name} (${d.id})` : d.id],
    ['current status', status ?? '—'],
    ['by', d.by],
    ['at', fmtAt(d.at)],
    ['supersedes', d.supersedes ? (model.decisionById.get(d.supersedes)?.title ?? d.supersedes) : '—'],
    ['superseded by', supersededBy ? supersededBy.title : '—'],
    ['about', d.about.join(', ') || '—'],
  ];
  const meta = metaRows.map(([k, v]) => `    <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n');

  const historyHtml = history.length
    ? `<ul class="status-history">${history
        .map((s) => `<li><span class="when">${esc(fmtAt(s.at))}</span>${statusBadgeHtml(s.status)} by ${esc(s.by)}</li>`)
        .join('\n')}</ul>`
    : `<p class="hint">No status records (hand-added decisions default to accepted, SPEC §11.8).</p>`;

  // related changes = about targets that are change entities
  const related = d.about
    .map((t) => model.changeByEntity.get(t))
    .filter(Boolean)
    .map(
      (c) => `    <tr><td class="when">${esc(fmtAt(c.at))}</td><td>${esc(c.agent)}</td>
        <td><a href="${esc(root)}/changes/change/${esc(slugFor(c.id))}.html">${esc(promptFirstLine(c.prompt))}</a></td>
        <td>${c.files.map((f) => `${statusBadge(f.status)}${esc(f.path)}`).join(' ')}</td>
        <td><span class="totals"><span class="plus">+${c.linesAdded}</span> <span class="minus">−${c.linesRemoved}</span></span></td></tr>`,
    )
    .join('\n');
  const relatedSection = related
    ? `<h2>Related changes</h2>
<table class="list"><thead><tr><th>when</th><th>agent</th><th>prompt</th><th>files</th><th>+/−</th></tr></thead>
<tbody>
${related}
</tbody></table>`
    : '';

  return `${nav(root, 'decisions')}
<p class="hint"><a href="${esc(root)}/decisions/index.html">← all decisions</a></p>
<h1>${esc(d.title)}</h1>
<p class="hint">${statusBadgeHtml(status)} · ${esc(d.by)} · ${esc(fmtAt(d.at))}${d.name ? ` · <code>${esc(d.name)}</code>` : ''}</p>
${supersedesChip(model, d, root)}
${supersededBy ? `<div class="sup">superseded by → <a href="${esc(supersededBy.slug)}.html">${esc(supersededBy.title)}</a></div>` : ''}
<dl class="meta">
${meta}
</dl>
<div class="block"><h3>Chosen</h3>${esc(d.chosen)}</div>
<div class="block"><h3>Why</h3>${esc(d.why)}</div>
${d.rejected ? `<div class="block"><h3>Rejected alternatives</h3>${esc(d.rejected)}</div>` : ''}
<div class="block"><h3>About</h3>${aboutChips(model, d, root) || '<span class="hint">—</span>'}</div>
<h2>Status history</h2>
${historyHtml}
${relatedSection}`;
}

export function renderTimeline(model, base) {
  const root = base;
  const hrefFor = (ev) =>
    ev.kind === 'change'
      ? `${root}/changes/change/${slugFor(ev.ref.id)}.html`
      : ev.kind === 'decision'
        ? `${root}/decisions/${ev.ref.slug}.html`
        : `${root}/decisions/${model.decisionById.get(ev.ref.decision)?.slug ?? slugFor(ev.ref.decision)}.html`;
  const rows = model.timeline
    .map(
      (ev) => `    <tr>
      <td class="when">${esc(fmtAt(ev.at))}</td>
      <td><span class="kind k-${ev.kind}">${ev.kind}</span></td>
      <td class="feed"><a href="${esc(hrefFor(ev))}">${esc(ev.label)}</a>${
        ev.kind === 'change'
          ? ` <span class="totals"><span class="plus">+${ev.ref.linesAdded}</span> <span class="minus">−${ev.ref.linesRemoved}</span></span>`
          : ''
      }</td>
    </tr>`,
    )
    .join('\n');
  return `${nav(root, 'timeline')}
<h1>Timeline</h1>
<p class="hint">Everything the space recorded, newest first — changes, decisions and status moves interleaved by time.</p>
<table class="list feed">
  <thead><tr><th>when</th><th>kind</th><th>event</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

// --- driver ------------------------------------------------------------------

export function renderAllDecisions(model, { out, base }) {
  const written = [];
  const write = (relPath, html) => {
    const p = join(out, relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, html, 'utf8');
    written.push(p);
  };

  write('index.html', shell('Decision history', renderHome(model, base), 'home'));
  write(join('decisions', 'index.html'), shell('Decisions', renderDecisionList(model, base), 'decision'));
  for (const d of model.decisions) {
    write(join('decisions', `${d.slug}.html`), shell(d.title, renderDecisionDetail(model, d, base), `${d.id}@decision`));
  }
  write('timeline.html', shell('Timeline', renderTimeline(model, base), 'timeline'));
  // the change log, reused from the S2 renderer (lands in <out>/changes)
  written.push(...renderAll(model.changes, { out: join(out, 'changes'), base: '.' }));
  // render.mjs's detail pages link back to `${base}/index.html`; from
  // <out>/changes/change/ that must be one level up
  for (const p of written.filter((p) => p.includes(`${join('changes', 'change')}${sep}`))) {
    const html = readFileSync(p, 'utf8');
    writeFileSync(p, html.replaceAll('href="./index.html"', 'href="../index.html"'), 'utf8');
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let model;
  try {
    model = loadDemoData(args.in);
  } catch (err) {
    process.stderr.write(
      `error: ${err?.message ?? err}\n` +
        `  no demo data in ${args.in} — create + fill the demo space first:\n` +
        `  TONK_BIN=~/.local/bin/tonk-dev node demo/seed-space.mjs\n`,
    );
    return 1;
  }
  const written = renderAllDecisions(model, { out: args.out, base: args.base });
  process.stdout.write(
    JSON.stringify(
      {
        in: args.in,
        out: args.out,
        decisions: model.decisions.length,
        changes: model.changes.length,
        statuses: model.statuses.length,
        timelineEvents: model.timeline.length,
        pages: written.length,
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
