// B1 publish tests — SPEC §9.2 B1 done-when: with a stub tonk, `publish`
// writes blob + tool record + trusted-publisher + an AGENTS.md bootstrap block
// that works when pasted, preserving any other AGENTS.md content (SPEC §3.1).
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt(); // fresh-checkout safe: dist/ is gitignored
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  makeWorkspace, runCli, readCalls, readJsonState, readAgents,
  DIST_TOOL, STUB_TONK, PKG_ROOT,
} from "./b0-testkit.mjs";

function spawnNode(file, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [file, ...args], opts);
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("publish: tool record carries all SPEC §5.4 fields and a matching sha256", async (t) => {
  const ws = makeWorkspace(t);
  const created = await runCli(["new", "projx", "--agent-name", "ada"], { cwd: ws.project, env: ws.env });
  assert.equal(created.code, 0, created.stderr);
  const pub = await runCli(["publish", "--version", "0.2.0", "--changelog", "v0.2.0: test update"], { cwd: ws.project, env: ws.env });
  assert.equal(pub.code, 0, pub.stderr);

  const calls = readCalls(ws.state).map((c) => c.argv);
  assert.ok(calls.some((a) => a[0] === "blob" && a[1] === "add"), "blob add of the logic file");

  const records = readJsonState(ws.state, "tool-records.json");
  assert.equal(records.length, 2, "initial publish at new + this publish");
  const rec = records[records.length - 1];
  for (const k of ["name", "version", "blob", "sha256", "publisher", "publishedAt", "changelog"]) {
    assert.ok(rec[k], `tool record has ${k}`);
  }
  assert.equal(rec.name, "tonk-recorder");
  assert.equal(rec.version, "0.2.0");
  assert.match(rec.blob, /^blob:[0-9a-f]{64}$/);
  assert.match(rec.publisher, /^did:key:/);
  assert.equal(rec.changelog, "v0.2.0: test update");

  // the record sha256 matches the actual published bytes
  const blobFile = path.join(ws.state, "blobs", rec.blob.replace("blob:", ""));
  const sha = crypto.createHash("sha256").update(fs.readFileSync(blobFile)).digest("hex");
  assert.equal(sha, rec.sha256);
});

test("new marks the creator as trusted-publisher (SPEC §3.1 step 3)", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx", "--agent-name", "ada"], { cwd: ws.project, env: ws.env });
  const trusted = readJsonState(ws.state, "trusted-publishers.json");
  assert.equal(trusted.length, 1);
  assert.match(trusted[0].identity, /^did:key:/);
});

test("publish refuses a non-trusted publisher (SPEC §8: write ≠ publish)", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["publish"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /trusted-publisher/);
  const calls = readCalls(ws.state).map((c) => c.argv);
  assert.ok(!calls.some((a) => a[0] === "blob" && a[1] === "add"), "no blob written when refused");
});

test("publish: AGENTS.md keeps existing content + gets the bootstrap block", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  // someone adds their own content to the space AGENTS.md
  fs.writeFileSync(path.join(ws.state, "agents.md"), readAgents(ws.state) + "\n# My project notes\n\nDo not remove this.\n");

  const pub = await runCli(["publish", "--version", "0.2.0", "--changelog", "v0.2.0: test update"], { cwd: ws.project, env: ws.env });
  assert.equal(pub.code, 0, pub.stderr);

  // what `tonk space agents get` now returns (the stub serves agents.md):
  const agents = readAgents(ws.state);
  assert.ok(agents.includes("# My project notes") && agents.includes("Do not remove this."), "existing content preserved");
  assert.ok(agents.startsWith("<!-- tonk-recorder:bootstrap:start -->"), "bootstrap block at the top (SPEC §3.3)");
  assert.match(agents, /# Tonk recorder bootstrap — generated; do not edit/);
  assert.match(agents, /mkdir -p ~\/\.tonk\/tools\/tonk-recorder\/0\.2\.0/);
  const rec = readJsonState(ws.state, "tool-records.json").at(-1);
  assert.ok(agents.includes(`blob cat ${rec.blob} > ~/.tonk/tools/tonk-recorder/0.2.0/tool.mjs`), "bootstrap fetches the blob");
  assert.ok(agents.includes(`install --expect-sha256 ${rec.sha256}`), "bootstrap carries the sha256");
  assert.match(agents, /decision/i, "decision instructions included (§6.7)");
});

test("bootstrap block works when pasted (offline: TONK_BIN stands in for `npx @tonk/cli`)", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  const agents = readAgents(ws.state);

  // extract the bootstrap block's commands and run the equivalent steps offline
  const catRef = agents.match(/blob cat (blob:[0-9a-f]{64})/);
  const sha = agents.match(/install --expect-sha256 ([0-9a-f]{64})/);
  const ver = agents.match(/tools\/tonk-recorder\/([0-9.]+)\/tool\.mjs/);
  assert.ok(catRef && sha && ver, "bootstrap block complete:\n" + agents);

  const home2 = path.join(ws.dir, "home2");
  const targetDir = path.join(home2, ".tonk", "tools", "tonk-recorder", ver[1]);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, "tool.mjs");

  // line 2 of the block: `... blob cat <blob-ref> > .../tool.mjs`
  const cat = await spawnNode(STUB_TONK, ["blob", "cat", catRef[1]], { cwd: ws.project, env: ws.env });
  assert.equal(cat.code, 0, cat.stderr);
  fs.writeFileSync(target, cat.stdout);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"), sha[1], "sha256 in the block matches the blob");

  // line 3 of the block: `node .../tool.mjs install --expect-sha256 <sha256>`
  const inst = await spawnNode(target, ["install", "--expect-sha256", sha[1], "--home", home2], { cwd: ws.project, env: ws.env });
  assert.equal(inst.code, 0, inst.stderr);
  assert.ok(fs.existsSync(path.join(home2, ".vibe", "plugins", "tonk-recorder", "plugin.json")), "plugin installed from the pasted block");
});
