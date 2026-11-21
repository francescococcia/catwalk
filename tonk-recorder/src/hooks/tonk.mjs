// Thin client for the pinned `tonk` CLI, always invoked as a child process.
// The binary is selectable via TONK_BIN (SPEC §2/§7.4 — point it at a dev
// build of feat/tonk-log when PR #1146 lands). Verified against tonk 0.8.0:
//   - `eval --no-sync -` (or TONK_NO_SYNC=1) commits locally only, no network
//   - `blob add <file>` prints an `asset:<hash>` ref on 0.8.0 (SPEC says
//     `blob:<hash>`; we store the ref verbatim and accept both prefixes)
//   - `query <concept> --json [--where f=v]` prints a JSON array
//   - `pull` / `push` touch the upstream only
// DEV-only (PR #1146, NOT in 0.8.0): `log`, `restore`, `switch` — marked DEV.
//
// Concurrency: several hook processes can write the same local space at
// once; tonk serialises on its own revision.lock and fails with exit code 4
// when it loses the race. We therefore take our own lock around every write
// and additionally retry exit-4 a few times (SPEC §6.4: one eval per turn,
// records add-only and tagged by turn id, so a retried write is harmless).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function tonkBin(env = process.env) {
  return (env.TONK_BIN || "tonk").trim().split(/\s+/);
}

export function runTonk(args, { env = process.env, input, timeoutMs = 30000 } = {}) {
  const [bin, ...binArgs] = tonkBin(env);
  const r = spawnSync(bin, [...binArgs, ...args], {
    input,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return {
    code: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: r.signal === "SIGTERM" || r.error?.code === "ETIMEDOUT",
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

const baseArgs = (space) => (space ? ["--space", space] : []);

/** One local, no-network commit of a notation document (SPEC §6.4). */
export function evalNoSync(space, doc, env = process.env, timeoutMs = 15000) {
  return runTonk([...baseArgs(space), "eval", "--no-sync", "-"], {
    env: { ...env, TONK_NO_SYNC: "1" },
    input: doc,
    timeoutMs,
  });
}

/** Store a large diff as a blob; returns the ref string (`asset:…`/`blob:…`). */
export function blobAdd(space, filePath, env = process.env, timeoutMs = 15000) {
  const r = runTonk([...baseArgs(space), "blob", "add", filePath], { env: { ...env, TONK_NO_SYNC: "1" }, timeoutMs });
  if (r.code !== 0) throw new Error(`tonk blob add failed (${r.code}): ${r.stderr.trim()}`);
  const m = r.stdout.match(/(?:asset|blob):[A-Za-z0-9_-]+/);
  return m ? m[0] : r.stdout.trim().split("\n")[0];
}

/** Read instances of a concept from the LOCAL copy (no network). Tolerant: [] on any failure. */
export function queryJson(space, concept, wherePairs = [], env = process.env, timeoutMs = 10000) {
  const args = [...baseArgs(space), "query", concept, "--json"];
  for (const w of wherePairs) args.push("--where", w);
  const r = runTonk(args, { env: { ...env, TONK_NO_SYNC: "1" }, timeoutMs });
  if (r.code !== 0) return [];
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** Checkpoint pull (SPEC §6.5): hard timeout, failure is swallowed by caller. */
export function pull(space, env = process.env, timeoutMs = 20000) {
  return runTonk([...baseArgs(space), "pull"], { env, timeoutMs });
}

/** Checkpoint push (SPEC §6.5): hard timeout, failure is swallowed by caller. */
export function push(space, env = process.env, timeoutMs = 20000) {
  return runTonk([...baseArgs(space), "push"], { env, timeoutMs });
}

// --- DEV-only: tonk PR #1146 (`feat/tonk-log`), not in @tonk/cli 0.8.0 -----

/** `tonk log decision --json --limit 1000` (DEV). Returns parsed JSON or null. */
export function logJson(space, subArgs, env = process.env, timeoutMs = 20000) {
  const r = runTonk([...baseArgs(space), "log", ...subArgs, "--json", "--limit", "1000"], { env, timeoutMs });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** `tonk restore --revision <rev> --dry-run` (DEV). true = this device can check it out. */
export function restoreDryRun(space, revision, env = process.env, timeoutMs = 20000) {
  const r = runTonk([...baseArgs(space), "restore", "--revision", revision, "--dry-run"], { env, timeoutMs });
  return r.code === 0 && !/unavailable|not local|not found/i.test(r.stdout + r.stderr);
}

/** `tonk restore --revision <rev>` (DEV) — switches to the new local branch. */
export function restoreRevision(space, revision, env = process.env, timeoutMs = 20000) {
  return runTonk([...baseArgs(space), "restore", "--revision", revision], { env, timeoutMs });
}

/** `tonk switch main` (DEV) — back to the present after reading a restored branch. */
export function switchMain(space, env = process.env, timeoutMs = 20000) {
  return runTonk([...baseArgs(space), "switch", "main"], { env, timeoutMs });
}

// --- write lock -------------------------------------------------------------
// Serialize our own tonk writes per PLUGIN_DATA dir (tonk's revision.lock
// collision exits 4; we avoid most of those and retry the rest).

const LOCK_STALE_MS = 30000;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function withWriteLock(lockDir, fn, { retries = 12, baseDelayMs = 100 } = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  let waited = 0;
  for (;;) {
    try {
      fs.mkdirSync(path.join(lockDir, "lock"));
    } catch {
      // maybe stale — take over; otherwise wait
      try {
        const st = fs.statSync(path.join(lockDir, "lock"));
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(path.join(lockDir, "lock"), { recursive: true, force: true });
          continue;
        }
      } catch {
        /* lock vanished — retry mkdir */
      }
      await sleep(baseDelayMs);
      waited += baseDelayMs;
      if (waited > 30000) throw new Error("write lock timeout");
      continue;
    }
    try {
      let last;
      for (let i = 0; i <= retries; i++) {
        last = await fn();
        if (!last || last.code !== 4) return last; // 4 = revision.lock collision
        await sleep(baseDelayMs * (i + 1) * 2);
      }
      return last;
    } finally {
      try { fs.rmSync(path.join(lockDir, "lock"), { recursive: true, force: true }); } catch {}
    }
  }
}
