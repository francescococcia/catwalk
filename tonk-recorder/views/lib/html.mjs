// views/lib/html.mjs — tiny HTML helpers for the static change-log renderer
// (S2). Zero-dependency; everything user-derived is escaped. Clean stone +
// aubergine accent (optional per SPEC, kept subtle).

/** Escape for HTML text/attribute context. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STATUS_CLASS = { added: 'st-added', modified: 'st-modified', deleted: 'st-deleted', renamed: 'st-renamed' };

/** Badge HTML for a file status. */
export function statusBadge(status) {
  const cls = STATUS_CLASS[status] ?? 'st-modified';
  return `<span class="status ${cls}">${esc(status)}</span>`;
}

/**
 * Render a unified diff as HTML: one <span class="d …"> per line.
 * Classes: d-add (+), d-del (−), d-hunk (@@), d-meta (diff/index/---/+++).
 */
export function diffToHtml(diff) {
  const lines = String(diff ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    let cls = 'd';
    if (line.startsWith('@@')) cls = 'd-hunk';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'd-meta';
    else if (line.startsWith('+')) cls = 'd-add';
    else if (line.startsWith('-')) cls = 'd-del';
    out.push(`<span class="${cls}">${esc(line) || ' '}</span>`);
  }
  return `<pre class="diff"><code>${out.join('\n')}</code></pre>`;
}

/** Format an ISO timestamp for display (UTC, compact). */
export function fmtAt(at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return String(at ?? '');
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

const CSS = `
:root { --stone-1:#fafaf9; --stone-2:#f5f5f4; --stone-3:#e7e5e4; --ink:#1c1917;
  --muted:#78716c; --aubergine:#5b2a86; --aubergine-soft:#f3ecf9;
  --add:#e6f4e6; --add-ink:#1a7f37; --del:#fdecea; --del-ink:#b3261e; }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background:var(--stone-1); color:var(--ink); }
main { max-width: 960px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
h1 a { color:var(--ink); text-decoration:none; }
.hint { color:var(--muted); font-size:.85rem; margin:0 0 1.5rem; }
table { border-collapse:collapse; width:100%; }
.list th { text-align:left; font-size:.75rem; text-transform:uppercase; letter-spacing:.04em;
  color:var(--muted); border-bottom:2px solid var(--stone-3); padding:.4rem .6rem; }
.list td { border-bottom:1px solid var(--stone-3); padding:.55rem .6rem; vertical-align:top; }
.list tr:hover td { background:var(--stone-2); }
.when { white-space:nowrap; color:var(--muted); font-size:.85rem; }
.agent { font-weight:600; }
.agent .harness { color:var(--muted); font-weight:400; font-size:.8rem; }
.prompt-line { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem; }
.files { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.78rem; color:var(--muted); }
.files .f { display:inline-block; margin:0 .5rem .2rem 0; }
.totals { white-space:nowrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem; }
.totals .plus { color:var(--add-ink); font-weight:600; }
.totals .minus { color:var(--del-ink); font-weight:600; }
.status { display:inline-block; min-width:4.6em; text-align:center; border-radius:4px;
  font-size:.72rem; padding:.05rem .35rem; margin-right:.4rem; }
.st-added { background:var(--add); color:var(--add-ink); }
.st-modified { background:var(--aubergine-soft); color:var(--aubergine); }
.st-deleted { background:var(--del); color:var(--del-ink); }
.st-renamed { background:var(--stone-3); color:var(--ink); }
.redacted { color:var(--del-ink); font-size:.75rem; font-weight:600; }
a.detail { color:var(--aubergine); white-space:nowrap; font-size:.85rem; }
.meta { display:grid; grid-template-columns: max-content 1fr; gap:.25rem 1rem; margin:1rem 0 1.5rem;
  font-size:.85rem; background:var(--stone-2); border:1px solid var(--stone-3); border-radius:8px; padding:1rem; }
.meta dt { color:var(--muted); } .meta dd { margin:0; font-family:ui-monospace, Menlo, monospace; word-break:break-all; }
details.prompt { margin:0 0 1.5rem; } details.prompt summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
details.prompt pre { background:var(--stone-2); border:1px solid var(--stone-3); border-radius:8px;
  padding:.75rem 1rem; white-space:pre-wrap; word-break:break-word; font-size:.85rem; }
table.files-table th { text-align:left; font-size:.75rem; text-transform:uppercase; letter-spacing:.04em;
  color:var(--muted); border-bottom:2px solid var(--stone-3); padding:.4rem .6rem; }
table.files-table td { border-bottom:1px solid var(--stone-3); padding:.4rem .6rem;
  font-family:ui-monospace, Menlo, monospace; font-size:.82rem; }
.diff { background:var(--stone-2); border:1px solid var(--stone-3); border-radius:8px; padding:.75rem 1rem;
  overflow-x:auto; font-size:.78rem; line-height:1.45; }
.diff .d { display:block; white-space:pre; }
.diff .d-add { background:var(--add); color:var(--add-ink); }
.diff .d-del { background:var(--del); color:var(--del-ink); }
.diff .d-hunk { color:var(--aubergine); background:var(--aubergine-soft); }
.diff .d-meta { color:var(--muted); }
.blob-box { border:1px dashed var(--aubergine); background:var(--aubergine-soft); border-radius:8px;
  padding:.75rem 1rem; font-size:.85rem; margin:1rem 0; }
.blob-box code { font-size:.85rem; word-break:break-all; }
footer { max-width:960px; margin:0 auto; padding:1.5rem 1.25rem 3rem; color:var(--muted);
  font-size:.78rem; border-top:1px solid var(--stone-3); }
footer code { background:var(--stone-2); padding:.1rem .3rem; border-radius:4px; }
`;

/**
 * Full HTML page shell. `route` is the space route this page stands for
 * (e.g. "change" or "<entity>@change"); the footer states how the member-only
 * route is served (SPEC §8): https://<origin>/space/<did>/<path>.
 */
export function page({ title, body, route }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tonk change log</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<footer>
  <p>Tonk recorder change log — <strong>member-only</strong> (SPEC §8): served from the space at
  <code>https://&lt;origin&gt;/space/&lt;did&gt;/${esc(route)}</code>
  (list: <code>https://&lt;origin&gt;/space/&lt;did&gt;/change</code>,
  detail: <code>https://&lt;origin&gt;/space/&lt;did&gt;/&lt;entity&gt;@change</code>).
  This static page is a preview rendered from fixture change records.</p>
</footer>
</body>
</html>
`;
}
