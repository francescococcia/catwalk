// tests/h1/uninstall.test.mjs — uninstall removes exactly what install wrote
// and leaves everything else (incl. foreign files in the plugin dir) alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, tree, TOOL_MJS } from './testkit.mjs';

function install(home) {
  return runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home], { env: { ...process.env, HOME: home } });
}
function uninstall(home) {
  return runNode(TOOL_MJS, ['uninstall', '--harness', 'vibe', '--home', home], { env: { ...process.env, HOME: home } });
}

test('uninstall leaves nothing behind', () => {
  const home = tmpdir();
  assert.equal(install(home).status, 0);
  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  assert.ok(fs.existsSync(pd));
  const r = uninstall(home);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(pd), false);
  // only the (now empty) .vibe/plugins skeleton dirs may remain
  assert.deepEqual(tree(home), ['.vibe/', '.vibe/plugins/']);
});

test('uninstall is idempotent (second run is a no-op, exit 0)', () => {
  const home = tmpdir();
  assert.equal(install(home).status, 0);
  assert.equal(uninstall(home).status, 0);
  const r = uninstall(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to uninstall/);
});

test('uninstall removes only the files install wrote, leaves foreign files', () => {
  const home = tmpdir();
  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  // a pre-existing foreign file in the plugin dir (not ours)
  fs.mkdirSync(path.join(pd, 'ai.mistral.vibe'), { recursive: true });
  fs.writeFileSync(path.join(pd, 'foreign.txt'), 'not ours\n');
  assert.equal(install(home).status, 0);
  const r = uninstall(home);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tree(path.join(home, '.vibe', 'plugins')), ['tonk-recorder/', 'tonk-recorder/foreign.txt']);
});
