// tests/h2/install-cli.test.mjs — CLI-level tests for
// adapters/claude/install.mjs with a fake HOME (SPEC §9.2 H2 done-when).
// Fully offline: child processes only, fixture HOME copied to a tmp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusHooks, isManagedHook, MARKER } from '../../adapters/claude/lib/settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const INSTALL = join(REPO, 'adapters', 'claude', 'install.mjs');
const FIXTURE_HOME = join(HERE, 'fixtures', 'home');

function fakeHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'h2-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURE_HOME, dir, { recursive: true });
  return dir;
}

function run(args, env) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('install --harness claude creates exactly the four tagged entries in fake HOME', (t) => {
  const home = fakeHome(t);
  const file = join(home, '.claude', 'settings.json');
  const r = run(['install', '--harness', 'claude', '--home', home], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.installed.length, 4);
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const managed = statusHooks(settings);
  assert.equal(managed.length, 4);
  for (const m of managed) assert.ok(m.command.includes(MARKER));
  // user’s own hooks and keys survive
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo user-pretool-hook');
  assert.ok(settings.hooks.SessionStart[0].hooks.some((h) => h.command === 'echo user-session-start-hook'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(git status:*)'] });
});

test('install uses $HOME by default (fake HOME, no --home flag)', (t) => {
  const home = fakeHome(t);
  const r = run(['install', '--harness', 'claude'], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, '.claude', 'settings.json')));
});

test('install creates the settings file when none exists', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'h2-cli-empty-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = run(['install', '--harness', 'claude', '--home', home], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(statusHooks(settings).length, 4);
});

test('rerun is idempotent (byte-identical file, still exactly four tagged entries)', (t) => {
  const home = fakeHome(t);
  const file = join(home, '.claude', 'settings.json');
  const env = { HOME: home };
  assert.equal(run(['install', '--harness', 'claude', '--home', home], env).status, 0);
  const first = readFileSync(file, 'utf8');
  assert.equal(run(['install', '--harness', 'claude', '--home', home], env).status, 0);
  const second = readFileSync(file, 'utf8');
  assert.equal(second, first);
  assert.equal(statusHooks(JSON.parse(second)).length, 4);
});

test('uninstall removes only the tagged entries; user hooks survive; rerun is a no-op', (t) => {
  const home = fakeHome(t);
  const file = join(home, '.claude', 'settings.json');
  const env = { HOME: home };
  const original = readFileSync(file, 'utf8');
  assert.equal(run(['install', '--harness', 'claude', '--home', home], env).status, 0);
  const r = run(['uninstall', '--harness', 'claude', '--home', home], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).removed, 4);
  // content is back to exactly the user’s original (modulo re-serialisation:
  // install/uninstall rewrite the file as 2-space JSON — documented deviation)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(original));
  const again = run(['uninstall', '--harness', 'claude', '--home', home], env);
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).removed, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(original));
});

test('uninstall on a missing settings file exits 0', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'h2-cli-missing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = run(['uninstall', '--harness', 'claude', '--home', home], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).removed, 0);
});

test('status lists the managed entries; with none installed it lists none', (t) => {
  const home = fakeHome(t);
  const env = { HOME: home };
  let r = run(['status', '--harness', 'claude', '--home', home], env);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).managed.length, 0);
  run(['install', '--harness', 'claude', '--home', home], env);
  r = run(['status', '--harness', 'claude', '--home', home], env);
  const managed = JSON.parse(r.stdout).managed;
  assert.equal(managed.length, 4);
  assert.deepEqual(
    Object.fromEntries(managed.map((m) => [m.event, m.hookEvent])),
    { SessionStart: 'session-start', UserPromptSubmit: 'pre-agent', Stop: 'post-agent', SessionEnd: 'session-end' },
  );
});

test('invalid settings.json: install exits 2 and leaves the file untouched', (t) => {
  const home = fakeHome(t);
  const file = join(home, '.claude', 'settings.json');
  writeFileSync(file, '{ this is not json', 'utf8');
  const r = run(['install', '--harness', 'claude', '--home', home], { HOME: home });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json');
  const r2 = run(['uninstall', '--harness', 'claude', '--home', home], { HOME: home });
  assert.equal(r2.status, 2);
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json');
});

test('wrong harness is rejected with exit 1', (t) => {
  const home = fakeHome(t);
  const r = run(['install', '--harness', 'vibe', '--home', home], { HOME: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--harness claude/);
});

test('no command prints usage and exits 1', () => {
  const r = run([], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});
