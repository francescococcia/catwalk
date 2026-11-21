#!/usr/bin/env node
// src/writer/tool.mjs — R2: the record writer (single self-contained file,
// zero-dependency, Node ESM). Imported by the hook runtime (R3) and runnable
// standalone:
//
//   node tool.mjs write-change <record.json|->   # one change, one eval
//   node tool.mjs sync                            # checkpoint sync now
//   node tool.mjs has-turn <session> <turn>       # idempotency probe (exit 0 = exists)
//   node tool.mjs query <concept> [field=value…]  # read local copy as JSON
//
// Contracts: contracts/records.md (notation), contracts/cli-checks.md
// (tonk 0.8.0 behaviour), contracts/layout.md (state paths).
//
// SPEC §6.4: ONE `tonk eval --no-sync` per turn, TONK_NO_SYNC=1 in the child
// env, idempotent by turn id. §6.5: checkpoint = pull then push, hard
// timeout each, random 0–3 s delay before push, fail-soft. Writer lock:
// tonk's own revision.lock rejects concurrent writers (exit 4), so all tonk
// writes happen under our per-space lock.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INLINE_DIFF_LIMIT = 64 * 1024; // §11.2 default: inline ≤ 64 KB, blob above
export const DEFAULTS = {
  checkpointEvery: 10,          // §11.9 default N
  pullTimeoutMs: 20_000,        // §6.5 hard timeout, pull
  pushTimeoutMs: 20_000,        // §6.5 hard timeout, push
  pushDelayMinMs: 0,            // §6.5 random delay before push
  pushDelayMaxMs: 3_000,
  lockStaleMs: 30_000,          // steal a lockfile older than this
  lockRetryMs: 50,
  lockAttempts: 1200,            // × lockRetryMs = wait up to 60 s for the lock
  writeRetries: 3,              // retry tonk's own lock (exit 4) this many times
};

export const tonkBin = () => process.env.TONK_BIN || 'tonk';
export const dataRoot = () => process.env.DATA_ROOT || path.join(os.homedir(), '.tonk', 'recorder');

// ---------------------------------------------------------------- tonk child

/** Run tonk synchronously. Never throws; reports status/timeout. */
export function runTonk(args, { cwd = process.cwd(), env = {}, input, timeoutMs } = {}) {
  const res = spawnSync(tonkBin(), args, {
    cwd,
    input,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, DO_NOT_TRACK: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    signal: res.signal,
    timedOut: Boolean(res.error && res.error.code === 'ETIMEDOUT'),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Every tonk write the recorder makes runs with TONK_NO_SYNC=1 (§6.4). */
export function writeEnv(extra = {}) {
  return { TONK_NO_SYNC: '1', ...extra };
}

// ------------------------------------------------------------- binding rule

/**
 * Resolve the space for cwd the way tonk does (--space > TONK_SPACE > nearest
 * ancestor binding). Returns { bound, space, site } or { bound: false }.
 * SPEC §6.1: no binding → the caller no-ops.
 */
export function resolveBinding(cwd = process.cwd()) {
  const res = runTonk(['status', '--json'], { cwd });
  if (res.status !== 0) {
    const msg = res.stderr + res.stdout;
    if (res.status === 4 || /no space active/i.test(msg)) return { bound: false };
    return { bound: false, error: msg.trim() };
  }
  try {
    const j = JSON.parse(res.stdout);
    return { bound: true, space: j?.space?.name, site: j?.space?.site, branch: j?.space?.branch };
  } catch {
    return { bound: false, error: 'unparseable tonk status --json' };
  }
}

// ------------------------------------------------------------------- locking

/**
 * Per-space writer lock (contracts/layout.md §4). O_EXCL lockfile with
 * retry + stale takeover; tonk itself rejects concurrent writers with
 * exit 4 / revision.lock (cli-checks.md), so this keeps a swarm serialized.
 */
export function withLock(lockPath, fn, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < o.lockAttempts; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > o.lockStaleMs) fs.rmSync(lockPath, { force: true }); // stale: steal
      } catch { /* stat raced: ignore */ }
      const until = Date.now() + o.lockRetryMs;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now())); // real sleep, never spin
    }
  }
  if (fd === null) throw new Error(`writer lock busy: ${lockPath}`);
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* raced */ }
  }
}

export const lockPathFor = (space) =>
  path.join(dataRoot(), 'locks', `${String(space).replace(/[^a-z0-9-_]/gi, '_')}.lock`);

// ------------------------------------------------------------ notation build

const q = (s) => JSON.stringify(String(s)); // JSON string escaping is valid YAML double-quoted

const FILE_STATUS_KEYWORD = { added: ':added', modified: ':modified', deleted: ':deleted', renamed: ':renamed' };
const HARNESS_KEYWORD = { vibe: ':vibe', claude: ':claude' };

