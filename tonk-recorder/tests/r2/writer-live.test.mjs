// tests/r2/writer-live.test.mjs — R2 against the REAL tonk 0.8.0, fully
// offline (fake HOME + local-only space, no upstream = network off).
// Done-when: fixtures write + read back with the network off; an offline
// checkpoint returns within timeout and loses nothing; idempotency holds.
// Skips cleanly when no tonk binary is available (TONK_BIN overrides).
// Run: node --test 'tests/r2/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TOOL = join(ROOT, 'src/writer/tool.mjs');
const PACK = join(ROOT, 'packs/recorder.notation');
const TONK = process.env.TONK_BIN || 'tonk';

function tonkAvailable() {
  try { execFileSync(TONK, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

test('live tonk (offline): fixtures write + read back; idempotent; offline checkpoint fail-soft', { skip: !tonkAvailable() && 'no tonk binary (set TONK_BIN)' }, () => {
  const fake = fs.mkdtempSync(join(os.tmpdir(), 'r2-live-'));
  const home = join(fake, 'home');
  const proj = join(fake, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const env = { ...process.env, HOME: home, DO_NOT_TRACK: '1', DATA_ROOT: join(fake, 'data') };
  const t = (args, opts = {}) => execFileSync(TONK, args, { cwd: proj, env: { ...env, ...opts.env }, encoding: 'utf8', timeout: 60_000 });

  t(['telemetry', 'off']);
  t(['space', 'new', 'r2live', '--site', join(fake, 'site')]); // local-only: no upstream, network off
  t(['eval', '--no-sync', '-q', PACK]); // load the structure pack (S1)

  const change001 = JSON.parse(fs.readFileSync(join(ROOT, 'fixtures/records/change-001.json'), 'utf8'));
  const change002 = JSON.parse(fs.readFileSync(join(ROOT, 'fixtures/records/change-002-secret.json'), 'utf8'));

  const run = (code) => execFileSync('node', ['-e', code], { cwd: proj, env, encoding: 'utf8', timeout: 60_000 });

  // 1. write both fixture changes through the writer (network off)
  const w1 = JSON.parse(run(`import(${JSON.stringify('file://' + TOOL)}).then((m) => process.stdout.write(JSON.stringify(m.writeChange(${JSON.stringify(change001)}, { cwd: ${JSON.stringify(proj)} }))))`));
  assert.equal(w1.bound, true);
  assert.equal(w1.written, true);
  assert.match(w1.revisionAfter, /^did:key:/);
  const w2 = JSON.parse(run(`import(${JSON.stringify('file://' + TOOL)}).then((m) => process.stdout.write(JSON.stringify(m.writeChange(${JSON.stringify(change002)}, { cwd: ${JSON.stringify(proj)} }))))`));
  assert.equal(w2.written, true);
  assert.match(w2.blob, /^blob:/, 'secret/1k-style record with diffBlob passes through');

  // 2. read back with tonk (network off)
  const changes = JSON.parse(t(['query', 'change', '--json']));
  assert.equal(changes.length, 2);
  const files = JSON.parse(t(['query', 'change-file', '--json']));
  assert.equal(files.length, 6);
  const t1 = changes.find((c) => c.turn === 'turn-1');
  assert.equal(t1.agent, 'hermes');
  assert.equal(t1.harness, 'vibe:');
  assert.equal(t1['lines-added'], 150);
  assert.ok(t1.diff.includes('diff --git'), 'inline diff stored');

  // 3. idempotency: re-writing the same turn is a no-op
  const w1again = JSON.parse(run(`import(${JSON.stringify('file://' + TOOL)}).then((m) => process.stdout.write(JSON.stringify(m.writeChange(${JSON.stringify(change001)}, { cwd: ${JSON.stringify(proj)} }))))`));
  assert.equal(w1again.written, false);
  assert.equal(w1again.duplicate, true);
  assert.equal(JSON.parse(t(['query', 'change', '--json'])).length, 2, 'still exactly 2 changes');

  // 4. offline checkpoint: no upstream → pull/push fail fast; returns within
  //    timeout, throws nothing, loses nothing
  const t0 = Date.now();
  const cp = JSON.parse(run(`import(${JSON.stringify('file://' + TOOL)}).then((m) => process.stdout.write(JSON.stringify(m.checkpointSync({ cwd: ${JSON.stringify(proj)}, pullTimeoutMs: 5_000, pushTimeoutMs: 5_000, pushDelayMinMs: 0, pushDelayMaxMs: 0, random: () => 0 }))))`));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 15_000, `checkpoint returned within timeout (took ${elapsed} ms)`);
  assert.equal(cp.ok, false, 'no upstream → not ok, but fail-soft');
  assert.equal(JSON.parse(t(['query', 'change', '--json'])).length, 2, 'nothing lost — records still local');
});
