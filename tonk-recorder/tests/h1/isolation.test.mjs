// tests/h1/isolation.test.mjs — install writes a USER-LEVEL plugin and nothing
// else: no writes into the project repo, nothing into the user's own
// ~/.vibe/hooks.toml, nothing outside ~/.vibe/plugins/tonk-recorder/ in HOME;
// and --expect-sha256 refuses on mismatch (SPEC §3.3/§8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, tree, read, sha256Hex, TOOL_MJS } from './testkit.mjs';

const SENTINEL = '# my own hooks\n[[hooks]]\nname = "mine"\n';

test('nothing is written into the project repo or the user hooks.toml', () => {
  const home = tmpdir();
  const proj = tmpdir('tonk-proj-');
  fs.writeFileSync(path.join(proj, 'main.mjs'), 'console.log(1)\n');
  fs.mkdirSync(path.join(home, '.vibe'), { recursive: true });
  fs.writeFileSync(path.join(home, '.vibe', 'hooks.toml'), SENTINEL);

  const beforeProj = tree(proj);
  const beforeHome = tree(home);
  const r = runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home], {
    cwd: proj,
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);

  // project repo untouched
  assert.deepEqual(tree(proj), beforeProj);
  // user's own hooks.toml untouched
  assert.equal(read(path.join(home, '.vibe', 'hooks.toml')), SENTINEL);
  // inside HOME, only the plugin subtree was added
  const added = tree(home).filter((p) => !beforeHome.includes(p));
  assert.ok(added.length > 0);
  for (const p of added) {
    // every added path is the plugin subtree or one of its parent dirs
    assert.ok(
      p.startsWith('.vibe/plugins/tonk-recorder') || '.vibe/plugins/tonk-recorder/'.startsWith(p),
      `unexpected write: ${p}`,
    );
  }
});

test('install --expect-sha256 with the right hash installs', () => {
  const home = tmpdir();
  const sha = sha256Hex(fs.readFileSync(TOOL_MJS));
  const r = runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home, '--expect-sha256', sha], {
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.vibe', 'plugins', 'tonk-recorder', 'plugin.json')));
});

test('install --expect-sha256 refuses on mismatch and writes nothing (exit 2)', () => {
  const home = tmpdir();
  fs.mkdirSync(path.join(home, '.vibe', 'plugins'), { recursive: true });
  const wrong = '0'.repeat(64);
  const r = runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home, '--expect-sha256', wrong], {
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(home, '.vibe', 'plugins', 'tonk-recorder')), false);
  assert.deepEqual(tree(home), ['.vibe/', '.vibe/plugins/']);
});

test('install refuses an invalid --version and writes nothing', () => {
  const home = tmpdir();
  const r = runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home, '--version', '1.0.0", "evil": true'], {
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(home, '.vibe')), false);
});