export function buildChangeNotation(rec, { diff = null, diffBlob = null } = {}) {
  for (const f of ['session', 'turn', 'agent', 'prompt', 'project', 'branch', 'base', 'head', 'commit', 'at']) {
    if (rec[f] === undefined || rec[f] === null || rec[f] === '') {
      throw new Error(`change record missing required field "${f}"`);
    }
  }
  if (diff === null && diffBlob === null) throw new Error('change needs diff (inline) or diffBlob');
  if (diff !== null && diffBlob !== null) throw new Error('change has both diff and diffBlob — pick one');
  if (!Array.isArray(rec.files) || rec.files.length === 0) throw new Error('change needs files[]');

  const lines = [
    '# change record — contracts/records.md; one eval per turn (SPEC §6.4)',
    'change!:',
    '  this: ?c',
    `  session: ${q(rec.session)}`,
    `  turn: ${q(rec.turn)}`,
  ];
  if (rec.parentSession) lines.push(`  parent-session: ${q(rec.parentSession)}`);
  lines.push(
    `  agent: ${q(rec.agent)}`,
    `  harness: ${HARNESS_KEYWORD[rec.harness] ?? ':vibe'}`,
    `  prompt: ${q(rec.prompt)}`,
  );
  if (rec.response) lines.push(`  response: ${q(rec.response)}`);
  lines.push(
    `  project: ${q(rec.project)}`,
    `  branch: ${q(rec.branch)}`,
    `  base: ${q(rec.base)}`,
    `  head: ${q(rec.head)}`,
    `  commit: ${q(rec.commit)}`,
    `  lines-added: ${num(rec.linesAdded)}`,
    `  lines-removed: ${num(rec.linesRemoved)}`,
  );
  if (diff !== null) lines.push(`  diff: ${q(diff)}`);
  if (diffBlob !== null) lines.push(`  diff-blob: ${diffBlob}`); // blob:<hash> / asset:<hash> URI
  lines.push(`  redacted: ${rec.redacted ? 'true' : 'false'}`, `  at: ${q(rec.at)}`);
  for (const f of rec.files) {
    if (!f.path) throw new Error('files[] entry missing path');
    lines.push(
      '',
      'change-file!:',
      '  change: ?c',
      `  path: ${q(f.path)}`,
      `  status: ${FILE_STATUS_KEYWORD[f.status] ?? ':modified'}`,
      `  added: ${num(f.added ?? 0)}`,
      `  removed: ${num(f.removed ?? 0)}`,
    );
  }
  return lines.join('\n') + '\n';
}

const num = (n) => {
  const v = Number(n ?? 0);
  if (!Number.isInteger(v) || v < 0) throw new Error(`not a natural: ${n}`);
  return String(v);
};

/** Decide inline vs blob for a diff (SPEC §11.2: ≤ 64 KB inline). */
export function splitDiff(diffText) {
  const bytes = Buffer.byteLength(diffText ?? '', 'utf8');
  return bytes > INLINE_DIFF_LIMIT ? { inline: false, bytes } : { inline: true, bytes };
}

// ------------------------------------------------------------------- queries

/** Idempotency probe (§6.4): does a change for session+turn already exist? */
export function hasTurn({ session, turn }, cwd = process.cwd()) {
  const res = runTonk(
    ['query', 'change', '--where', `session=${session}`, '--where', `turn=${turn}`, '--json'],
    { cwd },
  );
  if (res.status !== 0) return { ok: false, error: (res.stderr || res.stdout).trim() };
  try {
    return { ok: true, exists: JSON.parse(res.stdout).length > 0 };
  } catch {
    return { ok: false, error: 'unparseable query --json' };
  }
}

export function queryLocal(concept, where = [], cwd = process.cwd()) {
  const args = ['query', concept, '--json'];
  for (const w of where) args.push('--where', w);
  const res = runTonk(args, { cwd });
  if (res.status !== 0) throw new Error(`tonk query failed: ${(res.stderr || res.stdout).trim()}`);
  return JSON.parse(res.stdout);
}

// -------------------------------------------------------------------- write

/**
 * Write one change record: idempotency check → optional blob add → ONE
 * `tonk eval --no-sync` (§6.4), all under the per-space writer lock.
 * Returns { bound, written, duplicate?, blob?, revisionAfter?, error? }.
 * Never touches the network.
 */
