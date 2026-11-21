// tests/h1/testkit.mjs — shared helpers for tests/h1*, tests/r4*, tests/b2*
// (all owned by agent h1-r4-b2). Fully offline: fake HOME dirs, spawnSync
// runners, a tree() snapshotting helper, and a stub `tonk` binary.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TOOL_MJS = path.join(REPO_ROOT, 'src', 'install', 'tool.mjs');
export const STUB_TONK = path.join(REPO_ROOT, 'tests', 'h1', 'stub-tonk.mjs');

export function tmpdir(prefix = 'tonk-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'buffer',
    cwd: opts.cwd,
    env: opts.env || process.env,
    input: opts.input,
    timeout: opts.timeoutMs ?? 60000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stdoutBuf: r.stdout,
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
    error: r.error,
  };
}

export function runNode(script, args, opts = {}) {
  return run(process.execPath, [script, ...args], opts);
}

// bash -c with a controlled env (used to execute pasted bootstrap blocks).
export function runBash(block, opts = {}) {
  return run('bash', ['-c', block], opts);
}

export function tree(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${p}/` : p);
      if (e.isDirectory()) walk(path.join(dir, e.name), p);
    }
  };
  walk(root, '');
  return out;
}

export function read(f) {
  return fs.readFileSync(f, 'utf8');
}

export function write(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
  return f;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// A fake HOME wired for the stub tonk: returns { home, state, calls, env }.
// state/calls are JSON / JSONL files the stub reads and appends to.
export function fakeHomeWithStub({ stubState } = {}) {
  const home = tmpdir('tonk-home-');
  const dir = tmpdir('tonk-stub-');
  const state = path.join(dir, 'state.json');
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(state, JSON.stringify(stubState ?? { blobs: {}, tool: [], trusted: [], agents: '', evals: [], anchors: {}, decisions: [], statuses: [] }, null, 2));
  fs.writeFileSync(calls, '');
  const env = {
    ...process.env,
    HOME: home,
    TONK_BIN: `node ${STUB_TONK}`,
    TONK_STUB_STATE: state,
    TONK_STUB_CALLS: calls,
  };
  return { home, dir, state, calls, env };
}

export function stubCalls(callsPath) {
  return fs
    .readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).argv);
}

export function stubState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// Recursively assert that no file under root contains the forbidden string
// (SPEC §8: invite links are never written into files).
export function assertNoFileContains(root, needle) {
  for (const rel of tree(root)) {
    if (rel.endsWith('/')) continue;
    const content = fs.readFileSync(path.join(root, rel));
    if (content.includes(needle)) {
      throw new Error(`forbidden string found in ${path.join(root, rel)}`);
    }
  }
}
