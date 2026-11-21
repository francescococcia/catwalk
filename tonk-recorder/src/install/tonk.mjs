// src/install/tonk.mjs — thin child-process wrapper around the `tonk` CLI
// (SPEC §2: the wrapper calls its own pinned @tonk/cli, never whatever is on
// PATH — TONK_BIN overrides, for running a branch/dev build, §7.4).
//
// Per SPEC §6.4 the hooks set TONK_NO_SYNC=1 for every tonk write they make;
// runTonk does the same by default (noSync: false opts out for pull/push).
// Offline in tests: point TONK_BIN at tests/h1/stub-tonk.mjs.
import { spawnSync } from 'node:child_process';

export const EXIT = { OK: 0, ERROR: 1, INTEGRITY: 2, UNTRUSTED: 3, NO_TOOL: 4 };

export function tonkBin(env = process.env) {
  return env.TONK_BIN || 'tonk';
}

// runTonk(args, opts) → { status, stdout (Buffer), stdoutText, stderr, error }
export function runTonk(args, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (opts.noSync === false) delete env.TONK_NO_SYNC;
  else env.TONK_NO_SYNC = '1';
  if (opts.tonkBin) env.TONK_BIN = opts.tonkBin;
  // TONK_BIN may be a full command spec ("node /path/to/stub-tonk.mjs")
  const spec = (opts.tonkBin || tonkBin(env)).split(/\s+/).filter(Boolean);
  const bin = spec[0];
  const prefix = spec.slice(1);
  const r = spawnSync(bin, [...prefix, ...args], {
    cwd: opts.cwd,
    env,
    input: opts.input,
    encoding: 'buffer',
    timeout: opts.timeoutMs ?? 30000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? Buffer.alloc(0),
    stdoutText: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
    error: r.error,
  };
}

// Refuse to leak an invite link into anything we write: SPEC §8 — links are
// never written into files, commits, records. Used in messages we print.
export function redactLink(link) {
  return link ? '<invite-link redacted>' : '';
}