export function writeChange(rec, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cwd = o.cwd ?? process.cwd();
  const binding = resolveBinding(cwd);
  if (!binding.bound) return { bound: false, written: false, error: binding.error };

  return withLock(lockPathFor(binding.space), () => {
    // idempotent by turn id (§6.4)
    const probe = hasTurn(rec, cwd);
    if (probe.ok && probe.exists) return { bound: true, written: false, duplicate: true, space: binding.space };

    // diff split: > 64 KB goes via `tonk blob add`, referenced as blob:<hash>
    let diff = rec.diff ?? null;
    let diffBlob = rec.diffBlob ?? null;
    if (diff !== null && !splitDiff(diff).inline) {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tonk-diff-')), 'diff.patch');
      fs.writeFileSync(tmp, diff);
      const add = runTonk(['blob', 'add', tmp, '--no-sync'], { cwd, env: writeEnv(), timeoutMs: o.pushTimeoutMs });
      if (add.status !== 0) return { bound: true, written: false, error: `blob add failed: ${(add.stderr || add.stdout).trim()}` };
      const m = (add.stdout + add.stderr).match(/(?:asset|blob):([A-Za-z0-9]+)/);
      if (!m) return { bound: true, written: false, error: 'blob add printed no asset:/blob: ref' };
      diffBlob = `blob:${m[1]}`; // normalise to the SPEC spelling; blob cat reads both (cli-checks.md)
      diff = null;
    }

    const doc = buildChangeNotation(rec, { diff, diffBlob });
    let lastErr = '';
    for (let attempt = 1; attempt <= o.writeRetries; attempt++) {
      const res = runTonk(['eval', '--no-sync', '-c', doc], { cwd, env: writeEnv(), timeoutMs: o.pushTimeoutMs });
      if (res.status === 0) {
        const rev = /revision-after: (\S+)/.exec(res.stdout);
        bumpTurnCounter(rec.session, o);
        return { bound: true, written: true, space: binding.space, blob: diffBlob, revisionAfter: rev?.[1] };
      }
      lastErr = (res.stderr || res.stdout).trim();
      if (res.status !== 4 && !/Lock error|Concurrent write/i.test(lastErr)) break; // only lock errors are retryable
      const until = Date.now() + 150 * attempt;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now())); // real sleep, never spin
    }
    return { bound: true, written: false, error: lastErr };
  }, o);
}

// ------------------------------------------------------- checkpoint sync §6.5

/**
 * Checkpoint: `tonk pull` then (after a random 0–3 s delay) `tonk push`.
 * Hard timeout each (default 20 s), fail-soft — NEVER throws, never blocks
 * the turn beyond the timeouts; everything is already local, the next
 * checkpoint delivers it (§6.5).
 */
export function checkpointSync(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cwd = o.cwd ?? process.cwd();
  const random = o.random ?? Math.random;
  const pull = runTonk(['pull'], { cwd, timeoutMs: o.pullTimeoutMs });
  const delayMs = Math.round(o.pushDelayMinMs + random() * (o.pushDelayMaxMs - o.pushDelayMinMs));
  if (delayMs > 0) {
    const until = Date.now() + delayMs;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now())); // real sleep, never spin
  }
  const push = runTonk(['push'], { cwd, timeoutMs: o.pushTimeoutMs });
  const report = (r) => ({ ok: r.status === 0 && !r.timedOut, status: r.status, timedOut: r.timedOut, error: r.timedOut ? 'timeout' : (r.stderr || '').trim().split('\n')[0] });
  return { pull: report(pull), pushDelayMs: delayMs, push: report(push), ok: pull.status === 0 && push.status === 0 };
}

// -------------------------------------------------------------- turn counter

export function statePath(session) {
  return path.join(dataRoot(), 'state', `${String(session).replace(/[^a-z0-9-_]/gi, '_')}.json`);
}

export function readState(session) {
  try { return JSON.parse(fs.readFileSync(statePath(session), 'utf8')); } catch { return { turns: 0 }; }
}

function bumpTurnCounter(session, o) {
  const p = statePath(session);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const st = readState(session);
  st.turns = (st.turns ?? 0) + 1;
  st.lastWriteAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(st));
  return st.turns;
}

/** Checkpoint due every N turns (§6.5, §11.9 default 10). */
export const shouldCheckpoint = (turns, every = DEFAULTS.checkpointEvery) => turns > 0 && turns % every === 0;

// ---------------------------------------------------------------------- CLI

async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'write-change') {
      const src = rest[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(rest[0], 'utf8');
      const rec = JSON.parse(src);
      const out = writeChange(rec);
      process.stdout.write(JSON.stringify(out) + '\n');
      // fail-open: written, duplicate and unbound are all successful no-ops
      return out.error ? 1 : 0;
    }
    if (cmd === 'sync') {
      const out = checkpointSync();
      process.stdout.write(JSON.stringify(out) + '\n');
      return 0; // fail-soft: always exit 0
    }
    if (cmd === 'has-turn') {
      const out = hasTurn({ session: rest[0], turn: rest[1] });
      process.stdout.write(JSON.stringify(out) + '\n');
      return out.ok && out.exists ? 0 : 1;
    }
    if (cmd === 'query') {
      process.stdout.write(JSON.stringify(queryLocal(rest[0], rest.slice(1))) + '\n');
      return 0;
    }
    process.stderr.write('usage: tool.mjs write-change <record.json|-> | sync | has-turn <session> <turn> | query <concept> [field=value…]\n');
    return cmd ? 1 : 0;
  } catch (e) {
    // fail-open (contracts/hooks.md): never block the harness
    process.stderr.write(`tool.mjs ${cmd}: ${e.message}\n`);
    return 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
