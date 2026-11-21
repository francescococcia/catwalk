// B0 wrapper shell tests — offline, TONK_BIN stub tonk + fake HOME.
// Done-when (SPEC §9.2 B0): with TONK_BIN at a stub and a fake HOME, `new` on a
// clean temp dir runs the full sequence and prints the paste line; `join`
// installs the plugin layout; tonk errors pass through readably.
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt(); // fresh-checkout safe: dist/ is gitignored
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  makeWorkspace, runCli, readCalls, readJsonState, readAgents, pluginDirOf, setupBoundRepo,
  FAKE_LINK, DIST_TOOL, STUB_TONK,
} from "./b0-testkit.mjs";

test("new: full sequence on a clean temp dir + paste line", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["new", "projx", "--agent-name", "ada"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);

  const calls = readCalls(ws.state).map((c) => c.argv);
  const flat = calls.map((a) => a.slice(0, 2).join(" ")).join("\n");
  // 1. space new (binds cwd), 2. structure pack eval, 3. blob add of dist logic,
  //    trusted-publisher + tool record evals, AGENTS.md get/set, invite
  assert.ok(calls.some((a) => a[0] === "space" && a[1] === "new" && a[2] === "projx"), "space new called: " + flat);
  assert.ok(calls.some((a) => a[0] === "eval" && a.includes("--no-sync")), "structure pack eval: " + flat);
  assert.ok(calls.some((a) => a[0] === "blob" && a[1] === "add"), "blob add of the logic file: " + flat);
  assert.ok(calls.some((a) => a[0] === "eval" && a.includes("-c") && a[a.length - 1].includes("trusted-publisher!:")), "trusted-publisher record asserted");
  assert.ok(calls.some((a) => a[0] === "eval" && a.includes("-c") && a[a.length - 1].includes("tool!:")), "tool record asserted");
  assert.ok(calls.some((a) => a[0] === "space" && a[1] === "agents" && a[2] === "get"), "agents get");
  assert.ok(calls.some((a) => a[0] === "space" && a[1] === "agents" && a[2] === "set"), "agents set");
  assert.ok(calls.some((a) => a[0] === "invite"), "invite minted");

  // paste line on stdout (link printed, never written to files — SPEC §8)
  assert.match(r.stdout, /npx --yes tonk-recorder join 'https:\/\/tonk\.example\.invalid\/join#stub-invite-token' --agent-name/);

  // hooks installed into the (fake) harness — §4.1 plugin layout
  const pdir = pluginDirOf(ws.home);
  const manifest = JSON.parse(fs.readFileSync(path.join(pdir, "plugin.json"), "utf8"));
  assert.equal(manifest.name, "tonk-recorder");
  assert.equal(manifest.version, "0.1.0");
  assert.ok(fs.existsSync(path.join(pdir, "tool.mjs")), "tool.mjs installed");
  const hooks = fs.readFileSync(path.join(pdir, "ai.mistral.vibe", "hooks.toml"), "utf8");
  for (const h of ["session_start", "pre_agent", "post_agent", "session_end"]) {
    assert.ok(hooks.includes(h), "hooks.toml has " + h);
  }
});

test("join: installs the plugin layout from the space (verify + sha256)", async (t) => {
  const ws = makeWorkspace(t);
  const created = await runCli(["new", "projx", "--agent-name", "ada"], { cwd: ws.project, env: ws.env });
  assert.equal(created.code, 0, created.stderr);
  const link = FAKE_LINK;

  // a second agent on a "clean" machine: fresh HOME, same space state
  const home2 = path.join(ws.dir, "home2");
  fs.mkdirSync(home2, { recursive: true });
  const env2 = { ...ws.env, HOME: home2 };
  const r = await runCli(["join", link, "--agent-name", "bob"], { cwd: ws.project, env: env2 });
  assert.equal(r.code, 0, r.stderr);

  const calls = readCalls(ws.state).map((c) => c.argv);
  assert.ok(calls.some((a) => a[0] === "join" && a[1] === link && a.includes("--agent-name") && a.includes("bob")), "tonk join with link + agent-name");
  assert.ok(calls.some((a) => a[0] === "query" && a[1] === "tool"), "tool record queried");
  assert.ok(calls.some((a) => a[0] === "query" && a[1] === "trusted-publisher"), "trusted-publisher queried");
  assert.ok(calls.some((a) => a[0] === "blob" && a[1] === "cat" && a[2].startsWith("blob:")), "blob fetched");

  // plugin layout installed for the joining agent
  const pdir = pluginDirOf(home2);
  assert.ok(fs.existsSync(path.join(pdir, "plugin.json")), "plugin.json installed");
  const staged = path.join(home2, ".tonk", "tools", "tonk-recorder", "0.1.0", "tool.mjs");
  assert.ok(fs.existsSync(staged), "staged at §3.3 bootstrap path");
  // staged bytes == the published blob bytes (sha256 verified on the way in)
  const records = readJsonState(ws.state, "tool-records.json");
  const rec = records[records.length - 1];
  const blobFile = path.join(ws.state, "blobs", rec.blob.replace("blob:", ""));
  assert.ok(fs.existsSync(blobFile));
  assert.equal(fs.readFileSync(staged).toString(), fs.readFileSync(blobFile).toString());
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(staged)).digest("hex"), rec.sha256);
});

