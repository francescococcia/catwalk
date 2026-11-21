// tests/h2/settings.test.mjs — pure unit tests for the tagged-settings
// library (SPEC §9.2 H2 done-when: install creates exactly the four tagged
// entries; rerun idempotent; uninstall removes only them; user hooks
// survive). Offline, no child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKER,
  EVENT_MAP,
  SettingsParseError,
  managedHook,
  isManagedHook,
  loadSettings,
  serializeSettings,
  writeSettings,
  installHooks,
  uninstallHooks,
  statusHooks,
} from '../../adapters/claude/lib/settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE_HOME = join(HERE, 'fixtures', 'home');
const ADAPTER = join(REPO, 'adapters', 'claude', 'adapter.mjs');

function fixtureSettings() {
  return JSON.parse(readFileSync(join(FIXTURE_HOME, '.claude', 'settings.json'), 'utf8'));
}

function countManaged(settings) {
  return statusHooks(settings).length;
}

test('managedHook is tagged with the marker and a neutral event', () => {
  const h = managedHook('/x/adapter.mjs', 'session-start');
  assert.equal(h.type, 'command');
  assert.ok(h.command.includes(MARKER));
  assert.ok(h.command.includes('session-start'));
  assert.ok(isManagedHook(h));
  assert.ok(!isManagedHook({ type: 'command', command: 'echo hi' }));
});

test('install on empty settings creates exactly the four tagged entries', () => {
  const { settings, added } = installHooks({}, { adapterPath: ADAPTER });
  assert.equal(added.length, 4);
  assert.equal(countManaged(settings), 4);
  for (const [ccEvent, neutral] of Object.entries(EVENT_MAP)) {
    const groups = settings.hooks[ccEvent];
    assert.ok(Array.isArray(groups) && groups.length === 1, `one group for ${ccEvent}`);
    const managed = groups[0].hooks.filter(isManagedHook);
    assert.equal(managed.length, 1, `one managed hook for ${ccEvent}`);
    assert.ok(managed[0].command.includes(` ${neutral} # ${MARKER}`));
  }
});

test('install is idempotent: rerun yields a deep-equal settings object', () => {
  const once = installHooks({}, { adapterPath: ADAPTER }).settings;
  const twice = installHooks(once, { adapterPath: ADAPTER }).settings;
  assert.deepEqual(twice, once);
  assert.equal(countManaged(twice), 4);
  // and byte-identical serialisation
  assert.equal(serializeSettings(twice), serializeSettings(once));
});

test('install preserves the user’s own hooks and other settings keys', () => {
  const original = fixtureSettings();
  const { settings } = installHooks(original, { adapterPath: ADAPTER });
  // untouched keys
  assert.deepEqual(settings.permissions, original.permissions);
  // user PreToolUse hook intact
  const pre = settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(pre.command, 'echo user-pretool-hook');
  // user SessionStart hook intact, managed entry appended alongside
  const ss = settings.hooks.SessionStart[0].hooks;
  assert.ok(ss.some((h) => h.command === 'echo user-session-start-hook'));
  assert.ok(ss.some(isManagedHook));
  // input object not mutated
  assert.equal(countManaged(original), 0);
});

test('uninstall removes only the tagged entries; user hooks survive', () => {
  const original = fixtureSettings();
  const installed = installHooks(original, { adapterPath: ADAPTER }).settings;
  const { settings: removed, removed: n } = uninstallHooks(installed);
  assert.equal(n, 4);
  assert.deepEqual(removed, original); // back to exactly the user’s file
});

test('uninstall on settings with only managed entries drops the hooks key', () => {
  const installed = installHooks({}, { adapterPath: ADAPTER }).settings;
  const { settings, removed } = uninstallHooks(installed);
  assert.equal(removed, 4);
  assert.equal(settings.hooks, undefined);
  assert.deepEqual(settings, {});
});

test('uninstall on empty/missing settings is a no-op', () => {
  assert.equal(uninstallHooks({}).removed, 0);
  assert.equal(uninstallHooks({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'ls' }] }] } }).removed, 0);
});

test('loadSettings: missing file -> {}, invalid JSON -> SettingsParseError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h2-'));
  try {
    assert.deepEqual(loadSettings(join(dir, 'nope.json')), {});
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    assert.throws(() => loadSettings(bad), SettingsParseError);
    // writeSettings round-trips and creates parent dirs
    const f = join(dir, 'sub', 'settings.json');
    writeSettings(f, { a: 1 });
    assert.deepEqual(loadSettings(f), { a: 1 });
    assert.ok(readFileSync(f, 'utf8').endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statusHooks reports the four managed entries with their entry points', () => {
  const { settings } = installHooks({}, { adapterPath: ADAPTER });
  const found = statusHooks(settings);
  assert.equal(found.length, 4);
  const byEvent = Object.fromEntries(found.map((f) => [f.event, f.hookEvent]));
  assert.deepEqual(byEvent, EVENT_MAP);
});
