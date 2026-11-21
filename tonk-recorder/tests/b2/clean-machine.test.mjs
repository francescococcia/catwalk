// tests/b2/clean-machine.test.mjs — B2 done-when: a simulated clean machine
// (fresh fake HOME, only the stub `tonk` via TONK_BIN + a link) ends with a
// working plugin layout after the §3.3 no-wrapper flow; a tampered blob is
// refused. Fully offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, runBash, tree, read, sha256Hex, fakeHomeWithStub, stubCalls, assertNoFileContains, TOOL_MJS, STUB_TONK, REPO_ROOT } from '../h1/testkit.mjs';
import { bootstrapBlock, parseBootstrapBlock } from '../../src/install/bootstrap.mjs';

const LINK = 'TEST-INVITE-PLACEHOLDER-NOT-A-REAL-LINK';
const PUBLISHER = 'did:key:stubPublisher';

function cleanMachine({ tamper = false } = {}) {
  const fx = fakeHomeWithStub();
  const toolBytes = fs.readFileSync(TOOL_MJS);
  const sha = sha256Hex(toolBytes);
  const blobRef = 'asset:stub' + sha.slice(0, 24);
  const blobFile = path.join(fx.dir, 'logic-blob.mjs');
  fs.writeFileSync(blobFile, tamper ? Buffer.concat([toolBytes, Buffer.from('// evil\n')]) : toolBytes);
  const block = bootstrapBlock({ wrapper: 'tonk-recorder', version: '1.0.0', blobRef, sha256: sha });
  fs.writeFileSync(
    fx.state,
    JSON.stringify({
      blobs: { [blobRef]: blobFile },
      tool: [{ name: 'tonk-recorder', version: '1.0.0', blob: blobRef, sha256: sha, publisher: PUBLISHER, at: '2026-11-21T10:00:00Z' }],
      trusted: [PUBLISHER],
      agents: ['# AGENTS.md', '', block].join('\n'),
      evals: [], anchors: {}, decisions: [], statuses: [],
    }, null, 2),
  );
  const proj = tmpdir('tonk-clean-proj-');
  return { ...fx, sha, blobRef, proj };
}

test('clean machine: join + AGENTS.md bootstrap block → working plugin', () => {
  const fx = cleanMachine();

  // §3.3: npx @tonk/cli join '<link>' --agent-name … && npx @tonk/cli space agents get
  // (offline: $TONK_BIN stands in for `npx --yes @tonk/cli`)
  const j = runNode(STUB_TONK, ['join', LINK, '--agent-name', 'new-agent'], { cwd: fx.proj, env: fx.env });
  assert.equal(j.status, 0, j.stderr);
  const g = runNode(STUB_TONK, ['space', 'agents', 'get'], { cwd: fx.proj, env: fx.env });
  assert.equal(g.status, 0, g.stderr);

  // the agent pastes the bootstrap block; only substitution: npx → $TONK_BIN
  const parsed = parseBootstrapBlock(g.stdout);
  assert.ok(parsed);
  const sh = g.stdout.slice(g.stdout.indexOf('```sh')).replace(/^```sh\n|```\s*$/g, '').replaceAll('npx --yes @tonk/cli', '$TONK_BIN');
  const r = runBash(sh, { cwd: fx.proj, env: fx.env });
  assert.equal(r.status, 0, r.stderr);

  // working plugin layout on the "machine"
  const pd = path.join(fx.proj, '.vibe', 'plugins', 'tonk-recorder');
  assert.deepEqual(tree(pd), ['ai.mistral.vibe/', 'ai.mistral.vibe/hooks.toml', 'plugin.json', 'tool.mjs']);
  const manifest = JSON.parse(read(path.join(pd, 'plugin.json')));
  assert.equal(manifest.name, 'tonk-recorder');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.extensions['ai.mistral.vibe'].displayName, 'Tonk recorder');
  const hooks = read(path.join(pd, 'ai.mistral.vibe', 'hooks.toml'));
  assert.equal((hooks.match(/\[\[hooks\]\]/g) || []).length, 4);
  for (const ev of ['session-start', 'pre-agent', 'post-agent', 'session-end']) {
    assert.ok(hooks.includes(`node tool.mjs hook ${ev}`), `hook ${ev}`);
  }
  assert.ok(hooks.includes('timeout = 30.0'));
  assert.equal(sha256Hex(fs.readFileSync(path.join(pd, 'tool.mjs'))), fx.sha);

  // the installed tool.mjs actually runs
  const v = runNode(path.join(pd, 'tool.mjs'), ['--version'], { env: { ...fx.env, HOME: fx.home } });
  assert.equal(v.status, 0);

  // no invite link anywhere on the "machine"
  assertNoFileContains(fx.home, LINK);
  assertNoFileContains(fx.proj, LINK);
  const calls = stubCalls(fx.calls).map((a) => a[0]);
  assert.ok(calls.includes('join') && calls.includes('blob'), 'used tonk join + blob cat');
});

test('clean machine: tampered logic blob is refused (install exit 2)', () => {
  const fx = cleanMachine({ tamper: true });
  // the blob now hashes differently than the sha256 in the block/record
  const g = runNode(STUB_TONK, ['space', 'agents', 'get'], { cwd: fx.proj, env: fx.env });
  const parsed = parseBootstrapBlock(g.stdout);
  const sh = g.stdout.slice(g.stdout.indexOf('```sh')).replace(/^```sh\n|```\s*$/g, '').replaceAll('npx --yes @tonk/cli', '$TONK_BIN');
  const r = runBash(sh, { cwd: fx.proj, env: fx.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(fx.proj, '.vibe', 'plugins', 'tonk-recorder')), false);
});