test("join: refuses a tampered blob (sha256 mismatch)", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  // tamper with the stored blob after publish
  const records = readJsonState(ws.state, "tool-records.json");
  const rec = records[records.length - 1];
  fs.writeFileSync(path.join(ws.state, "blobs", rec.blob.replace("blob:", "")), "// tampered\n");
  const home2 = path.join(ws.dir, "home2");
  fs.mkdirSync(home2, { recursive: true });
  const r = await runCli(["join", FAKE_LINK, "--agent-name", "mallory"], { cwd: ws.project, env: { ...ws.env, HOME: home2 } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /sha256 mismatch/i);
  assert.ok(!fs.existsSync(pluginDirOf(home2)), "nothing installed");
});

test("join: refuses an untrusted publisher (SPEC §8)", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  // space's trusted-publisher list no longer contains the tool publisher
  const { writeJsonState } = await import("./b0-testkit.mjs");
  writeJsonState(ws.state, "trusted-publishers.json", []);
  const home2 = path.join(ws.dir, "home2");
  fs.mkdirSync(home2, { recursive: true });
  const r = await runCli(["join", FAKE_LINK, "--agent-name", "bob"], { cwd: ws.project, env: { ...ws.env, HOME: home2 } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /trusted-publisher/i);
});

test("sync: one checkpoint = tonk pull + tonk push, in order", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["sync", "--no-jitter"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /synced/);
  const calls = readCalls(ws.state).map((c) => c.argv[0]);
  assert.deepEqual(calls, ["pull", "push"]);
});

test("sync: tonk failure passes through readably and exits non-zero", async (t) => {
  const ws = makeWorkspace(t, { scenario: { responses: [{ match: ["pull"], exit: 1, stderr: "no upstream configured\n" }] } });
  const r = await runCli(["sync", "--no-jitter"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tonk pull failed \(exit 1\): no upstream configured/);
});

test("new: tonk error passes through readably with the child exit code", async (t) => {
  const ws = makeWorkspace(t, { scenario: { responses: [{ match: ["space", "new"], exit: 3, stderr: "boom: invalid space name\n" }] } });
  const r = await runCli(["new", "Bad Name"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /tonk space new .* failed \(exit 3\): boom: invalid space name/);
});

test("invite: prints the link + paste line to stdout only", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["invite"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(FAKE_LINK));
  assert.match(r.stdout, /npx --yes tonk-recorder join '/);
  // never written into any file under the fake HOME or project
  const homeFiles = fs.readdirSync(ws.home, { recursive: true }).join("\n");
  const projFiles = fs.readdirSync(ws.project, { recursive: true }).join("\n");
  assert.ok(!homeFiles.includes("stub-invite-token") && !projFiles.includes("stub-invite-token"));
});

test("status: shows binding + hook state after new", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  const r = await runCli(["status"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /plugin: installed at .*tonk-recorder \(v0\.1\.0\)/);
  assert.match(r.stdout, /hooks:.*present/);
});

test("uninstall: removes plugin + local state", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  assert.ok(fs.existsSync(pluginDirOf(ws.home)));
  const r = await runCli(["uninstall"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(pluginDirOf(ws.home)), "plugin dir removed");
  assert.ok(!fs.existsSync(path.join(ws.home, ".tonk", "tools", "tonk-recorder")), "tools cache removed");
});

test("hook: delegates to the installed logic (session-start, same version → no update notice)", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  setupBoundRepo(ws); // R3 runtime needs a bound git repo for session-start
  const r = await runCli(["hook", "session-start"], {
    cwd: ws.project,
    env: ws.env,
    input: JSON.stringify({ hook_event_name: "session_start", session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: ws.project }),
  });
  assert.equal(r.code, 0, r.stderr);
  // R3 ran: additional_context present; same published version → no system_message
  assert.match(r.stdout, /additional_context/);
  assert.ok(!r.stdout.includes("system_message"), "no update notice at same version: " + r.stdout);
});
test("wrapper never falls back to PATH tonk", async (t) => {
  const ws = makeWorkspace(t);
  const envNoBin = { ...ws.env };
  delete envNoBin.TONK_BIN;
  // plant a sentinel `tonk` on PATH: if the wrapper ever uses it, output shows it
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-tonk-"));
  fs.writeFileSync(path.join(fakeBin, "tonk"), "#!/bin/sh\necho PATH-TONK-USED >&2\nexit 9\n");
  fs.chmodSync(path.join(fakeBin, "tonk"), 0o755);
  envNoBin.PATH = `${fakeBin}:${envNoBin.PATH || ""}`;
  const r = await runCli(["sync", "--no-jitter"], { cwd: ws.project, env: envNoBin });
  const all = (r.stdout || "") + (r.stderr || "");
  assert.ok(!all.includes("PATH-TONK-USED"), "wrapper must not use PATH tonk: " + all);
  // with deps installed the pinned dep is used (tonk's own exit code passes
  // through, e.g. 4 for a local-only space with no remote); without deps, a
  // readable error. Either way: never the PATH sentinel.
  if (r.code === 1) {
    assert.match(r.stderr, /TONK_BIN|pinned @tonk\/cli/);
  }
});
