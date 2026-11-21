// R5 tests — decisions --at. Primary: W0's landed fixtures (fixtures/tonk-log/*)
// which carry a superseded decision and a status change. Plus a REAL tonk-dev
// integration test (TONK_BIN=~/.local/bin/tonk-dev, local --site space, offline)
// and a stub-tonk test for the restore-unavailable (other-device) route.
// Run: node --test tests/r5/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeLog, parsePoint, resolvePoint, foldDecisions } from "../../src/decisions-at/fold.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const TOOL = path.join(ROOT, "src", "decisions-at", "tool.mjs");
const STUB = path.join(ROOT, "tests", "r3", "fixtures", "stub-tonk.mjs");
const LOG_DEC = path.join(ROOT, "fixtures", "tonk-log", "log-decision.json");
const LOG_CHG = path.join(ROOT, "fixtures", "tonk-log", "log-change.json");
const LOG_CHG_COMMIT = path.join(HERE, "fixtures", "log-change-commit.json");
const TONK_DEV = path.join(os.homedir(), ".local", "bin", "tonk-dev");

const runCli = (args, env = {}) =>
  spawnSync("node", [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60000 });

const D1 = "did:key:z6MkFakeDecision1";
const D2 = "did:key:z6MkFakeDecision2";
const R4 = "4@GJKNZreUUTS9sMGcEMUecN9ptqXoxyHN8FCsyWWW15U1"; // D1 + status accepted
const R5 = "5@GJKNZreUUTS9sMGcEMUecN9ptqXoxyHN8FCsyWWW15U1"; // D2 supersedes D1 (other origin)

function model() {
  const m = normalizeLog(JSON.parse(fs.readFileSync(LOG_DEC, "utf8")));
  const ch = normalizeLog(JSON.parse(fs.readFileSync(LOG_CHG, "utf8")));
  m.changes.push(...ch.changes);
  return m;
}
const brief = (ds) => ds.map((d) => `${d.id}:${d.status}`).sort();

test("parsePoint: revision / ISO time / commit", () => {
  assert.equal(parsePoint(R5).kind, "revision");
  assert.equal(parsePoint(R5).edition, 5);
  assert.equal(parsePoint("2026-11-21T13:10:00Z").kind, "time");
  assert.equal(parsePoint("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678").kind, "commit");
});

test("fold over W0 fixtures: three points all correct (supersede + status change)", () => {
  const m = model();
  // P1 rev 4: D1 exists with status accepted (same revision)
  let ds = foldDecisions(m, resolvePoint(m, parsePoint(R4)));
  assert.deepEqual(brief(ds), [`${D1}:accepted`]);
  // P2 rev 5 (another origin): D2 supersedes D1 -> D1 dropped, D2 default accepted
  ds = foldDecisions(m, resolvePoint(m, parsePoint(R5)));
  assert.deepEqual(brief(ds), [`${D2}:accepted`]);
  assert.equal(ds[0].supersedes, D1);
  // P3 git commit carried by a change record at rev 4
  const m2 = model();
  const chc = normalizeLog(JSON.parse(fs.readFileSync(LOG_CHG_COMMIT, "utf8")));
  m2.changes.push(...chc.changes);
  ds = foldDecisions(m2, resolvePoint(m2, parsePoint("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")));
  assert.deepEqual(brief(ds), [`${D1}:accepted`]);
});

