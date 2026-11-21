#!/usr/bin/env node
// views/render.mjs — S2 static change-log renderer (SPEC §9.2 S2).
//
// Consumes fixture `change` records (JSON, SPEC §5.1 shape — see
// views/README.md; W0's fixtures/ when landed) from an input directory and
// emits static HTML compatible with `tonk render` routes:
//
//   <out>/index.html          list, newest first — route `change`
//   <out>/change/<id>.html    one change, diff inline or blob link — `<entity>@change`
//
// Usage:
//   node views/render.mjs [--in DIR] [--out DIR] [--base PATH]
//
//   --in    default <repo>/fixtures/changes   (W0 fixtures; until they land,
//           pass e.g. --in tests/s2/fixtures/changes)
//   --out   default <repo>/dist/views         (dist/ is gitignored)
//   --base  URL/path prefix for links between pages (default ".")
//
// Offline, zero-dependency, Node ESM. Exit 1 with a hint if --in is missing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChanges, promptFirstLine, slugFor } from './lib/records.mjs';
import { esc, statusBadge, diffToHtml, fmtAt, page } from './lib/html.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { _: [], in: join(REPO, 'fixtures', 'changes'), out: join(REPO, 'dist', 'views'), base: '.' };
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

function filesSummary(rec) {
  return rec.files
    .map((f) => `<span class="f">${statusBadge(f.status)}${esc(f.path)}</span>`)
    .join('');
}

function totals(rec) {
  return `<span class="totals"><span class="plus">+${rec.linesAdded}</span> <span class="minus">−${rec.linesRemoved}</span></span>`;
}

function detailHref(base, rec) {
  return `${base}/change/${slugFor(rec.id)}.html`;
}

/** List page body: one row per change, newest first. */
export function renderList(changes, base) {
  const rows = changes
    .map((rec) => `    <tr>
      <td class="when">${esc(fmtAt(rec.at))}</td>
      <td class="agent">${esc(rec.agent)}${rec.harness ? ` <span class="harness">(${esc(rec.harness)})</span>` : ''}</td>
      <td class="prompt-line">${esc(promptFirstLine(rec.prompt))}${rec.redacted ? ' <span class="redacted">redacted</span>' : ''}</td>
      <td class="files">${filesSummary(rec)}</td>
      <td>${totals(rec)}</td>
      <td><a class="detail" href="${esc(detailHref(base, rec))}">diff →</a></td>
    </tr>`)
    .join('\n');
  return `<h1><a href="${esc(base)}/index.html">Changes</a></h1>
<p class="hint">${changes.length} change${changes.length === 1 ? '' : 's'}, newest first — agent, prompt first line, files with statuses, +/− lines.</p>
<table class="list">
  <thead><tr><th>when</th><th>agent</th><th>prompt</th><th>files</th><th>+/−</th><th></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

/** Detail page body for one change: meta, files table, diff (inline or blob link). */
export function renderDetail(rec, base) {
  const metaRows = [
    ['id', rec.id],
    ['agent', `${rec.agent}${rec.harness ? ` (${rec.harness})` : ''}`],
    ['session / turn', [rec.session, rec.turn].filter(Boolean).join(' / ')],
    ['parent session', rec.parentSession ?? '—'],
    ['project / branch', [rec.project, rec.branch].filter(Boolean).join(' / ')],
    ['commit', rec.commit ?? '—'],
    ['base → head', rec.base || rec.head ? `${rec.base ?? '?'} → ${rec.head ?? '?'}` : '—'],
    ['at', fmtAt(rec.at)],
    ['redacted', rec.redacted ? 'yes — secret scan removed content' : 'no'],
  ];
  const meta = metaRows
    .map(([k, v]) => `    <dt>${esc(k)}</dt><dd>${esc(v ?? '—')}</dd>`)
    .join('\n');

  const filesTable = `<table class="files-table">
  <thead><tr><th>status</th><th>path</th><th>+</th><th>−</th></tr></thead>
  <tbody>
${rec.files
  .map(
    (f) => `    <tr><td>${statusBadge(f.status)}</td><td>${esc(f.path)}</td><td>${f.added}</td><td>${f.removed}</td></tr>`,
  )
  .join('\n')}
  </tbody>
</table>`;

  let diffSection;
  if (rec.diff) {
    diffSection = `<h2>Diff</h2>\n${diffToHtml(rec.diff)}`;
  } else if (rec.diffBlob) {
    const hash = rec.diffBlob.replace(/^blob:/, '');
    diffSection = `<h2>Diff</h2>
<div class="blob-box">Diff stored as a blob (over the 64 KB inline limit, SPEC §5.1/§11.2):
  <a href="${esc(base)}/blob/${esc(hash)}"><code>${esc(rec.diffBlob)}</code></a><br>
  fetch it with <code>tonk blob cat ${esc(rec.diffBlob)}</code></div>`;
  } else {
    diffSection = `<h2>Diff</h2>\n<p class="hint">No diff recorded for this change.</p>`;
  }

  return `<p class="hint"><a href="${esc(base)}/index.html">← all changes</a></p>
<h1>${esc(promptFirstLine(rec.prompt)) || esc(rec.id)}</h1>
<p class="hint">${esc(rec.agent)}${rec.harness ? ` · ${esc(rec.harness)}` : ''} · ${esc(fmtAt(rec.at))} · ${totals(rec)}${rec.redacted ? ' · <span class="redacted">redacted</span>' : ''}</p>
<details class="prompt"><summary>full prompt</summary><pre>${esc(rec.prompt)}</pre></details>
<dl class="meta">
${meta}
</dl>
<h2>Files</h2>
${filesTable}
${diffSection}`;
}

export function renderAll(changes, { out, base }) {
  mkdirSync(join(out, 'change'), { recursive: true });
  const written = [];
  const indexPath = join(out, 'index.html');
  writeFileSync(indexPath, page({ title: 'Changes', body: renderList(changes, base), route: 'change' }), 'utf8');
  written.push(indexPath);
  for (const rec of changes) {
    const p = join(out, 'change', `${slugFor(rec.id)}.html`);
    writeFileSync(p, page({ title: String(rec.id), body: renderDetail(rec, base), route: `${rec.id}@change` }), 'utf8');
    written.push(p);
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let changes;
  try {
    changes = loadChanges(args.in);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      process.stderr.write(
        `error: input dir ${args.in} does not exist.\n` +
          `  W0's fixtures/ has not landed yet — render the sample records with:\n` +
          `  node views/render.mjs --in tests/s2/fixtures/changes --out dist/views\n`,
      );
      return 1;
    }
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    return 1;
  }
  if (changes.length === 0) {
    process.stderr.write(`error: no *.json change records in ${args.in}\n`);
    return 1;
  }
  const written = renderAll(changes, { out: args.out, base: args.base });
  process.stdout.write(
    JSON.stringify({ in: args.in, out: args.out, changes: changes.length, pages: written.length }, null, 2) + '\n',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
