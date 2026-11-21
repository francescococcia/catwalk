// Fetching tonk's dev build from its GitHub release — offline: a local HTTP
// server stands in for the release.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ensureDevTonk, checksumFor, platformAsset } from "../src/cli/dev-tonk.mjs";
import { devTonkBin, managedTonkPath } from "../src/hooks/identity.mjs";

function fakeRelease(t, { corrupt = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asset = platformAsset();
  fs.writeFileSync(path.join(dir, "tonk"), "#!/bin/sh\necho 'tonk 9.9.9-dev'\n", { mode: 0o755 });
  execFileSync("tar", ["-czf", path.join(dir, asset), "-C", dir, "tonk"]);
  const sha = createHash("sha256").update(fs.readFileSync(path.join(dir, asset))).digest("hex");
  fs.writeFileSync(path.join(dir, "checksums.txt"), `${corrupt ? "0".repeat(64) : sha}  ${asset}\n`);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: "9.9.9", commit: "abcdef1234", channel: "dev", built_at: "2026-11-21T12:45:12Z" }));
  const server = http.createServer((req, res) => {
    const f = path.join(dir, path.basename(req.url));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    t.after(() => server.close());
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}
const fakeHome = (t) => { const h = fs.mkdtempSync(path.join(os.tmpdir(), "home-")); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; };

test("checksumFor reads the release's checksums.txt", () => {
  const a = "a".repeat(64);
  assert.equal(checksumFor(`${a}  tonk-macos-arm64.tar.gz\n${"b".repeat(64)}  other\n`, "tonk-macos-arm64.tar.gz"), a);
  assert.equal(checksumFor("junk", "x"), null);
});

test("no dev build on the machine: it is fetched, verified and installed in the recorder's own folder", { skip: !platformAsset() }, async (t) => {
  const base = await fakeRelease(t);
  const env = { HOME: fakeHome(t), TONK_RECORDER_DEV_RELEASE: base };
  assert.equal(devTonkBin(env), null);
  const lines = [];
  const r = await ensureDevTonk(env, { log: (l) => lines.push(l) });
  assert.equal(r.fetched, true, lines.join("\n"));
  assert.equal(r.bin, managedTonkPath(env));
  assert.equal(devTonkBin(env), managedTonkPath(env), "wrapper and hooks now resolve it");
  assert.match(execFileSync(r.bin, ["--version"], { encoding: "utf8" }), /9\.9\.9-dev/);
  assert.match(lines.join("\n"), /checksum verified/);
  // second time: already there, no download
  const again = await ensureDevTonk({ ...env, TONK_RECORDER_DEV_RELEASE: "http://127.0.0.1:9" }, { log: () => {} });
  assert.equal(again.fetched, false);
  assert.equal(again.bin, managedTonkPath(env));
});

test("a checksum mismatch installs nothing and falls back", { skip: !platformAsset() }, async (t) => {
  const base = await fakeRelease(t, { corrupt: true });
  const env = { HOME: fakeHome(t), TONK_RECORDER_DEV_RELEASE: base };
  const lines = [];
  const r = await ensureDevTonk(env, { log: (l) => lines.push(l) });
  assert.equal(r.fetched, false);
  assert.match(r.error, /checksum mismatch/);
  assert.equal(fs.existsSync(managedTonkPath(env)), false, "no unverified binary installed");
  assert.match(lines.join("\n"), /NO revision history/);
});

test("TONK_BIN set, or the release unreachable: no fetch, never throws", async (t) => {
  const home = fakeHome(t);
  assert.deepEqual(await ensureDevTonk({ HOME: home, TONK_BIN: "/x/tonk" }, { log: () => {} }), { bin: "/x/tonk", fetched: false });
  const r = await ensureDevTonk({ HOME: home, TONK_RECORDER_DEV_RELEASE: "http://127.0.0.1:9" }, { log: () => {} });
  assert.equal(r.fetched, false);
  assert.ok(r.error);
});
