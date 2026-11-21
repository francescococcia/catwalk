// tests/r2/writer-stub.test.mjs — R2 done-when against a STUB tonk
// (TONK_BIN=tests/r2/fixtures/stub-tonk.mjs), fully offline:
//   • fixtures write + read back with the "network" off (stub)
//   • idempotency by turn id: a repeated write is a no-op (exactly once)
//   • diff > 64 KB goes via `blob add` and is referenced as blob:<hash>
//   • an offline (hanging) checkpoint returns within the timeout and loses
//     nothing; the NEXT checkpoint delivers everything exactly once
//   • the per-space writer lock serialises concurrent writers
//   • tonk's own lock error (exit 4) is retried
//   • unbound directory → no-op
// Run: node --test 'tests/r2/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TOOL = join(ROOT, 'src/writer/tool.mjs');
const STUB = join(HERE, 'fixtures/stub-tonk.mjs');
const FIX = join(ROOT, 'fixtures');

function mkEnv(state) {
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  return {
    TONK_BIN: STUB,
    STUB_STATE: state,
    DATA_ROOT: join(state, 'data'),
    DO_NOT_TRACK: '1',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
}

const evals = (state) => {
  try { return fs.readFileSync(join(state, 'evals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const syncs = (state) => {
  try { return fs.readFileSync(join(state, 'syncs.log'), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
};
const change001 = JSON.parse(fs.readFileSync(join(FIX, 'records/change-001.json'), 'utf8'));

function cliWrite(state, record, extraEnv = {}) {
  const recFile = join(state, 'rec.json');
  fs.writeFileSync(recFile, JSON.stringify(record));
  try {
    return execFileSync('node', [TOOL, 'write-change', recFile], {
      encoding: 'utf8', env: { ...mkEnv2(state), ...extraEnv }, cwd: state, timeout: 30_000,
    });
  } catch (e) {
    console.error('cliWrite failed status=', e.status, 'stderr=', e.stderr, 'stdout=', e.stdout);
    throw e;
  }
}
// mkEnv but without wiping (write path needs the state to persist)
function mkEnv2(state) {
  return { TONK_BIN: STUB, STUB_STATE: state, DATA_ROOT: join(state, 'data'), DO_NOT_TRACK: '1', PATH: process.env.PATH, HOME: process.env.HOME };
}

test('write-change: writes one eval per turn; repeat is a no-op (idempotent by turn id)', () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  const out1 = JSON.parse(cliWrite(state, change001));
  assert.equal(out1.written, true);
  assert.equal(out1.bound, true);
  assert.equal(out1.duplicate, undefined);
  let docs = evals(state);
  assert.equal(docs.length, 1, 'exactly one eval for the turn');
  assert.match(docs[0], /change!:.*this: \?c/s);
  assert.ok(docs[0].includes('diff: "diff --git'), 'inline diff (≤ 64 KB)');
  assert.ok(!docs[0].includes('diff-blob:'));

  const out2 = JSON.parse(cliWrite(state, change001));
  assert.equal(out2.written, false);
  assert.equal(out2.duplicate, true, 'query by turn id before re-writing (§6.4)');
  assert.equal(evals(state).length, 1, 'still exactly one eval — nothing duplicated');
});

test('write-change: diff > 64 KB goes via blob add, referenced as blob:<hash>', () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  const bigDiff = fs.readFileSync(join(FIX, 'diffs/big-1k-line.diff'), 'utf8');
  const rec = { ...change001, turn: 'turn-big', diff: bigDiff, diffBlob: null };
  const out = JSON.parse(cliWrite(state, rec));
  assert.equal(out.written, true);
  assert.match(out.blob, /^blob:[0-9a-f]{64}$/, 'normalised to blob: spelling');
  const [doc] = evals(state);
  assert.ok(doc.includes(`diff-blob: ${out.blob}`), 'doc references the blob');
  assert.ok(!/\n {2}diff:/.test(doc), 'no inline diff above 64 KB');
  // blob round-trips through the stub's blob cat
  const cat = execFileSync(STUB, ['blob', 'cat', out.blob], { env: mkEnv2(state), encoding: 'utf8' });
  assert.equal(cat, bigDiff, 'blob cat returns the original diff bytes');
});

test('write-change: unbound directory → no-op, nothing written (§6.1)', () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  const out = JSON.parse(cliWrite(state, change001, { STUB_UNBOUND: '1' }));
  assert.equal(out.bound, false);
  assert.equal(out.written, false);
  assert.equal(evals(state).length, 0);
});

test('write-change: tonk lock error (exit 4) is retried, then succeeds', () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  const out = JSON.parse(cliWrite(state, change001, { STUB_LOCKERR: '1' }));
  assert.equal(out.written, true, 'retried past the revision.lock error');
  assert.equal(evals(state).length, 1);
});

test('checkpoint: hanging pull/push returns within the timeout, loses nothing; next checkpoint delivers exactly once', () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  // seed one record first (local write, no sync)
  cliWrite(state, change001);
  assert.equal(evals(state).length, 1);

  // offline checkpoint: pull+push hang → hard timeout 400 ms each, zero delay
  const t0 = Date.now();
  const env = { ...mkEnv2(state), STUB_HANG: 'pull,push' };
  const res = execFileSync('node', ['-e', `
    import(${JSON.stringify('file://' + TOOL)}).then((m) => {
      const out = m.checkpointSync({ cwd: ${JSON.stringify(state)}, pullTimeoutMs: 400, pushTimeoutMs: 400, pushDelayMinMs: 0, pushDelayMaxMs: 0, random: () => 0 });
      process.stdout.write(JSON.stringify(out));
    });
  `], { encoding: 'utf8', env, timeout: 30_000 });
  const elapsed = Date.now() - t0;
  const rep = JSON.parse(res);
  assert.ok(elapsed < 5_000, `returned within timeout+slack (took ${elapsed} ms)`);
  assert.equal(rep.pull.timedOut, true, 'pull hit the hard timeout');
  assert.equal(rep.push.timedOut, true, 'push hit the hard timeout');
  assert.equal(rep.ok, false);
  assert.equal(evals(state).length, 1, 'nothing lost — the record is still local');
  assert.equal(syncs(state).length, 2, 'both pull and push were attempted');

  // next checkpoint with the network back: delivers everything exactly once
  const res2 = execFileSync('node', ['-e', `
    import(${JSON.stringify('file://' + TOOL)}).then((m) => {
      const out = m.checkpointSync({ cwd: ${JSON.stringify(state)}, pullTimeoutMs: 5_000, pushTimeoutMs: 5_000, pushDelayMinMs: 0, pushDelayMaxMs: 0, random: () => 0 });
      process.stdout.write(JSON.stringify(out));
    });
  `], { encoding: 'utf8', env: mkEnv2(state), timeout: 30_000 });
  const rep2 = JSON.parse(res2);
  assert.equal(rep2.ok, true);
  assert.equal(rep2.pull.ok, true);
  assert.equal(rep2.push.ok, true);
  assert.deepEqual(syncs(state), ['pull', 'push', 'pull', 'push'], 'exactly one pull+push per checkpoint — no duplicates');
  assert.equal(evals(state).length, 1, 'no record was re-written or lost across checkpoints');
});

test('writer lock serialises concurrent processes (no interleaved/corrupt writes)', async () => {
  const state = fs.mkdtempSync(join(os.tmpdir(), 'r2-stub-'));
  const env = { ...mkEnv2(state), STUB_EVAL_DELAY: '300' };
  const recA = join(state, 'a.json'); fs.writeFileSync(recA, JSON.stringify({ ...change001, turn: 'turn-a' }));
  const recB = join(state, 'b.json'); fs.writeFileSync(recB, JSON.stringify({ ...change001, turn: 'turn-b' }));
  const run = (rec) => new Promise((resolve) => {
    const p = spawn('node', [TOOL, 'write-change', rec], { env, cwd: state });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const [ra, rb] = await Promise.all([run(recA), run(recB)]);
  assert.equal(ra.code, 0); assert.equal(rb.code, 0);
  assert.equal(JSON.parse(ra.out).written, true);
  assert.equal(JSON.parse(rb.out).written, true);
  const docs = evals(state);
  assert.equal(docs.length, 2, 'both turns written exactly once despite concurrency');
  assert.ok(docs.some((d) => d.includes('turn: "turn-a"')) && docs.some((d) => d.includes('turn: "turn-b"')));
});
