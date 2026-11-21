// tests/h1/idempotent.test.mjs — rerunning install is idempotent: same
// layout, same bytes, exit 0; a corrupted file converges back on rerun.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, tree, read, TOOL_MJS } from './testkit.mjs';

function install(home, extra = []) {
  return runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home, ...extra], {
    env: { ...process.env, HOME: home },
  });
}

test('rerunning install is idempotent (same tree, same bytes, exit 0)', () => {
  const home = tmpdir();
  const r1 = install(home, ['--version', '1.0.0']);
  const r2 = install(home, ['--version', '1.0.0']);
  const r3 = install(home, ['--version', '1.0.0']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r3.status, 0, r3.stderr);
  const t = tree(home);
  assert.deepEqual(t, [
    '.vibe/',
    '.vibe/plugins/',
    '.vibe/plugins/tonk-recorder/',
    '.vibe/plugins/tonk-recorder/ai.mistral.vibe/',
    '.vibe/plugins/tonk-recorder/ai.mistral.vibe/hooks.toml',
    '.vibe/plugins/tonk-recorder/plugin.json',
    '.vibe/plugins/tonk-recorder/tool.mjs',
  ]);
  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  assert.ok(read(path.join(pd, 'plugin.json')).includes('"version": "1.0.0"'));
  assert.equal(read(path.join(pd, 'tool.mjs')), read(TOOL_MJS));
});

test('rerun converges after the installed files were tampered with', () => {
  const home = tmpdir();
  assert.equal(install(home).status, 0);
  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  fs.writeFileSync(path.join(pd, 'plugin.json'), '{ "tampered": true }');
  fs.writeFileSync(path.join(pd, 'ai.mistral.vibe', 'hooks.toml'), '# tampered\n');
  const r = install(home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(read(path.join(pd, 'plugin.json')).includes('"name": "tonk-recorder"'));
  assert.ok(read(path.join(pd, 'ai.mistral.vibe', 'hooks.toml')).includes('tonk-post-agent'));
});
