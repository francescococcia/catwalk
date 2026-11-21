// Single-writer queue (per space, per machine).
//
// tonk has no good parallel local writes: two `tonk eval` on one local space
// race for the head and all but one fail (exit 4). So no hook writes to tonk
// directly. A hook ENQUEUES its record as a small file and returns; exactly
// one process at a time — the WRITER — holds the space's writer lock and puts
// queued records into tonk, oldest first, one `tonk eval --no-sync` each
// (still one revision per turn, SPEC §6.4). There is no daemon: whichever
// hook finds the lock free becomes the writer and drains everything queued,
// including other agents' records; the others see their record taken and
// leave. Checkpoint sync (pull/push moves the head too) runs under the same
// lock.
//
// The queue lives in ONE place per machine — $HOME/.tonk/recorder/queue/ —
// not in a harness's own data dir, so Vibe and Claude Code agents on the same
// machine share one writer.
//
//   queue/<space>/<time>-<pid>-<rand>.json   a queued job
//   queue/<space>/.writer/pid                the writer lock
//   queue/<space>/failed/…                   jobs tonk refused (kept, never dropped)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evalNoSync, blobAdd } from "./tonk.mjs";
import { buildChangeNotation, splitDiff } from "../writer/tool.mjs";

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
/** Real sleep (no CPU spin) for synchronous code. */
export function sleepMs(ms) {
  if (ms > 0) Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

export function queueRoot(env = process.env) {
  if (env.TONK_RECORDER_QUEUE_DIR) return env.TONK_RECORDER_QUEUE_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".tonk", "recorder", "queue");
}
export const queueDir = (space, env = process.env) => path.join(queueRoot(env), slug(space));

/** Queue a job; returns its path. Atomic: written aside, then renamed in. */
let seq = 0;
export function enqueue(space, job, env = process.env) {
  const dir = queueDir(space, env);
  fs.mkdirSync(dir, { recursive: true });
  // time first so the writer takes jobs oldest-first; seq keeps one process's own jobs in order
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.pid).padStart(7, "0")}-${String(seq++).padStart(5, "0")}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `.tmp-${name}`);
  fs.writeFileSync(tmp, JSON.stringify(job));
  const file = path.join(dir, name);
  fs.renameSync(tmp, file);
  return file;
}

export function pending(space, env = process.env) {
  try {
    return fs.readdirSync(queueDir(space, env)).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- writer lock

const LOCK_STALE_MS = 120_000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function tryAcquire(dir) {
  const lock = path.join(dir, ".writer");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      return lock;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // held — unless its holder is gone (crashed writer) or it is very old
      let holder = NaN, age = 0;
      try { holder = parseInt(fs.readFileSync(path.join(lock, "pid"), "utf8"), 10); } catch { /* being created */ }
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      const gone = Number.isFinite(holder) ? !alive(holder) : age > 5000;
      if (!gone && age < LOCK_STALE_MS) return null;
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
    }
  }
  return null;
}

function release(lock) {
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
}

// -------------------------------------------------------------------- jobs

const EVAL_RETRIES = 8; // tonk exit 4 = lost a head race (an agent ran `tonk` by hand)

function evalWithRetry(space, doc, env) {
  let res;
  for (let i = 0; i <= EVAL_RETRIES; i++) {
    res = evalNoSync(space, doc, env);
    if (!res || res.code !== 4) break;
    sleepMs(100 * (i + 1));
  }
  return res;
}