test("CLI via W0 fixtures: route=fold reported, answers correct at three points incl. other-device point", () => {
  const env = { DO_NOT_TRACK: "1" };
  const base = ["decisions", "--log", LOG_DEC, "--statuses-log", LOG_DEC, "--changes-log", LOG_CHG_COMMIT, "--json"];
  const p1 = runCli([...base, "--at", R4], env);
  assert.equal(p1.status, 0, p1.stderr);
  let r = JSON.parse(p1.stdout);
  assert.equal(r.route, "fold");
  assert.deepEqual(brief(r.decisions), [`${D1}:accepted`]);

  const p2 = runCli([...base, "--at", R5], env); // point from another origin, answered via fold
  r = JSON.parse(p2.stdout);
  assert.equal(r.route, "fold");
  assert.equal(r.resolvedRevision, R5);
  assert.deepEqual(brief(r.decisions), [`${D2}:accepted`]);

  const p3 = runCli([...base, "--at", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"], env);
  r = JSON.parse(p3.stdout);
  assert.equal(r.resolvedRevision, R4, "commit resolves through the change record to rev 4");
  assert.deepEqual(brief(r.decisions), [`${D1}:accepted`]);
  assert.match(p3.stderr, /route: fold/);
});

test("stub tonk (head NOT local): falls back to fold and says so", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r5-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    DO_NOT_TRACK: "1",
    TONK_BIN: STUB,
    STUB_LOG: path.join(root, "stub.log"),
    STUB_LOG_JSON: LOG_DEC, // stub prints this for every `log … --json`
    STUB_RESTORE_OK: "", // no local signed heads -> restore unavailable
  };
  const r = runCli(["decisions", "--at", R5, "--space", "testspace", "--changes-log", LOG_CHG_COMMIT, "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.route, "fold", "other-device point answered via the fold");
  assert.deepEqual(brief(out.decisions), [`${D2}:accepted`]);
  const calls = fs.readFileSync(env.STUB_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).argv.join(" "));
  assert.ok(calls.some((c) => c.includes("restore") && c.includes("--dry-run")), "tried restore --dry-run first");
});

test("REAL tonk-dev (L1): local --site space, decisions --at at three points", { skip: !fs.existsSync(TONK_DEV) }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r5dev-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const env = { ...process.env, HOME: home, DO_NOT_TRACK: "1", TONK_BIN: TONK_DEV };
  const td = (args, input) =>
    spawnSync(TONK_DEV, args, { input, encoding: "utf8", env, cwd: proj, timeout: 60000 });

  const nu = td(["space", "new", "r5dev", "--site", path.join(root, "site")]);
  assert.equal(nu.status, 0, nu.stderr);
  const pack = td(["--space", "r5dev", "eval", path.join(ROOT, "packs", "recorder.notation")]);
  assert.equal(pack.status, 0, pack.stderr);
  const ev = (doc) => td(["--space", "r5dev", "eval", "--no-sync", "-"], doc);
  // rev: decision D1, then status accepted, then D2 supersedes D1 + status proposed
  assert.equal(ev('decision!: &decision/d1\n  title: "D1"\n  chosen: "c1"\n  why: "w1"\n  by: "a"\n  at: "2026-11-21T10:00:00Z"\n').status, 0);
  assert.equal(ev('decision-status!: &decision-status/s1\n  decision: decision/d1\n  status: :accepted\n  by: "a"\n  at: "2026-11-21T10:05:00Z"\n').status, 0);
  assert.equal(ev('decision!: &decision/d2\n  title: "D2"\n  chosen: "c2"\n  why: "w2"\n  supersedes: decision/d1\n  by: "b"\n  at: "2026-11-21T10:10:00Z"\n').status, 0);
  assert.equal(ev('decision-status!: &decision-status/s2\n  decision: decision/d2\n  status: :proposed\n  by: "b"\n  at: "2026-11-21T10:15:00Z"\n').status, 0);

  // discover the revision ids from the real log
  const log = td(["--space", "r5dev", "log", "--limit", "1000", "--json"]);
  const revs = JSON.parse(log.stdout).rows.map((r) => r.version).sort((a, b) => parseInt(a) - parseInt(b));
  assert.ok(revs.length >= 4, `have revisions: ${revs}`);
  const [vPack, vD1, vS1, vD2, vS2] = revs.length === 5 ? revs : [revs[0], ...revs.slice(-4)];

  const cli = (at) => runCli(["decisions", "--at", at, "--space", "r5dev", "--json"], env);

  // point at D1's revision: local head -> restore route (or fold if restore fails); answer [d1 accepted-default]
  let r = cli(vD1);
  assert.deepEqual(JSON.parse(r.stdout).decisions.map((d) => `${d.title}:${d.status}`), ["D1:accepted"]);
  // point at the status revision: d1 accepted
  r = cli(vS1);
  const out1 = JSON.parse(r.stdout);
  assert.deepEqual(out1.decisions.map((d) => `${d.title}:${d.status}`), ["D1:accepted"]);
  // point at D2's revision: d1 superseded -> only d2 (no status yet -> default accepted)
  r = cli(vD2);
  const out2 = JSON.parse(r.stdout);
  assert.deepEqual(out2.decisions.map((d) => `${d.title}:${d.status}`), ["D2:accepted"]);
  // point at D2's status revision: proposed
  r = cli(vS2);
  const out2b = JSON.parse(r.stdout);
  assert.deepEqual(out2b.decisions.map((d) => `${d.title}:${d.status}`), ["D2:proposed"]);
  // time point between s1 and d2 -> fold route (no revision), d1 accepted
  r = cli("2026-11-21T10:07:00Z");
  const out3 = JSON.parse(r.stdout);
  assert.equal(out3.route, "fold");
  assert.deepEqual(out3.decisions.map((d) => `${d.title}:${d.status}`), ["D1:accepted"]);
  // report which route revision points took
  const routes = [JSON.parse(cli(vD1).stdout).route, out1.route, out2.route];
  assert.ok(routes.every((x) => x === "restore" || x === "fold"), `routes: ${routes}`);
});
