// B3 — update check + trusted-publisher gate (SPEC §3.4, §8, §9.2 B3).
//
// This file is deliberately SELF-CONTAINED (only node: builtins, no relative
// imports) so the single-file build can embed it verbatim into dist/tool.mjs
// as a data: URL module. The wrapper's src/cli re-uses it normally via import.
//
// Behaviour (SPEC §3.4): at session start the installed recorder compares its
// version with the space's latest `tool` record. ONLY if the latest is newer
// AND its publisher is in `trusted-publisher` → return a one-line notice for a
// `system_message`. Untrusted publisher → silently ignore (null). Same/older
// version → null. v1 NEVER auto-updates.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- tonk runner
// The installed recorder (dist/tool.mjs) is not the npm wrapper, so it resolves
// tonk as: TONK_BIN → `tonk` on PATH (hooks run in the harness environment; the
// §3.3 bootstrap path installs @tonk/cli via npx). The WRAPPER (B0) has the
// stricter rule (pinned dep, never PATH) — that lives in src/cli/tonk.mjs.
export function resolveTonkForTool(env = process.env) {
  if (env.TONK_BIN) return { bin: env.TONK_BIN, viaNode: /\.(mjs|cjs|js)$/i.test(env.TONK_BIN) };
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "tonk");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { bin: candidate, viaNode: false };
    } catch { /* keep looking */ }
  }
  return null;
}

export function runTonkTool(args, { env = process.env, cwd, timeoutMs = 10000 } = {}) {
  const resolved = resolveTonkForTool(env);
  if (!resolved) return Promise.resolve({ code: 127, stdout: "", stderr: "tonk not found (set TONK_BIN)", timedOut: false });
  const argv = resolved.viaNode ? [process.execPath, resolved.bin, ...args] : [resolved.bin, ...args];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cwd ?? process.cwd(), env });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", () => { clearTimeout(timer); resolve({ code: 1, stdout: "", stderr: "spawn failed", timedOut: false }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    child.stdin.end();
  });
}

// ---------------------------------------------------------------- json helpers
export function parseJsonArray(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.instances)) return parsed.instances;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [parsed];
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    return [];
  }
}

export function field(rec, name) {
  if (!rec || typeof rec !== "object") return undefined;
  if (rec[name] !== undefined) return rec[name];
  return rec[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
}

// ---------------------------------------------------------------- semver (tiny)
/** Compare dotted versions: >0 a newer, 0 equal, <0 a older. Non-numeric parts compare as strings. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".");
  const pb = String(b ?? "").split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (Number.isNaN(nx) || Number.isNaN(ny)) {
      const c = String(x).localeCompare(String(y));
      if (c !== 0) return c < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx < ny ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- record access
// INTEGRATION POINT: contracts/records.md + packs/recorder.notation (W0/S1).
// Field names per SPEC §5.4/§5.5; JSON keys tolerate dashed or camelCase.
export function latestToolRecord(toolRecords) {
  if (!toolRecords.length) return null;
  return [...toolRecords].sort((a, b) => {
    const ta = String(field(a, "published-at") ?? field(a, "publishedAt") ?? "");
    const tb = String(field(b, "published-at") ?? field(b, "publishedAt") ?? "");
    if (ta !== tb) return ta < tb ? -1 : 1; // ISO-8601 strings compare lexicographically
    return compareVersions(field(a, "version"), field(b, "version"));
  })[toolRecords.length - 1];
}

export function isTrustedPublisher(publisher, trustedRecords) {
  if (!publisher) return false;
  return trustedRecords.some((r) => {
    const identity = field(r, "identity") ?? field(r, "id") ?? field(r, "did") ?? field(r, "publisher");
    return identity === publisher;
  });
}

export function shortDid(did) {
  const s = String(did ?? "");
  return s.length > 28 ? s.slice(0, 24) + "…" + s.slice(-3) : s;
}

/** The one-line `system_message` notice (SPEC §3.4). Update is by command only — v1 never auto-updates. */
export function formatUpdateNotice(record, currentVersion) {
  const v = field(record, "version");
  const publisher = field(record, "publisher");
  const blob = field(record, "blob");
  const sha = field(record, "sha256");
  return (
    `[tonk-recorder] update available: v${v} (was v${currentVersion}, from trusted publisher ${shortDid(publisher)}). ` +
    `v1 never auto-updates — update by running the bootstrap block shown by \`tonk space agents get\` ` +
    `(blob ${blob}, sha256 ${String(sha).slice(0, 12)}…).`
  );
}

/**
 * checkForUpdate — the B3 core.
 * @param {object} o
 * @param {string} o.currentVersion  version of the installed recorder
 * @param {function} [o.run]         tonk runner: (args, opts) => Promise<{code, stdout, stderr, timedOut}>
 * @param {object} [o.env] [o.cwd]
 * @returns {Promise<null | {notice: string, record: object, version: string}>}
 *   null when: no tool record, latest not newer, publisher untrusted, or tonk unreadable.
 */
export async function checkForUpdate({ currentVersion, run, env = process.env, cwd } = {}) {
  const tonkRun = run ?? ((args, opts) => runTonkTool(args, { env, cwd, ...opts }));
  let tools;
  try {
    const r = await tonkRun(["query", "tool", "--json"], { timeoutMs: 10000 });
    if (r.code !== 0) return null; // unreadable space → stay silent (hooks fail open, SPEC §4.1)
    tools = parseJsonArray(r.stdout);
  } catch {
    return null;
  }
  const latest = latestToolRecord(tools);
  if (!latest) return null;
  const latestVersion = field(latest, "version");
  if (compareVersions(latestVersion, currentVersion) <= 0) return null; // same or older → no notice
  let trusted = [];
  try {
    const r = await tonkRun(["query", "trusted-publisher", "--json"], { timeoutMs: 10000 });
    if (r.code === 0) trusted = parseJsonArray(r.stdout);
  } catch { /* fall through to untrusted */ }
  const publisher = field(latest, "publisher");
  if (!isTrustedPublisher(publisher, trusted)) return null; // SPEC §8: untrusted → silently ignore
  return { notice: formatUpdateNotice(latest, currentVersion), record: latest, version: latestVersion };
}
