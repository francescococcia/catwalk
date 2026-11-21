// tests/r4/real-tonk.test.mjs — OPTIONAL, off by default: run the exact
// example documents from instructions/decisions.md against a REAL tonk
// (0.8.0) local `--site` space (fully offline, fake HOME). Enable with:
//
//   TONK_REAL_BIN="$(which tonk)" node --test tests/r4/real-tonk.test.mjs
//
// Skipped when TONK_REAL_BIN is unset or the binary is missing, so the
// default `node --test` run stays hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, run, write, REPO_ROOT } from '../h1/testkit.mjs';
import { shBlocks } from './walkthrough.test.mjs';

const REAL = process.env.TONK_REAL_BIN;
const hasReal = !!REAL && fs.existsSync(REAL);

// Minimal structure pack for decision + decision-status (SPEC §5.2 shape;
// the real pack is S1's packs/recorder.notation — integration point).
const PACK = `
attribute!: &decision-title
  description: "One-line title of a decision"
  the: xyz.tonk.recorder/decision-title
  as: text
attribute!: &decision-chosen
  description: "What was decided"
  the: xyz.tonk.recorder/decision-chosen
  as: text
attribute!: &decision-why
  description: "The reasoning"
  the: xyz.tonk.recorder/decision-why
  as: text
attribute!: &decision-rejected
  description: "Alternatives considered"
  the: xyz.tonk.recorder/decision-rejected
  as: text
attribute!: &decision-about
  description: "Files, areas or change records this relates to"
  the: xyz.tonk.recorder/decision-about
  as: text
  pick: :all
attribute!: &decision-supersedes
  description: "An earlier decision this one replaces"
  the: xyz.tonk.recorder/decision-supersedes
  as: entity
attribute!: &decision-by
  description: "Agent or person who recorded it"
  the: xyz.tonk.recorder/decision-by
  as: text
attribute!: &decision-at
  description: "Timestamp"
  the: xyz.tonk.recorder/decision-at
  as: text
concept!: &decision
  description: "A decision recorded by hand"
  with:
    title: decision-title
    chosen: decision-chosen
    why: decision-why
    by: decision-by
    at: decision-at
  maybe:
    rejected: decision-rejected
    about: decision-about
    supersedes: decision-supersedes
attribute!: &status-decision
  description: "The decision this status is about"
  the: xyz.tonk.recorder/status-decision
  as: entity
attribute!: &status-status
  description: "proposed / accepted / rejected"
  the: xyz.tonk.recorder/status-status
  as: text
attribute!: &status-by
  description: "Who set the status"
  the: xyz.tonk.recorder/status-by
  as: text
attribute!: &status-at
  description: "When"
  the: xyz.tonk.recorder/status-at
  as: text
concept!: &decision-status
  description: "Add-only status of a decision"
  with:
    decision: status-decision
    status: status-status
    by: status-by
    at: status-at
`;

function extractEvalDocs(blocks) {
  // pull the single-quoted -c '...' documents out of `tonk eval ... -c '...'` blocks
  const docs = [];
  for (const b of blocks) {
    for (const m of b.matchAll(/tonk eval[^\n]*-c '\n?([\s\S]*?)'\n/g)) docs.push(m[1]);
  }
  return docs;
}

test('real tonk 0.8.0 accepts the decisions.md example docs', { skip: !hasReal && 'TONK_REAL_BIN not set' }, () => {
  const home = tmpdir('tonk-real-home-');
  const proj = tmpdir('tonk-real-proj-');
  const env = { ...process.env, HOME: home };
  const tonk = (args, opts = {}) => run(REAL, args, { ...opts, env: opts.env ?? env, cwd: opts.cwd ?? proj });

  // local-only space (no remote => no network)
  assert.equal(tonk(['space', 'new', 'lab', '--site', path.join(home, 'site')]).status, 0);
  write(path.join(home, 'pack.notation'), PACK);
  assert.equal(tonk(['eval', '--no-sync', path.join(home, 'pack.notation')]).status, 0);

  const md = fs.readFileSync(path.join(REPO_ROOT, 'instructions', 'decisions.md'), 'utf8');
  const docs = extractEvalDocs(shBlocks(md));
  assert.ok(docs.length >= 3, 'expected record + extra-about + supersede docs');

  for (const [i, doc] of docs.entries()) {
    const f = write(path.join(home, `doc-${i}.notation`), doc);
    const r = tonk(['eval', '--no-sync', f]);
    assert.equal(r.status, 0, `doc #${i + 1} rejected by real tonk:\n${doc}\n${r.stderr}`);
  }

  const q = tonk(['query', 'decision', '--json']);
  assert.equal(q.status, 0);
  const rows = JSON.parse(q.stdout);
  const titles = rows.map((r) => r.title);
  assert.ok(titles.includes('Inline diffs up to 64 KB'));
  assert.ok(titles.includes('Inline diffs up to 128 KB'));
  // supersedes resolved to the first decision's entity
  const second = rows.find((r) => r.title === 'Inline diffs up to 128 KB');
  assert.match(String(second.supersedes), /^did:key:/);

  const qs = tonk(['query', 'decision-status', '--where', 'status=accepted', '--json']);
  assert.equal(qs.status, 0);
  assert.equal(JSON.parse(qs.stdout).length, 2);

  // DEV commands are absent in 0.8.0 — document that here
  assert.notEqual(tonk(['log', 'decision']).status, 0);
});
