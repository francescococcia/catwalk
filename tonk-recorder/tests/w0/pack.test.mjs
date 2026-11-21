// tests/w0/pack.test.mjs — S1 verification, run offline against real tonk.
//
// Done-when (SPEC §9.2 S1): packs/recorder.notation loads into an EMPTY
// space; fixtures assert and query back; the load is idempotent (schema
// versioned) and the whole thing replays from empty (each run uses a fresh
// fake HOME + local-only space, no network).
//
// Run: node --test 'tests/w0/*.test.mjs'
// Skips cleanly when no tonk binary is available (TONK_BIN overrides).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TONK = process.env.TONK_BIN || 'tonk';

function tonkAvailable() {
  try {
    execFileSync(TONK, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function run(args, opts = {}) {
  return execFileSync(TONK, args, {
    encoding: 'utf8',
    env: { ...process.env, DO_NOT_TRACK: '1', ...opts.env },
    cwd: opts.cwd,
    timeout: 60_000,
  });
}

const PACK = join(ROOT, 'packs', 'recorder.notation');
const FIX = join(ROOT, 'fixtures', 'records');
const RECORD_FIXTURES = [
  'change-001', 'change-002-secret', 'decision-001', 'decision-002-supersedes',
  'decision-status-001', 'session-001', 'tool-001', 'trusted-publisher-001',
];

test('S1: pack loads into an empty space, fixtures assert + query back, replay from empty', { skip: !tonkAvailable() && 'no tonk binary (set TONK_BIN)' }, () => {
  const fake = mkdtempSync(join(tmpdir(), 'tonk-s1-test-'));
  const home = join(fake, 'home');
  const proj = join(fake, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const env = { HOME: home };
  const t = (args) => run(args, { cwd: proj, env });

  // local-only space, no network
  t(['telemetry', 'off']);
  t(['space', 'new', 's1test', '--site', join(fake, 'site')]);

  // 1. load the pack into the empty space
  const load = t(['eval', '--no-sync', '-q', PACK]);
  assert.match(load, /claims: \d+/, 'pack commits claims');

  // schema version is queryable
  const ver = t(['eval', '-c', 'tonk.recorder.pack:\n  this: id:tonk-recorder-pack\n  schema-version: ?v']);
  assert.match(ver, /schema-version: 1/);

  // idempotent reload: same revision before/after
  const before = t(['eval', '--no-sync', '-q', PACK]);
  const rev = (s) => [...s.matchAll(/revision-(?:before|after): (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(rev(before), [rev(before)[0], rev(before)[0]], 'reload commits nothing');

  // 2. fixtures assert (one eval each) and query back
  for (const f of RECORD_FIXTURES) {
    t(['eval', '--no-sync', '-q', join(FIX, `${f}.notation`)]);
  }
  const q = (concept, where) =>
    JSON.parse(t(['query', concept, '--json', ...(where ? ['--where', where] : [])]));
  assert.equal(q('change').length, 2, 'both change fixtures');
  assert.equal(q('change-file').length, 6, 'lens rows');
  assert.equal(q('decision').length, 2);
  assert.equal(q('decision-about').length, 1);
  assert.equal(q('decision-status').length, 1);
  assert.equal(q('session').length, 1);
  assert.equal(q('tool').length, 1);
  assert.equal(q('trusted-publisher').length, 1);

  // content spot-checks
  const [big] = q('change', 'turn=turn-2');
  assert.equal(big.redacted, true);
  assert.match(big['diff-blob'], /^blob:/);
  assert.equal(big.diff, undefined, 'no inline diff on the blob change');
  const [small] = q('change', 'turn=turn-1');
  assert.ok(typeof small.diff === 'string' && small.diff.includes('diff --git'), 'inline diff');
  const decs = q('decision');
  const superseding = decs.find((d) => d.supersedes);
  assert.ok(superseding, 'supersedes resolves to the earlier decision entity');
  assert.match(superseding.supersedes, /^did:key:/);
  const [status] = q('decision-status');
  assert.equal(status.status, 'accepted:');
  const [tool] = q('tool');
  assert.match(tool.sha256, /^[0-9a-f]{64}$/);
  assert.match(tool.publisher, /^did:key:/);

  // 3. replay from empty: a second fresh space, same steps, same answers
  const fake2 = mkdtempSync(join(tmpdir(), 'tonk-s1-replay-'));
  mkdirSync(join(fake2, 'home'), { recursive: true });
  mkdirSync(join(fake2, 'proj'), { recursive: true });
  const env2 = { HOME: join(fake2, 'home') };
  const t2 = (args) => run(args, { cwd: join(fake2, 'proj'), env: env2 });
  t2(['telemetry', 'off']);
  t2(['space', 'new', 'replay', '--site', join(fake2, 'site')]);
  t2(['eval', '--no-sync', '-q', PACK]);
  for (const f of RECORD_FIXTURES) t2(['eval', '--no-sync', '-q', join(FIX, `${f}.notation`)]);
  const q2 = (c) => JSON.parse(t2(['query', c, '--json']));
  assert.equal(q2('change').length, 2);
  assert.equal(q2('decision').length, 2);
  assert.equal(q2('change-file').length, 6);
});

test('pack file declares the six concepts, two lenses and schema version 1', () => {
  const pack = readFileSync(PACK, 'utf8');
  for (const c of ['&change"', '&change-file"', '&decision"', '&decision-about"', '&decision-status"', '&session"', '&tool"', '&trusted-publisher"']) {
    assert.ok(pack.includes(`concept!: ${c.slice(0, -1)}`), `pack missing concept! ${c}`);
  }
  assert.match(pack, /schema-version: 1/);
  assert.match(pack, /tonk\.recorder\.pack!:/);
  // every concept has at least one attribute defined in the pack
  const concepts = [...pack.matchAll(/concept!: &([a-z-]+)/g)].map((m) => m[1]);
  assert.equal(concepts.length, 8);
  const attrs = new Set([...pack.matchAll(/attribute!: &([a-z-]+)/g)].map((m) => m[1]));
  assert.ok(attrs.size >= 30, 'all fields declared');
  // fixture dir matches the expected record set
  assert.deepEqual(readdirSync(FIX).filter((f) => f.endsWith('.notation')).map((f) => f.replace('.notation', '')).sort(), [...RECORD_FIXTURES].sort());
});
