#!/usr/bin/env node
// demo/seed-space.mjs — create a demo Tonk space with the tonk-recorder
// concepts, fill it with sample data, and export a JSON mirror for the
// views (views/decisions.mjs renders demo/data into dist/views).
//
// Fully offline: local-only space (`--site <dir>`), fake HOME under the demo
// dir, DO_NOT_TRACK=1, no upstream, no network. Idempotent: re-running
// re-asserts the same facts (no-op commits) and rewrites demo/data.
//
// Usage:
//   node demo/seed-space.mjs [--demo-dir DIR] [--data-dir DIR] [--keep]
//
//   --demo-dir  where the space lives (default: $TONK_DEMO_DIR or
//               <repo>/../tonk-demo) — home/, site/, project/ under it.
//               Tonk site data lives OUTSIDE the repo (contracts/layout.md §5).
//   --data-dir  where the JSON mirror is written (default <repo>/demo/data)
//   --keep      do not delete an existing demo dir first (default: recreate
//               the space from scratch so the run is reproducible)
//
// Env: TONK_BIN selects the tonk binary (default: ~/.local/bin/tonk-dev,
// falling back to `tonk` on PATH — the dev build has log/render).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { demoDir: process.env.TONK_DEMO_DIR || join(REPO, '..', 'tonk-demo'), dataDir: join(REPO, 'demo', 'data'), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo-dir') out.demoDir = resolve(argv[++i]);
    else if (a.startsWith('--demo-dir=')) out.demoDir = resolve(a.slice(11));
    else if (a === '--data-dir') out.dataDir = resolve(argv[++i]);
    else if (a.startsWith('--data-dir=')) out.dataDir = resolve(a.slice(11));
    else if (a === '--keep') out.keep = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function tonkBin() {
  if (process.env.TONK_BIN) return process.env.TONK_BIN;
  const dev = join(homedir(), '.local', 'bin', 'tonk-dev');
  return existsSync(dev) ? dev : 'tonk';
}

const TONK = tonkBin();

function run(args, { cwd, env } = {}) {
  return execFileSync(TONK, args, {
    encoding: 'utf8',
    cwd,
    timeout: 120_000,
    env: { ...process.env, DO_NOT_TRACK: '1', ...env },
  });
}

const RECORD_FIXTURES = [
  'change-001', 'change-002-secret', 'decision-001', 'decision-002-supersedes',
  'decision-status-001', 'session-001', 'tool-001', 'trusted-publisher-001',
];

// --- export shaping ----------------------------------------------------------

/** dash-case notation key → camelCase JSON mirror key (contracts/records.md). */
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Keyword values read back as `word:` — strip the trailing colon. */
const unkeyword = (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]*:$/.test(v) ? v.slice(0, -1) : v);

function camelizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out;
}

/** Fold lens rows into their owner: files[] on change, about[] on decision. */
function exportAll(query) {
  const changes = query('change').map((r) => {
    const c = camelizeRow(r);
    c.id = `${c.session}:${c.turn}`;
    c.harness = unkeyword(c.harness);
    c.diffBlob = c.diffBlob ?? null;
    c.parentSession = c.parentSession ?? null;
    c.files = query('change-file')
      .filter((f) => f.change === r.this)
      .map((f) => ({ path: f.path, status: unkeyword(f.status), added: f.added, removed: f.removed }));
    return c;
  });

  // entity → bookmark name, from the claim log (tonk-dev `log <concept>`)
  const names = {};
  try {
    const log = JSON.parse(run(['log', 'decision', '--limit', '1000', '--json'], { cwd: PROJECT, env: ENV }));
    for (const row of log.rows ?? []) if (row.entity && row.name) names[row.entity] ??= row.name;
  } catch { /* names are cosmetic; 0.8.0 has no log */ }

  const decisions = query('decision').map((r) => {
    const d = camelizeRow(r);
    d.id = r.this;
    d.name = names[r.this] ?? null;
    d.supersedes = d.supersedes ?? null;
    d.rejected = d.rejected ?? null;
    d.about = query('decision-about').filter((a) => a.decision === r.this).map((a) => a.target);
    return d;
  });

  const statuses = query('decision-status').map((r) => {
    const s = camelizeRow(r);
    s.id = r.this;
    s.status = unkeyword(s.status);
    return s;
  });

  const sessions = query('session').map(camelizeRow).map((s) => ({ ...s, harness: unkeyword(s.harness) }));
  const tools = query('tool').map(camelizeRow);
  const publishers = query('trusted-publisher').map(camelizeRow);
  return { changes, decisions, statuses, sessions, tools, publishers };
}

// --- views into the space ----------------------------------------------------
//
// "Write the views into the tonk": assert `view!:` facets for the recorder
// concepts so `tonk render <concept>` / `<entity>@<concept>` serve them from
// the space (tonk-dev `help views`). Templates live in views/templates/;
// facet values are YAML block scalars. NOTE: template placeholders must be
// the concept's notation field names (dash-case, e.g. `{lines-added}`) — an
// unknown placeholder (e.g. `{files}`, which is a lens, not a field) makes
// the whole eval document fail.

const TEMPLATES = join(REPO, 'views', 'templates');

const blockScalar = (text) => text.replace(/\n$/, '').split('\n').map((l) => '      ' + l).join('\n');

function viewDoc(concept, facets) {
  const lines = ['view!:', `  this: ${concept}`, '  show:'];
  for (const [facet, src] of Object.entries(facets)) {
    const text = src.endsWith('.html') ? readFileSync(src, 'utf8') : src;
    lines.push(`    ${facet}: |`);
    lines.push(blockScalar(text));
  }
  return lines.join('\n') + '\n';
}

