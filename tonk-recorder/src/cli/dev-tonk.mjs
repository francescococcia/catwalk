// Fetch tonk's dev-channel build from its GitHub release.
//
// Revision history (`tonk log` / `tonk restore`) exists only in the dev
// channel. tonk's CI publishes that on every merge to main to the rolling
// GitHub release `tonk-dev` — NOT to npm (npm only gets `v*` tags: `next` and
// `latest`). So the recorder pulls the binary itself, the same way tonk's own
// install.sh does: download the platform archive, verify it against the
// release's checksums.txt, refuse on mismatch.
//
// It installs to the recorder's OWN folder — ~/.tonk/recorder/bin/tonk — and
// never touches a `tonk` the person installed. Wrapper and hooks then resolve
// it through devTonkBin() (hooks/identity.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { devTonkBin, managedTonkPath } from "../hooks/identity.mjs";

export const DEV_RELEASE = "https://github.com/tonk-labs/tonk/releases/download/tonk-dev";

export function platformAsset(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "tonk-macos-arm64.tar.gz";
  if (platform === "linux" && arch === "x64") return "tonk-linux-x86_64.tar.gz";
  return null; // only these two are published
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** sha256 for `asset` out of a checksums.txt body ("<hex>  <name>" per line). */
export function checksumFor(text, asset) {
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Download + verify + install the dev build. Throws on any failure (no
 * unverified binary is ever installed). Returns { bin, version, commit }.
 */
export async function fetchDevTonk(env = process.env, { base = env.TONK_RECORDER_DEV_RELEASE || DEV_RELEASE, log = () => {} } = {}) {
  const asset = platformAsset();
  if (!asset) throw new Error(`tonk's dev channel has no build for ${process.platform}/${process.arch} (macOS arm64 and Linux x86_64 only)`);
  const dest = managedTonkPath(env);
  log(`downloading tonk (dev channel) — ${asset}`);
  const [sums, archive] = await Promise.all([get(`${base}/checksums.txt`, 30_000), get(`${base}/${asset}`, 300_000)]);
  const expected = checksumFor(sums.toString("utf8"), asset);
  if (!expected) throw new Error(`no checksum entry for ${asset} in the release's checksums.txt — refusing to install`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${actual}) — refusing to install`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tonk-dev-"));
  try {
    fs.writeFileSync(path.join(tmp, asset), archive);
    execFileSync("tar", ["-xzf", path.join(tmp, asset), "-C", tmp], { stdio: "ignore" });
    const bin = path.join(tmp, "tonk");
    if (!fs.existsSync(bin)) throw new Error("the archive did not contain a `tonk` binary");
    fs.chmodSync(bin, 0o755);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // copy aside then rename: a hook must never run a half-written binary
    const staging = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(bin, staging);
    fs.chmodSync(staging, 0o755);
    fs.renameSync(staging, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  let manifest = {};
  try {
    manifest = JSON.parse((await get(`${base}/manifest.json`, 30_000)).toString("utf8"));
    fs.writeFileSync(`${dest}.manifest.json`, JSON.stringify({ ...manifest, sha256: actual, fetched_at: new Date().toISOString() }, null, 2) + "\n");
  } catch { /* informational only */ }
  return { bin: dest, version: manifest.version ?? null, commit: manifest.commit ?? null, builtAt: manifest.built_at ?? null };
}

/**
 * Make sure a dev-channel tonk is available before the wrapper uses tonk.
 * No-op when TONK_BIN is set or one is already there. Never throws: on
 * failure the caller falls back to the pinned npm build (no revision history).
 * @returns {{ bin: string|null, fetched: boolean, error?: string }}
 */
export async function ensureDevTonk(env = process.env, { force = false, log = console.log } = {}) {
  if (env.TONK_BIN) return { bin: env.TONK_BIN, fetched: false };
  if (!force) {
    const have = devTonkBin(env);
    if (have) return { bin: have, fetched: false };
  }
  if (env.TONK_RECORDER_NO_FETCH === "1") return { bin: devTonkBin(env), fetched: false };
  try {
    const r = await fetchDevTonk(env, { log });
    log(`tonk (dev channel${r.commit ? ` @ ${String(r.commit).slice(0, 8)}` : ""}${r.builtAt ? `, built ${r.builtAt}` : ""}) installed at ${r.bin}, checksum verified`);
    return { bin: r.bin, fetched: true };
  } catch (err) {
    const error = String(err && err.message ? err.message : err);
    log(`could not fetch tonk's dev build (${error}); falling back to a build with NO revision history (\`tonk log\` / \`restore\`)`);
    return { bin: devTonkBin(env), fetched: false, error };
  }
}