/** Put one job into tonk. Returns { status: written|skipped|failed, error? }. */
export function runJob(space, job, env = process.env) {
  if (job.kind === "eval") {
    const res = evalWithRetry(space, job.doc, env);
    return res && res.code === 0 ? { status: "written" } : { status: "failed", error: `tonk eval exit ${res?.code}: ${(res?.stderr || "").trim().split("\n")[0]}` };
  }
  if (job.kind === "change") {
    const rec = job.rec;
    // (idempotency by session+turn is checked by the hook before it queues —
    // outside the writer lock, so the writer does one tonk call per record)
    let diff = job.diff ?? "";
    let diffBlob = null;
    if (!splitDiff(diff).inline) {
      const tmp = path.join(os.tmpdir(), `tonk-diff-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmp, diff);
      try {
        diffBlob = blobAdd(space, tmp, env);
        diff = null;
      } catch (e) {
        return { status: "failed", error: String(e.message || e) };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const doc = buildChangeNotation(rec, { diff, diffBlob });
    const res = evalWithRetry(space, doc, env);
    return res && res.code === 0
      ? { status: "written", blob: diffBlob, doc }
      : { status: "failed", error: `tonk eval exit ${res?.code}: ${(res?.stderr || "").trim().split("\n")[0]}` };
  }
  return { status: "failed", error: `unknown job kind ${job.kind}` };
}

/**
 * Become the writer if nobody is, and put everything queued into tonk.
 *
 * @param {object} o
 * @param {string}  [o.until]    a job path this caller cares about: stop waiting
 *                               for the lock as soon as another writer took it
 * @param {number}  [o.waitMs]   how long to wait for the lock (0 = don't wait)
 * @param {number}  [o.budgetMs] stop draining after this long; the rest stays
 *                               queued for the next hook
 * @param {number}  [o.helpMs]   with `until`: once the caller's own job is in,
 *                               keep writing other agents' jobs only this much
 *                               longer, so no agent's turn is held up doing
 *                               the whole swarm's writing
 * @param {Function}[o.after]    run under the writer lock once the queue is
 *                               empty (checkpoint sync)
 * @returns {{ writer: boolean, results: Record<string, object>, pending: number }}
 */
export function drain(space, env = process.env, { until, waitMs = 0, budgetMs = 20_000, helpMs = 1000, after } = {}) {
  const dir = queueDir(space, env);
  const results = {};
  const waitUntil = Date.now() + waitMs;
  let lock = null;
  for (;;) {
    lock = tryAcquire(dir);
    if (lock) break;
    if (until && !fs.existsSync(until)) return { writer: false, results, pending: pending(space, env).length }; // the writer took it
    if (Date.now() >= waitUntil) return { writer: false, results, pending: pending(space, env).length };
    sleepMs(50);
  }
  let deadline = Date.now() + budgetMs;
  try {
    for (;;) {
      const jobs = pending(space, env);
      if (!jobs.length || Date.now() > deadline) break;
      for (const name of jobs) {
        if (Date.now() > deadline) break;
        const file = path.join(dir, name);
        let job;
        try { job = JSON.parse(fs.readFileSync(file, "utf8")); } catch { job = null; }
        let r;
        try {
          r = job ? runJob(space, job, env) : { status: "failed", error: "unreadable job" };
        } catch (err) {
          r = { status: "failed", error: String(err && err.message ? err.message : err) }; // a bad job must never block the queue
        }
        results[file] = r;
        if (r.status === "failed") {
          // never dropped: kept aside where `status` can show it
          const failedDir = path.join(dir, "failed");
          fs.mkdirSync(failedDir, { recursive: true });
          try { fs.renameSync(file, path.join(failedDir, name)); } catch { fs.rmSync(file, { force: true }); }
          try { fs.writeFileSync(path.join(failedDir, name + ".error"), String(r.error || "")); } catch { /* best effort */ }
        } else {
          fs.rmSync(file, { force: true });
        }
        try { fs.utimesSync(lock, new Date(), new Date()); } catch { /* keep the lock fresh */ }
        if (until && file === until) deadline = Math.min(deadline, Date.now() + helpMs);
      }
    }
    if (after) after();
  } finally {
    release(lock);
  }
  return { writer: true, results, pending: pending(space, env).length };
}

export function failedCount(space, env = process.env) {
  try {
    return fs.readdirSync(path.join(queueDir(space, env), "failed")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