const CHANGE_UI = `<article class="change">
  <h2><a href="{this}@change">{prompt}</a></h2>
  <p class="hint">{agent}{harness} · {at} · +{lines-added} / −{lines-removed}</p>
  <p class="hint">changed paths: the <code>change-file</code> route (lens rows)</p>
</article>`;

// one view!: document per concept, asserted in its own eval (isolation:
// a bad facet fails only its own concept)
function viewDocs() {
  return [
    viewDoc('decision', {
      directory: join(TEMPLATES, 'decision.directory.html'),
      ui: join(TEMPLATES, 'decision.ui.html'),
      label: '{title}',
      title: 'Decision — {title}',
    }),
    viewDoc('decision-status', {
      directory: join(TEMPLATES, 'decision-status.directory.html'),
      ui: join(TEMPLATES, 'decision-status.ui.html'),
      label: '{status}',
    }),
    viewDoc('change', {
      directory: join(TEMPLATES, 'change.directory.html'),
      ui: CHANGE_UI,
    }),
  ];
}

// --- main --------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const demoDir = args.demoDir;
  const home = join(demoDir, 'home');
  const site = join(demoDir, 'site');
  const project = join(demoDir, 'project');

  if (!args.keep && existsSync(demoDir)) rmSync(demoDir, { recursive: true, force: true });
  for (const d of [home, project]) mkdirSync(d, { recursive: true });

  const ENV = { HOME: home };
  globalThis.PROJECT = project;
  globalThis.ENV = ENV;
  const t = (a) => run(a, { cwd: project, env: ENV });

  console.log(`tonk binary : ${TONK}`);
  console.log(`demo dir    : ${demoDir}`);
  t(['telemetry', 'off']);
  const registered = (() => {
    try { return JSON.parse(t(['space', '--json'])).spaces ?? {}; } catch { return {}; }
  })();
  if (!registered['recorder-demo']) {
    t(['space', 'new', 'recorder-demo', '--site', site]);
    console.log('created space: recorder-demo (local-only, no upstream)');
  } else {
    console.log('space recorder-demo already registered — reusing');
  }

  // 1. the tonk-recorder concepts (structure pack, idempotent)
  const load = t(['eval', '--no-sync', '-q', join(REPO, 'packs', 'recorder.notation')]);
  console.log(`pack loaded : ${/claims: (\d+)/.exec(load)?.[1] ?? '?'} claims (0 = already loaded, no-op)`);

  // 2. sample data: W0 fixtures + demo extras (each a no-op on re-run)
  const docs = [
    ...RECORD_FIXTURES.map((f) => join(REPO, 'fixtures', 'records', `${f}.notation`)),
    join(REPO, 'demo', 'sample-extra.notation'),
  ];
  for (const doc of docs) {
    const out = t(['eval', '--no-sync', '-q', doc]);
    console.log(`asserted    : ${doc.replace(REPO + '/', '')} (${/claims: (\d+)/.exec(out)?.[1] ?? '0'} claims)`);
  }

  // 3. write the views INTO the space (view!: facets; idempotent — identical
  //    templates re-assert as no-ops)
  for (const doc of viewDocs()) {
    const out = t(['eval', '--no-sync', '-c', doc]);
    console.log(`view facet  : ${/this: (\S+)/.exec(doc)?.[1]} (${/claims: (\d+)/.exec(out)?.[1] ?? '0'} claims)`);
  }

  // 4. export the JSON mirror for the static view (views/decisions.mjs)
  const query = (concept) => JSON.parse(t(['query', concept, '--json']));
  const data = exportAll(query);
  mkdirSync(args.dataDir, { recursive: true });
  const files = {
    'changes.json': data.changes,
    'decisions.json': data.decisions,
    'decision-statuses.json': data.statuses,
    'sessions.json': data.sessions,
    'tools.json': data.tools,
    'trusted-publishers.json': data.publishers,
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(args.dataDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  let revisions = 0;
  try {
    revisions = JSON.parse(t(['log', '--limit', '1000', '--json'])).rows?.length ?? 0;
  } catch { /* 0.8.0 */ }
  writeFileSync(
    join(args.dataDir, 'meta.json'),
    JSON.stringify({ space: 'recorder-demo', site, project, tonk: TONK, revisions, exportedFrom: 'tonk query --json + log' }, null, 2) + '\n',
    'utf8',
  );

  console.log(`exported    : ${args.dataDir}`);
  console.log(
    `totals      : ${data.changes.length} changes, ${data.decisions.length} decisions, ` +
      `${data.statuses.length} statuses, ${data.sessions.length} sessions, ${revisions} revisions`,
  );

  // 5. render the in-space views headlessly as proof + for local browsing
  const rendered = join(demoDir, 'rendered');
  mkdirSync(rendered, { recursive: true });
  for (const route of ['decision', 'decision-status', 'change', 'decision-blob-diffs@decision']) {
    const file = join(rendered, route.replace(/[@!]/g, '_') + '.html');
    run(['render', route, '--out', file], { cwd: project, env: ENV });
    console.log(`rendered    : tonk render ${route} -> ${file}`);
  }

  console.log(`\nbrowse the space:  cd ${project} && HOME=${home} ${TONK} query decision --json`);
  console.log(`                   HOME=${home} ${TONK} log decision --limit 20`);
  console.log(`                   HOME=${home} ${TONK} render decision        # the view, from the space`);
  console.log(`static view     :  node views/decisions.mjs --in ${args.dataDir} --out dist/views`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
