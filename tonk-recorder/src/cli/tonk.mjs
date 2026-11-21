// tonk child-process runner for the wrapper (SPEC §2).
//
// Resolution order — the wrapper NEVER uses whatever `tonk` is on PATH:
//   1. TONK_BIN (dev/branch builds, tests with a stub tonk)
//   2. the pinned dependency: <pkg>/node_modules/@tonk/cli/bin/tonk.js
//      (bin entry of @tonk/cli 0.8.0, run under this Node)
// If neither exists we fail readably; there is deliberately no PATH fallback.
import { devTonkBin } from "../hooks/identity.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./paths.mjs";

export class TonkError extends Error {
  constructor(message, { exitCode = 1, cmd = null, stderr = "" } = {}) {
    super(message);
    this.name = "TonkError";
    this.exitCode = exitCode;
    this.cmd = cmd;
    this.stderr = stderr;
  }
}

export function resolveTonkBin(env = process.env) {
  if (env.TONK_BIN) {
    return { bin: env.TONK_BIN, viaNode: /\.(mjs|cjs|js)$/i.test(env.TONK_BIN) };
  }
  // The dev-channel build, when this machine has it: the only tonk with
  // revision history (`tonk log` / `restore`). See hooks/identity.mjs.
  const dev = devTonkBin(env);
  if (dev) return { bin: dev, viaNode: false };
  // npm may hoist the pinned dep to an ancestor node_modules — walk up, but
  // only accept a candidate whose node_modules also contains THIS package
  // (i.e. a real install tree), never an unrelated ancestor like $HOME.
  const self = path.basename(PKG_ROOT);
  let dir = PKG_ROOT;
  for (;;) {
    const nm = path.join(dir, "node_modules");
    const pinned = path.join(nm, "@tonk/cli", "bin", "tonk.js");
    if (fs.existsSync(pinned) && (dir === PKG_ROOT || fs.existsSync(path.join(nm, self)))) {
      return { bin: pinned, viaNode: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new TonkError(
    "pinned @tonk/cli not found (searched node_modules/@tonk/cli/bin/tonk.js up from " + PKG_ROOT + "). Run `npm install` in the " +
      "tonk-recorder package, or set TONK_BIN to a tonk binary (dev/branch builds).",
    { exitCode: 1 },
  );
}

/**
 * Run `tonk <args>` as a child process. Returns { code, stdout, stderr, buffer, timedOut }.
 * Never throws — callers decide via tonkOk().
 */
export function runTonk(args, { env = process.env, cwd, timeoutMs, input, noSync = false } = {}) {
  let bin;
  try {
    bin = resolveTonkBin(env);
  } catch (err) {
    return Promise.reject(err);
  }
  const argv = bin.viaNode ? [process.execPath, bin.bin, ...args] : [bin.bin, ...args];
  const childEnv = { ...env };
  if (noSync) childEnv.TONK_NO_SYNC = "1"; // SPEC §6.4: hook-side writes never sync inline

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cwd ?? process.cwd(), env: childEnv });
    } catch (err) {
      reject(err);
      return;
    }
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1000);
        if (killTimer.unref) killTimer.unref();
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }
    if (input !== undefined && input !== null) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
    child.stdout.on("data", (d) => outChunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const buffer = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks).toString("utf8");
      resolve({ code: code ?? (timedOut ? -1 : 1), stdout: buffer.toString("utf8"), stderr, buffer, timedOut });
    });
  });
}

/** Run tonk and throw a readable TonkError on non-zero exit / timeout. */
export async function tonkOk(args, opts = {}) {
  const r = await runTonk(args, opts);
  if (r.timedOut) {
    throw new TonkError(
      `tonk ${args.join(" ")} timed out after ${opts.timeoutMs}ms — local records are safe; the next checkpoint syncs (SPEC §6.5)`,
      { exitCode: 124, cmd: args, stderr: r.stderr },
    );
  }
  if (r.code !== 0) {
    const detail = r.stderr.trim();
    throw new TonkError(
      `tonk ${args.join(" ")} failed (exit ${r.code})${detail ? `: ${detail.split("\n")[0]}` : ""}`,
      { exitCode: r.code || 1, cmd: args, stderr: r.stderr },
    );
  }
  return r;
}

/** `tonk query <concept> --json` → parsed array. `ok` is the tonkOk runner. */
export async function queryJson(ok, concept, { where = [], ...opts } = {}) {
  const args = ["query", concept, ...where.flatMap((w) => ["--where", w]), "--json"];
  const r = await ok(args, opts);
  return parseJsonArray(r.stdout, concept);
}

export function parseJsonArray(stdout, what = "query") {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.instances)) return parsed.instances; // versioned envelope
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [parsed];
  } catch {
    // Some CLIs print a preamble before the JSON; take the first [...] block.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new TonkError(`could not parse tonk ${what} --json output as JSON`, { exitCode: 1 });
  }
}

/** Read a record field tolerating dashed vs camelCase JSON keys. */
export function field(rec, name) {
  if (!rec || typeof rec !== "object") return undefined;
  if (rec[name] !== undefined) return rec[name];
  const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return rec[camel];
}

/** Extract the first did:key:… token from `tonk identity` output. */
export function extractDid(text) {
  const m = String(text).match(/did:key:[A-Za-z0-9]+/);
  return m ? m[0] : String(text).trim();
}
