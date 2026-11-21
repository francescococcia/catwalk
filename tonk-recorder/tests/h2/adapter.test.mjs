// tests/h2/adapter.test.mjs — the per-harness runtime adapter maps Claude
// Code stdin payloads onto `tool.mjs hook <event>` (SPEC §4.2). Uses a stub
// tool.mjs ($TONK_TOOL) that logs argv+stdin; fully offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CC_TO_NEUTRAL, normalizeEvent, adaptPayload, TurnStore } from '../../adapters/claude/lib/payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ADAPTER = join(REPO, 'adapters', 'claude', 'adapter.mjs');
const STUB = join(HERE, 'fixtures', 'stub-tool.mjs');
const STDIN = join(HERE, 'fixtures', 'stdin');

function fixture(name) {
  return JSON.parse(readFileSync(join(STDIN, name), 'utf8'));
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'h2-adapt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    env: {
      ...process.env,
      HOME: dir,
      TONK_TOOL: STUB,
      STUB_LOG: join(dir, 'stub.log'),
      TONK_RECORDER_STATE_DIR: join(dir, 'state'),
    },
    dir,
  };
}

function runAdapter(env, event, payload) {
  return spawnSync(process.execPath, [ADAPTER, event], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    env,
    encoding: 'utf8',
  });
}

function stubCalls(env) {
  const log = env.STUB_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('normalizeEvent maps CC event names and passes neutral ones through', () => {
  assert.deepEqual(CC_TO_NEUTRAL, {
    SessionStart: 'session-start',
    UserPromptSubmit: 'pre-agent',
    Stop: 'post-agent',
    SessionEnd: 'session-end',
  });
  assert.equal(normalizeEvent('SessionStart'), 'session-start');
  assert.equal(normalizeEvent('Stop'), 'post-agent');
  assert.equal(normalizeEvent('post-agent'), 'post-agent');
  assert.throws(() => normalizeEvent('Nope'));
});

test('SessionStart payload is forwarded as hook session-start with session fields', (t) => {
  const { env } = setup(t);
  const r = runAdapter(env, 'SessionStart', fixture('session-start.json'));
  assert.equal(r.status, 0, r.stderr);
  // stub output is forwarded
  assert.match(r.stdout, /stub/);
  const [call] = stubCalls(env);
  assert.deepEqual(call.argv, ['hook', 'session-start']);
  const p = JSON.parse(call.stdin);
  assert.equal(p.hook_event_name, 'session-start');
  assert.equal(p.session_id, 'cc-session-1');
  assert.equal(p.cwd, '/tmp/fake-home/proj');
  assert.ok(p.transcript_path);
});

test('UserPromptSubmit -> pre-agent: prompt carried, turn_id synthesised and stashed', (t) => {
  const { env, dir } = setup(t);
  const r = runAdapter(env, 'UserPromptSubmit', fixture('user-prompt-submit.json'));
  assert.equal(r.status, 0, r.stderr);
  const [call] = stubCalls(env);
  assert.deepEqual(call.argv, ['hook', 'pre-agent']);
  const p = JSON.parse(call.stdin);
  assert.equal(p.hook_event_name, 'pre-agent');
  assert.equal(p.prompt, 'add a README section about testing');
  assert.match(p.turn_id, /^cc-/);
  // stashed on disk for the later Stop
  const stateDir = join(dir, 'state');
  assert.equal(readdirSync(stateDir).length, 1);
  const stashed = JSON.parse(readFileSync(join(stateDir, readdirSync(stateDir)[0]), 'utf8'));
  assert.equal(stashed.turn_id, p.turn_id);
  assert.equal(stashed.prompt, p.prompt);
});

test('Stop -> post-agent re-attaches the same turn_id; SessionEnd cleans up', (t) => {
  const { env, dir } = setup(t);
  runAdapter(env, 'UserPromptSubmit', fixture('user-prompt-submit.json'));
  const [, pre] = [null, ...stubCalls(env)];
  const preTurn = JSON.parse(pre.stdin).turn_id;

  const r = runAdapter(env, 'Stop', fixture('stop.json'));
  assert.equal(r.status, 0, r.stderr);
  const calls = stubCalls(env);
  const stop = JSON.parse(calls[calls.length - 1].stdin);
  assert.deepEqual(calls[calls.length - 1].argv, ['hook', 'post-agent']);
  assert.equal(stop.hook_event_name, 'post-agent');
  assert.equal(stop.turn_id, preTurn);

  const r2 = runAdapter(env, 'SessionEnd', fixture('session-end.json'));
  assert.equal(r2.status, 0, r2.stderr);
  const last = stubCalls(env).at(-1);
  assert.deepEqual(last.argv, ['hook', 'session-end']);
  assert.equal(JSON.parse(last.stdin).hook_event_name, 'session-end');
  assert.equal(readdirSync(join(dir, 'state')).length, 0);
});

test('adapter fails open: garbage stdin / unknown event exit 0 without calling tool', (t) => {
  const { env } = setup(t);
  const r1 = spawnSync(process.execPath, [ADAPTER, 'SessionStart'], { input: 'not json{', env, encoding: 'utf8' });
  assert.equal(r1.status, 0);
  const r2 = runAdapter(env, 'BogusEvent', fixture('stop.json'));
  assert.equal(r2.status, 0);
  assert.equal(stubCalls(env).length, 0);
});

test('adapter exits with the tool’s exit code and forwards its stdout', (t) => {
  const { env } = setup(t);
  env.STUB_EXIT = '3';
  const r = runAdapter(env, 'SessionStart', fixture('session-start.json'));
  assert.equal(r.status, 3);
  assert.match(r.stdout, /stub/);
});

test('adaptPayload works without a store (pure mapping)', () => {
  const p = adaptPayload('session-start', { session_id: 's', cwd: '/x', hook_event_name: 'SessionStart' }, null);
  assert.deepEqual(p, { hook_event_name: 'session-start', session_id: 's', cwd: '/x' });
});

test('TurnStore round-trips and clears per session', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'h2-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TurnStore(dir);
  assert.equal(store.load('s1'), null);
  store.save('s1', { turn_id: 'cc-1', prompt: 'hi', at: 'now' });
  assert.equal(store.load('s1').turn_id, 'cc-1');
  assert.ok(store.has('s1'));
  store.clear('s1');
  assert.equal(store.load('s1'), null);
  assert.ok(!store.has('s1'));
});
