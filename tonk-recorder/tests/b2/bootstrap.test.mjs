// tests/b2/bootstrap.test.mjs — the no-wrapper bootstrap path (SPEC §3.3):
// the AGENTS.md bootstrap block, parsed back out of `tonk space agents get`
// output, works when pasted (with `npx --yes @tonk/cli` replaced by $TONK_BIN
// to stay offline — the only substitution the test makes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, runBash, tree, read, write, sha256Hex, fakeHomeWithStub, stubState, TOOL_MJS, STUB_TONK, REPO_ROOT } from '../h1/testkit.mjs';
import { bootstrapBlock, parseBootstrapBlock } from '../../src/install/bootstrap.mjs';

const PUBLISHER = 'did:key:stubPublisher';

function spaceWithAgents() {
  const fx = fakeHomeWithStub();
  const toolBytes = fs.readFileSync(TOOL_MJS);
  const sha = sha256Hex(toolBytes);
  const blobRef = 'asset:stub' + sha.slice(0, 24);
  const blobFile = path.join(fx.dir, 'logic-blob.mjs');
  fs.writeFileSync(blobFile, toolBytes);
  const block = bootstrapBlock({ wrapper: 'tonk-recorder', version: '1.0.0', blobRef, sha256: sha });
  const agents = ['# Space AGENTS.md', '', 'Project-specific guidance here.', '', block].join('\n');
  fs.writeFileSync(
    fx.state,
    JSON.stringify({ blobs: { [blobRef]: blobFile }, tool: [{ name: 'tonk-recorder', version: '1.0.0', blob: blobRef, sha256: sha, publisher: PUBLISHER, at: '2026-11-21T10:00:00Z' }], trusted: [PUBLISHER], agents, evals: [], anchors: {}, decisions: [], statuses: [] }, null, 2),
  );
  return { ...fx, sha, blobRef, block };
}

// Execute a bootstrap block the way an agent would paste it; the single
// test-only substitution is `npx --yes @tonk/cli` → `$TONK_BIN` (offline).
function runPastedBlock(fx, blockText, proj) {
  const sh = blockText
    .slice(blockText.indexOf('```sh'))
    .replace(/^```sh\n/, '')
    .replace(/```\s*$/, '')
    .replaceAll('npx --yes @tonk/cli', '$TONK_BIN');
  return runBash(sh, { cwd: proj, env: fx.env });
}

test('pasted bootstrap block from `tonk space agents get` installs the plugin', () => {
  const fx = spaceWithAgents();
  const proj = tmpdir('tonk-proj-');

  // the agent runs: tonk join <link> && tonk space agents get
  const got = runNode(STUB_TONK, ['space', 'agents', 'get'], { cwd: proj, env: fx.env });
  assert.equal(got.status, 0, got.stderr);
  const parsed = parseBootstrapBlock(got.stdout);
  assert.ok(parsed, 'bootstrap block found in AGENTS.md');
  assert.equal(parsed.version, '1.0.0');
  assert.equal(parsed.blobRef, fx.blobRef);
  assert.equal(parsed.sha256, fx.sha);
  assert.equal(parsed.commands.length, 3);

  // paste + run the block
  const r = runPastedBlock(fx, got.stdout.slice(got.stdout.indexOf('```sh')), proj);
  assert.equal(r.status, 0, r.stderr);

  // staged verified logic + working plugin layout
  const staged = path.join(fx.home, '.tonk', 'tools', 'tonk-recorder', '1.0.0', 'tool.mjs');
  assert.equal(sha256Hex(fs.readFileSync(staged)), fx.sha);
  const pd = path.join(proj, '.vibe', 'plugins', 'tonk-recorder');
  assert.deepEqual(tree(pd), ['ai.mistral.vibe/', 'ai.mistral.vibe/hooks.toml', 'plugin.json', 'tool.mjs']);
  assert.equal(sha256Hex(fs.readFileSync(path.join(pd, 'tool.mjs'))), fx.sha);

  // the installed tool.mjs is runnable and serves the instructions (R4)
  const ver = runNode(path.join(pd, 'tool.mjs'), ['--version'], { env: { ...fx.env, HOME: fx.home } });
  assert.equal(ver.status, 0);
  const instr = runNode(path.join(pd, 'tool.mjs'), ['instructions'], { env: { ...fx.env, HOME: fx.home } });
  assert.ok(instr.stdout.includes('decision!:'));

  // uninstall leaves nothing
  const un = runNode(path.join(pd, 'tool.mjs'), ['uninstall', '--harness', 'vibe', '--home', proj], { env: { ...fx.env, HOME: fx.home } });
  assert.equal(un.status, 0);
  assert.equal(fs.existsSync(pd), false);
});

test('pasted bootstrap block with a wrong sha256 is refused, nothing installed', () => {
  const fx = spaceWithAgents();
  const proj = tmpdir('tonk-proj-');
  const bad = fx.block.replace(fx.sha, '0'.repeat(64));
  const r = runPastedBlock(fx, bad, proj);
  assert.notEqual(r.status, 0, 'install must refuse');
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(proj, '.vibe', 'plugins', 'tonk-recorder')), false);
  assert.equal(fs.existsSync(path.join(fx.home, '.vibe', 'plugins', 'tonk-recorder')), false);
});
