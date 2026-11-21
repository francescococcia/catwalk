// tests/r4/walkthrough.test.mjs — R4 done-when: an agent given ONLY
// instructions/decisions.md can record a decision, then supersede it, with
// plain `tonk` commands. The test executes every ```sh block in the markdown
// verbatim (in order) against a stub TONK_BIN, then checks the resulting
// space state. Fully offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, runBash, runNode, write, fakeHomeWithStub, stubCalls, stubState, REPO_ROOT, STUB_TONK } from '../h1/testkit.mjs';

const MD = path.join(REPO_ROOT, 'instructions', 'decisions.md');
const md = fs.readFileSync(MD, 'utf8');

export function shBlocks(markdown) {
  return [...markdown.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// A bin dir with `tonk` and `tonk-recorder` shims forwarding to the stub, so
// the markdown's commands run verbatim.
function makeBinDir(env) {
  const bin = tmpdir('tonk-bin-');
  write(
    path.join(bin, 'tonk'),
    '#!/bin/sh\nexec $TONK_BIN "$@"\n',
  );
  write(
    path.join(bin, 'tonk-recorder'),
    '#!/bin/sh\nif [ "$1" = "sync" ]; then $TONK_BIN pull && $TONK_BIN push; exit $?; fi\nexec $TONK_BIN "$@"\n',
  );
  fs.chmodSync(path.join(bin, 'tonk'), 0o755);
  fs.chmodSync(path.join(bin, 'tonk-recorder'), 0o755);
  return bin;
}

test('decisions.md: lint — carries everything SPEC §6.7 requires', () => {
  const lower = md.toLowerCase();
  // when: a choice between real alternatives, not routine edits
  assert.match(lower, /choice between real alternatives/);
  assert.match(lower, /not routine edits/);
  // how: one tonk eval of a decision!: assertion with the §5.2 fields
  assert.match(lower, /tonk eval/);
  assert.match(lower, /decision!:/);
  for (const f of ['title', 'chosen', 'why', 'rejected', 'about']) {
    assert.match(md, new RegExp(`\\b${f}\\b`), `field ${f} mentioned`);
  }
  // exactly one filled example: one sh block containing a decision!: example
  const exampleBlocks = shBlocks(md).filter((b) => b.includes('decision!:'));
  assert.ok(exampleBlocks.length >= 1, 'at least one filled example');
  const recordBlocks = exampleBlocks.filter(
    (b) => b.includes('&decision-') && b.includes('decision-status') && !b.includes('supersedes'),
  );
  assert.equal(recordBlocks.length, 1, 'exactly one filled record example');
  assert.equal((recordBlocks[0].match(/tonk eval/g) || []).length, 1, 'the example is ONE tonk eval');
  // how to change: supersedes, never edit
  assert.match(lower, /supersedes/);
  assert.match(lower, /never edit or retract/);
  // how to read: tonk query for accepted, tonk log decision (DEV) for history
  assert.match(md, /tonk query decision/);
  assert.match(md, /tonk log decision/);
  assert.match(md, /DEV/);
  // --no-sync like the hooks; checkpoint / wrapper sync shares it
  assert.match(md, /--no-sync/);
  assert.match(md, /sync/);
  // delivery three ways (§6.7)
  assert.match(lower, /session start/);
  assert.match(md, /AGENTS\.md/);
  assert.match(md, /tonk-recorder instructions/);
});

test('decisions.md: walkthrough — record, supersede, read, sync (stub tonk)', () => {
  const { home, state, calls, env } = fakeHomeWithStub();
  const proj = tmpdir('tonk-proj-');
  const bin = makeBinDir(env);
  const runEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };

  const blocks = shBlocks(md);
  assert.ok(blocks.length >= 4, 'expected record/supersede/read/sync blocks');

  // An agent given only the text runs the blocks top to bottom.
  for (const [i, block] of blocks.entries()) {
    const r = runBash(block, { cwd: proj, env: runEnv });
    assert.equal(r.status, 0, `sh block #${i + 1} failed:\n${block}\n--- stderr:\n${r.stderr}`);
  }

  const s = stubState(state);
  // two decisions recorded, the second superseding the first
  assert.equal(s.decisions.length, 2);
  assert.equal(s.decisions[0].title, 'Inline diffs up to 64 KB');
  assert.equal(s.decisions[1].title, 'Inline diffs up to 128 KB');
  assert.ok(s.anchors['decision-inline-diff-limit'], 'first decision anchored');
  assert.ok(s.anchors['decision-inline-diff-limit-128'], 'superseding decision anchored');
  assert.equal(s.decisions[1].supersedes, 'decision-inline-diff-limit', 'supersedes resolved by name');
  // both marked accepted via decision-status
  assert.equal(s.statuses.length, 2);
  assert.ok(s.statuses.every((r) => r.status === 'accepted'));

  // the read commands in the text were actually exercised
  const argv = stubCalls(calls);
  assert.ok(argv.some((a) => a[0] === 'eval' && a.includes('--no-sync')), 'eval used --no-sync');
  assert.ok(argv.some((a) => a[0] === 'query' && a[1] === 'decision' && a.includes('--json')), 'query decision --json');
  assert.ok(
    argv.some((a) => a[0] === 'query' && a[1] === 'decision-status' && a.some((x) => x.includes('status=accepted'))),
    'query decision-status --where status=accepted',
  );
  assert.ok(argv.some((a) => a[0] === 'log' && a[1] === 'decision'), 'tonk log decision (DEV)');
  assert.ok(argv.some((a) => a[0] === 'pull') && argv.some((a) => a[0] === 'push'), 'sync checkpoint ran pull+push');

  // and reading back through the stub answers correctly
  const q = runNode(STUB_TONK, ['query', 'decision', '--json'], { cwd: proj, env: runEnv });
  assert.equal(q.status, 0);
  const rows = JSON.parse(q.stdout);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.title === 'Inline diffs up to 128 KB'));
});
