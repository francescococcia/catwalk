// tests/b2/join.test.mjs — B2 join flow (SPEC §3.2) against a stub TONK_BIN:
// tonk join → latest tool record → trusted-publisher check → blob cat →
// sha256 verify → stage → H1 install. Refusals: tampered blob (exit 2),
// untrusted publisher (exit 3), no tool record (exit 4). The invite link is
// never written into any file (SPEC §8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, tree, read, sha256Hex, fakeHomeWithStub, stubCalls, assertNoFileContains, TOOL_MJS, REPO_ROOT } from '../h1/testkit.mjs';

const JOIN_MJS = path.join(REPO_ROOT, 'src', 'install', 'join.mjs');
const LINK = 'TEST-INVITE-PLACEHOLDER-NOT-A-REAL-LINK';
const PUBLISHER = 'did:key:stubPublisher';

function makeSpace({ tamper = false, trusted = [PUBLISHER], toolRecords } = {}) {
  const fx = fakeHomeWithStub();
  const toolBytes = fs.readFileSync(TOOL_MJS);
  const sha = sha256Hex(toolBytes);
  const blobRef = 'asset:stub' + sha.slice(0, 24);
  const blobFile = path.join(fx.dir, 'logic-blob.mjs');
  fs.writeFileSync(blobFile, tamper ? Buffer.concat([toolBytes, Buffer.from('// tampered\n')]) : toolBytes);
  const records = toolRecords ?? [
    { name: 'tonk-recorder', version: '0.9.0', blob: 'asset:stubOld', sha256: 'f'.repeat(64), publisher: PUBLISHER, at: '2026-11-20T10:00:00Z' },
    { name: 'tonk-recorder', version: '1.0.0', blob: blobRef, sha256: sha, publisher: PUBLISHER, at: '2026-11-21T10:00:00Z' },
  ];
  fs.writeFileSync(
    fx.state,
    JSON.stringify({ blobs: { [blobRef]: blobFile }, tool: records, trusted, agents: '', evals: [], anchors: {}, decisions: [], statuses: [] }, null, 2),
  );
  return { ...fx, sha, blobRef };
}

function join(fx, proj) {
  return runNode(JOIN_MJS, ['join', LINK, '--agent-name', 'agent-x', '--home', fx.home, '--cwd', proj], { env: fx.env });
}

test('join: happy path installs the verified logic as a Vibe plugin', () => {
  const fx = makeSpace();
  const proj = tmpdir('tonk-proj-');
  const r = join(fx, proj);
  assert.equal(r.status, 0, r.stderr);

  // staged verified logic
  const staged = path.join(fx.home, '.tonk', 'tools', 'tonk-recorder', '1.0.0', 'tool.mjs');
  assert.ok(fs.existsSync(staged), 'staged tool.mjs');
  assert.equal(sha256Hex(fs.readFileSync(staged)), fx.sha);

  // H1 plugin layout installed, version from the tool record (latest record won)
  const pd = path.join(fx.home, '.vibe', 'plugins', 'tonk-recorder');
  assert.deepEqual(tree(pd), ['ai.mistral.vibe/', 'ai.mistral.vibe/hooks.toml', 'plugin.json', 'tool.mjs']);
  assert.ok(read(path.join(pd, 'plugin.json')).includes('"version": "1.0.0"'));
  assert.equal(sha256Hex(fs.readFileSync(path.join(pd, 'tool.mjs'))), fx.sha);
  assert.ok(read(path.join(pd, 'ai.mistral.vibe', 'hooks.toml')).includes('tonk-post-agent'));

  // the flow used the right tonk commands, in the right order
  const firstCmds = stubCalls(fx.calls).map((a) => a[0]).slice(0, 4);
  assert.deepEqual(firstCmds, ['join', 'query', 'query', 'blob']);
  assert.ok(stubCalls(fx.calls).some((a) => a[0] === 'join' && a.includes(LINK) && a.includes('agent-x')));
  assert.ok(stubCalls(fx.calls).some((a) => a[0] === 'query' && a[1] === 'tool' && a.includes('--json')));
  assert.ok(stubCalls(fx.calls).some((a) => a[0] === 'blob' && a[1] === 'cat' && a[2] === fx.blobRef));

  // SPEC §8: the invite link never lands in any file
  assertNoFileContains(fx.home, LINK);
  assertNoFileContains(proj, LINK);
});

test('join: tampered blob is refused (exit 2), nothing installed', () => {
  const fx = makeSpace({ tamper: true });
  const proj = tmpdir('tonk-proj-');
  const r = join(fx, proj);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(fx.home, '.vibe')), false);
  assert.equal(fs.existsSync(path.join(fx.home, '.tonk')), false);
});

test('join: untrusted publisher is refused (exit 3), nothing installed', () => {
  const fx = makeSpace({ trusted: ['did:key:someoneElse'] });
  const proj = tmpdir('tonk-proj-');
  const r = join(fx, proj);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not a trusted publisher/);
  assert.equal(fs.existsSync(path.join(fx.home, '.vibe')), false);
  assert.equal(fs.existsSync(path.join(fx.home, '.tonk')), false);
});

test('join: no tool record (exit 4)', () => {
  const fx = makeSpace({ toolRecords: [] });
  const proj = tmpdir('tonk-proj-');
  const r = join(fx, proj);
  assert.equal(r.status, 4);
  assert.equal(fs.existsSync(path.join(fx.home, '.vibe')), false);
});
