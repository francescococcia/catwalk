// tests/h1/install.test.mjs — H1 done-when: `install --harness vibe` writes
// the SPEC §4.1 user-level plugin layout byte-for-byte (fake HOME, offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runNode, tree, read, TOOL_MJS } from './testkit.mjs';

// Byte-exact expectations from SPEC §4.1.
function expectedPluginJson(version) {
  return (
    '{\n' +
    '  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",\n' +
    '  "name": "tonk-recorder",\n' +
    `  "version": "${version}",\n` +
    '  "description": "Records agent code changes into the bound Tonk space.",\n' +
    '  "extensions": { "ai.mistral.vibe": { "schemaVersion": 1, "displayName": "Tonk recorder" } }\n' +
    '}\n'
  );
}

const EXPECTED_HOOKS_TOML = `[[hooks]]
name = "tonk-session-start"
type = "session_start"
command = "node tool.mjs hook session-start"

[[hooks]]
name = "tonk-pre-agent"
type = "pre_agent"
command = "node tool.mjs hook pre-agent"

[[hooks]]
name = "tonk-post-agent"
type = "post_agent"
command = "node tool.mjs hook post-agent"
timeout = 30.0

[[hooks]]
name = "tonk-session-end"
type = "session_end"
command = "node tool.mjs hook session-end"
`;

function install(home, extra = [], cwd) {
  return runNode(TOOL_MJS, ['install', '--harness', 'vibe', '--home', home, ...extra], {
    cwd: cwd ?? tmpdir('tonk-proj-'),
    env: { ...process.env, HOME: home },
  });
}

test('install writes the SPEC §4.1 layout byte-for-byte', () => {
  const home = tmpdir();
  const r = install(home);
  assert.equal(r.status, 0, r.stderr);

  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  assert.deepEqual(tree(home), [
    '.vibe/',
    '.vibe/plugins/',
    '.vibe/plugins/tonk-recorder/',
    '.vibe/plugins/tonk-recorder/ai.mistral.vibe/',
    '.vibe/plugins/tonk-recorder/ai.mistral.vibe/hooks.toml',
    '.vibe/plugins/tonk-recorder/plugin.json',
    '.vibe/plugins/tonk-recorder/tool.mjs',
  ]);

  // plugin.json: byte-for-byte the SPEC §4.1 manifest (default version)
  const manifest = read(path.join(pd, 'plugin.json'));
  assert.equal(manifest, expectedPluginJson('0.0.0'));
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(parsed.name, 'tonk-recorder');
  assert.equal(parsed.description, 'Records agent code changes into the bound Tonk space.');
  assert.deepEqual(parsed.extensions, {
    'ai.mistral.vibe': { schemaVersion: 1, displayName: 'Tonk recorder' },
  });

  // hooks.toml: byte-for-byte the SPEC §4.1 hooks block
  assert.equal(read(path.join(pd, 'ai.mistral.vibe', 'hooks.toml')), EXPECTED_HOOKS_TOML);

  // tool.mjs: a byte copy of the running (packed) tool.mjs — the verified logic
  assert.equal(read(path.join(pd, 'tool.mjs')), read(TOOL_MJS));
});

test('install --version sets the manifest version', () => {
  const home = tmpdir();
  const r = install(home, ['--version', '1.2.3']);
  assert.equal(r.status, 0, r.stderr);
  const pd = path.join(home, '.vibe', 'plugins', 'tonk-recorder');
  assert.equal(read(path.join(pd, 'plugin.json')), expectedPluginJson('1.2.3'));
});

test('hooks.toml declares exactly the four SPEC §4.1 hooks', () => {
  const home = tmpdir();
  assert.equal(install(home).status, 0);
  const toml = read(path.join(home, '.vibe', 'plugins', 'tonk-recorder', 'ai.mistral.vibe', 'hooks.toml'));
  const blocks = toml.split('[[hooks]]').slice(1).map((b) => b.trim());
  assert.equal(blocks.length, 4);
  const hooks = blocks.map((b) => {
    const get = (k) => b.match(new RegExp(`^${k} = (.*)$`, 'm'))?.[1];
    return { name: JSON.parse(get('name')), type: JSON.parse(get('type')), command: JSON.parse(get('command')), timeout: get('timeout') };
  });
  assert.deepEqual(hooks, [
    { name: 'tonk-session-start', type: 'session_start', command: 'node tool.mjs hook session-start', timeout: undefined },
    { name: 'tonk-pre-agent', type: 'pre_agent', command: 'node tool.mjs hook pre-agent', timeout: undefined },
    { name: 'tonk-post-agent', type: 'post_agent', command: 'node tool.mjs hook post-agent', timeout: '30.0' },
    { name: 'tonk-session-end', type: 'session_end', command: 'node tool.mjs hook session-end', timeout: undefined },
  ]);
});

test('status reports the installed plugin', () => {
  const home = tmpdir();
  assert.equal(install(home, ['--version', '2.0.0']).status, 0);
  const r = runNode(TOOL_MJS, ['status', '--harness', 'vibe', '--home', home], { env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(r.stdout);
  assert.equal(st.installed, true);
  assert.equal(st.version, '2.0.0');
  assert.deepEqual(st.files, { manifest: true, tool: true, hooks: true });
});

test('unsupported harness is refused with exit 1', () => {
  const home = tmpdir();
  const r = runNode(TOOL_MJS, ['install', '--harness', 'emacs', '--home', home], { env: { ...process.env, HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only supports --harness vibe/);
  assert.equal(fs.existsSync(path.join(home, '.vibe')), false);
});
