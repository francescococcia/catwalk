// tests/b2/verify.test.mjs — unit tests for src/install/verify.mjs and the
// bootstrap block generator/parser in src/install/bootstrap.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, normalizeSha, shaMatches, toolRecordFields, latestToolRecord, trustedIdentities, isTrustedPublisher } from '../../src/install/verify.mjs';
import { bootstrapBlock, parseBootstrapBlock, BOOTSTRAP_HEADING } from '../../src/install/bootstrap.mjs';

test('sha256 helpers', () => {
  const buf = Buffer.from('hello recorder\n');
  const sha = sha256Hex(buf);
  assert.equal(sha, crypto.createHash('sha256').update(buf).digest('hex'));
  assert.ok(shaMatches(buf, sha));
  assert.ok(shaMatches(buf, 'sha256:' + sha.toUpperCase()));
  assert.ok(!shaMatches(buf, '0'.repeat(64)));
  assert.ok(!shaMatches(buf, 'not-a-hash'));
  assert.equal(normalizeSha('SHA256:ABC'), 'abc');
});

test('toolRecordFields tolerates plausible spellings', () => {
  const f = toolRecordFields({ name: 'tonk-recorder', version: '1.0.0', blobRef: 'asset:x', sha: 'a'.repeat(64), by: 'did:key:p', publishedAt: '2026-11-21T10:00:00Z' });
  assert.deepEqual(f, { name: 'tonk-recorder', version: '1.0.0', blob: 'asset:x', sha256: 'a'.repeat(64), publisher: 'did:key:p', at: '2026-11-21T10:00:00Z' });
});

test('latestToolRecord picks latest by at, ties by version', () => {
  const rows = [
    { name: 'tonk-recorder', version: '0.9.0', blob: 'asset:old', sha256: 'a'.repeat(64), publisher: 'did:key:p', at: '2026-11-20T10:00:00Z' },
    { name: 'tonk-recorder', version: '1.0.0', blob: 'asset:new', sha256: 'b'.repeat(64), publisher: 'did:key:p', at: '2026-11-21T10:00:00Z' },
    { name: 'tonk-recorder', version: '1.0.1', blob: 'asset:new2', sha256: 'c'.repeat(64), publisher: 'did:key:p', at: '2026-11-21T10:00:00Z' },
  ];
  const latest = latestToolRecord(rows);
  assert.equal(latest.version, '1.0.1');
  assert.equal(latest.blob, 'asset:new2');
  assert.equal(latestToolRecord([]), null);
  assert.equal(latestToolRecord(null), null);
});

test('trusted publisher check is exact-match on identity', () => {
  const ids = trustedIdentities([{ identity: 'did:key:alice' }, { did: 'did:key:bob' }, { this: 'did:key:carol' }]);
  assert.ok(isTrustedPublisher('did:key:alice', ids));
  assert.ok(isTrustedPublisher('did:key:carol', ids));
  assert.ok(!isTrustedPublisher('did:key:mallory', ids));
  assert.ok(!isTrustedPublisher(undefined, ids));
});

test('bootstrapBlock is the SPEC §3.3 block, verbatim shape, no links', () => {
  const block = bootstrapBlock({ wrapper: 'tonk-recorder', version: '1.0.0', blobRef: 'asset:stubXYZ', sha256: 'a'.repeat(64) });
  assert.equal(
    block,
    [
      BOOTSTRAP_HEADING,
      '',
      '```sh',
      'mkdir -p ~/.tonk/tools/tonk-recorder/1.0.0',
      'npx --yes @tonk/cli blob cat asset:stubXYZ > ~/.tonk/tools/tonk-recorder/1.0.0/tool.mjs',
      `node ~/.tonk/tools/tonk-recorder/1.0.0/tool.mjs install --expect-sha256 ${'a'.repeat(64)}`,
      '```',
      '',
    ].join('\n'),
  );
  assert.ok(!block.includes('http'), 'bootstrap block must never contain a link (SPEC §8)');
});

test('parseBootstrapBlock round-trips out of AGENTS.md markdown', () => {
  const sha = 'b'.repeat(64);
  const agents = [
    '# AGENTS.md of the space',
    '',
    'Other content a space owner added.',
    '',
    bootstrapBlock({ wrapper: 'tonk-recorder', version: '2.1.0', blobRef: 'blob:zABC123', sha256: sha }),
    '## Decisions',
    '',
    'See instructions.',
  ].join('\n');
  const parsed = parseBootstrapBlock(agents);
  assert.deepEqual(parsed, {
    wrapper: 'tonk-recorder',
    version: '2.1.0',
    blobRef: 'blob:zABC123',
    sha256: sha,
    commands: parsed.commands,
  });
  assert.equal(parsed.commands.length, 3);
  assert.equal(parseBootstrapBlock('# no block here'), null);
  assert.equal(parseBootstrapBlock(''), null);
});
