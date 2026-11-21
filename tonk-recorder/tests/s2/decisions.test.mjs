// tests/s2/decisions.test.mjs — decision-history view (views/decisions.mjs):
// loads the exported JSON mirror, folds current status (latest `at` per
// decision) and supersede chains, and renders static HTML (decision list,
// decision detail, merged timeline, reused change log) with working links.
// Fully offline against tests/s2/fixtures/decisions/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDemoData, DataError } from '../../views/lib/decisions.mjs';
import { renderAllDecisions, renderDecisionList, renderDecisionDetail, renderTimeline } from '../../views/decisions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA = join(HERE, 'fixtures', 'decisions');
const CLI = join(REPO, 'views', 'decisions.mjs');

// ---------- unit: load + fold ----------

test('loadDemoData folds statuses, supersede chains and the timeline', () => {
  const m = loadDemoData(DATA);
  assert.equal(m.decisions.length, 3);
  assert.equal(m.changes.length, 2);
  assert.equal(m.statuses.length, 5);
  // decisions newest first
  assert.deepEqual(m.decisions.map((d) => d.slug), ['decision-writer-lock', 'decision-checkpoint-sync', 'decision-sync-every-turn']);
  // current status = latest status record by at (contracts/records.md)
  assert.equal(m.currentStatusOf('did:key:zDec1'), 'rejected');
  assert.equal(m.currentStatusOf('did:key:zDec2'), 'accepted');
  assert.equal(m.currentStatusOf('did:key:zDec3'), 'accepted');
  assert.equal(m.currentStatusOf('did:key:zNone'), null);
  // status history oldest first
  assert.deepEqual(m.statusHistoryOf('did:key:zDec1').map((s) => s.status), ['proposed', 'rejected']);
  // supersede chain
  assert.equal(m.supersededBy.get('did:key:zDec1')?.id, 'did:key:zDec2');
  // about target that is a change entity resolves
  assert.equal(m.changeByEntity.get('did:key:zChange1')?.id, 'sess-1:turn-1');
  // timeline merges all three kinds, newest first
  assert.equal(m.timeline.length, 10);
  assert.deepEqual(m.timeline.slice(0, 2).map((e) => e.kind), ['status', 'status']);
  assert.ok(m.timeline.every((e, i, a) => i === 0 || Date.parse(a[i - 1].at) >= Date.parse(e.at)));
});

test('loadDemoData rejects a missing data dir with a helpful error', () => {
  assert.throws(() => loadDemoData(join(DATA, 'nope')), (e) => e instanceof DataError && /seed-space/.test(e.message));
});

// ---------- render ----------

function renderToTmp(t) {
  const out = mkdtempSync(join(tmpdir(), 's2-decisions-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const model = loadDemoData(DATA);
  const written = renderAllDecisions(model, { out, base: '.' });
  return { out, model, written };
}

test('decision list is newest first with current-status badges and supersedes links', () => {
  const m = loadDemoData(DATA);
  const html = renderDecisionList(m, '.');
  const titles = [...html.matchAll(/class="dec-title"><a href="([^"]+)">([^<]+)/g)];
  assert.deepEqual(titles.map((t) => t[1]), ['decision-writer-lock.html', 'decision-checkpoint-sync.html', 'decision-sync-every-turn.html']);
  assert.match(html, /ds-accepted/);
  assert.match(html, /ds-rejected/);
  // supersedes chip links to the earlier decision
  assert.match(html, /supersedes → <a href="\.\.\/decisions\/decision-sync-every-turn\.html">/);
  // about chip for the change entity links to the change page
  assert.match(html, /href="\.\.\/changes\/change\/sess-1_turn-1\.html"/);
});

test('decision detail shows full status history, supersede chain, related changes', () => {
  const m = loadDemoData(DATA);
  const d1 = m.decisionById.get('did:key:zDec1');
  const html = renderDecisionDetail(m, d1, '.');
  assert.match(html, /Sync the space at every turn/);
  assert.match(html, /status-history/);
  assert.match(html, /proposed/);
  assert.match(html, /rejected/);
  // superseded by the checkpoint decision
  assert.match(html, /superseded by → <a href="decision-checkpoint-sync\.html">/);
  const d3 = m.decisionById.get('did:key:zDec3');
  const html3 = renderDecisionDetail(m, d3, '.');
  assert.match(html3, /Related changes/);
  assert.match(html3, /href="\.\.\/changes\/change\/sess-1_turn-1\.html"/);
  assert.match(html3, /Add the hook runtime/);
});

test('timeline interleaves changes, decisions and status events newest first', () => {
  const m = loadDemoData(DATA);
  const html = renderTimeline(m, '.');
  const kinds = [...html.matchAll(/class="kind (k-\w+)"/g)].map((x) => x[1]);
  // newest first: 13:45 st, 13:41 st, 13:40 dec, 12:35 st, 12:30 dec, 12:25 st, 12:21 st, 12:20 dec, 12:05 chg, 12:00 chg
  assert.deepEqual(kinds, ['k-status', 'k-status', 'k-decision', 'k-status', 'k-decision', 'k-status', 'k-status', 'k-decision', 'k-change', 'k-change']);
  assert.match(html, /href="\.\/decisions\/decision-writer-lock\.html"/);
  assert.match(html, /href="\.\/changes\/change\/sess-1_turn-2\.html"/);
});

test('renderAllDecisions writes all pages and every internal link resolves', (t) => {
  const { out, written } = renderToTmp(t);
  for (const rel of ['index.html', 'decisions/index.html', 'decisions/decision-sync-every-turn.html', 'timeline.html', 'changes/index.html', 'changes/change/sess-1_turn-1.html']) {
    assert.ok(existsSync(join(out, rel)), `missing ${rel}`);
  }
  assert.equal(written.length, 1 + 1 + 3 + 1 + 2 + 1); // home, list, 3 details, timeline, changes list+2 details... (list+2)=3
  // walk every html file, resolve relative hrefs
  const seen = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f.endsWith('.html')) seen.push(p);
      else if (existsSync(p) && readdirSync(p)) walk(p);
    }
  };
  walk(out);
  let checked = 0;
  for (const p of seen) {
    const html = readFileSync(p, 'utf8');
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const h = m[1];
      if (h.includes('://') || h.startsWith('#') || h.startsWith('./blob/')) continue; // space-served route
      checked++;
      assert.ok(existsSync(resolve(dirname(p), decodeURIComponent(h))), `broken link in ${p}: ${h}`);
    }
  }
  assert.ok(checked > 20, `expected many links, checked ${checked}`);
});

test('CLI end-to-end: node views/decisions.mjs --in <data> --out <tmp> prints a JSON summary', (t) => {
  const out = mkdtempSync(join(tmpdir(), 's2-decisions-cli-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [CLI, '--in', DATA, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.decisions, 3);
  assert.equal(summary.changes, 2);
  assert.equal(summary.statuses, 5);
  assert.equal(summary.timelineEvents, 10);
  assert.ok(existsSync(join(out, 'decisions', 'index.html')));
});

test('CLI fails with a hint when the data dir is missing', () => {
  const r = spawnSync(process.execPath, [CLI, '--in', '/nonexistent-dir', '--out', '/tmp/whatever'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /seed-space/);
});
