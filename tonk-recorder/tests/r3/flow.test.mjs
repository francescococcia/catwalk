// The in-harness flow: single-writer queue, link stripping, worktree
// lookup, and the role-aware session-start note. Offline, stub tonk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripLinks, LINK_REMOVED } from "../../src/hooks/links.mjs";
import { enqueue, drain, pending, failedCount, queueDir } from "../../src/hooks/queue.mjs";
import { resolveSpace } from "../../src/hooks/binding.mjs";
import { writeIdentity, rememberGitSpace } from "../../src/hooks/identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "..", "src", "hooks", "tool.mjs");
const STUB = path.join(HERE, "fixtures", "stub-tonk.mjs");

const git = (dir, args) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

function makeEnv(t, { queryDir } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  fs.mkdirSync(proj, { recursive: true });
  const regDir = path.join(home, "Library", "Application Support", "tonk");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(
    path.join(regDir, "spaces.json"),
    JSON.stringify({ spaces: { testspace: { site: path.join(root, "site") } }, bindings: { [proj]: "testspace" } }),
  );
  git(proj, ["init", "-q", "-b", "master", "."]);
  fs.writeFileSync(path.join(proj, "README.md"), "# proj\n");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "init"]);
  const env = {
    ...process.env, HOME: home, PLUGIN_DATA: path.join(root, "plugin-data"), TONK_BIN: STUB,
    STUB_LOG: path.join(root, "stub.log"), STUB_EVALS: path.join(root, "evals.log"),
    STUB_QUERY_DIR: queryDir || path.join(root, "no-queries"), TONK_SYNC_JITTER: "0", DO_NOT_TRACK: "1",
  };
  delete env.TONK_AGENT_NAME; delete env.TONK_SPACE;
  return { root, home, proj, env };
}
const payload = (event, cwd, extra = {}) => JSON.stringify({ hook_event_name: event, session_id: "s1", transcript_path: "/x", cwd, ...extra });
const runHook = (env, event, stdin) => spawnSync("node", [TOOL, "hook", event], { input: stdin, encoding: "utf8", env, timeout: 30000 });
const evalDocs = (env) => (fs.existsSync(env.STUB_EVALS) ? fs.readFileSync(env.STUB_EVALS, "utf8").split("\n---\n").filter((s) => s.trim()) : []);
const calls = (env) => (fs.existsSync(env.STUB_LOG) ? fs.readFileSync(env.STUB_LOG, "utf8").trim().split("\n").map(JSON.parse) : []);

test("links: tonk links are removed, ordinary links are kept", () => {
  assert.equal(stripLinks("join https://tonk.foundation/space/abc#k=zz now").text, `join ${LINK_REMOVED} now`);
  assert.equal(stripLinks("http://localhost:8787/@/a/b#tok").removed, 1);
  assert.equal(stripLinks("https://x.example/y?access=abc").removed, 1);
  assert.equal(stripLinks("see https://github.com/a/b#readme").removed, 0);
  assert.equal(stripLinks(null).text, null);
});

test("a pasted invite link never reaches the record: prompt, response and diff are stripped", (t) => {
  const e = makeEnv(t);
  const link = "https://tonk.foundation/space/abc123#key=SECRETKEY";
  assert.equal(runHook(e.env, "session-start", payload("session_start", e.proj)).status, 0);
  runHook(e.env, "pre-agent", payload("pre_agent", e.proj, { prompt: `join this ${link} please`, turn_id: "t1" }));
  fs.writeFileSync(path.join(e.proj, "notes.txt"), `invite: ${link}\n`);
  const r = runHook(e.env, "post-agent", payload("post_agent", e.proj, { turn_id: "t1", response_text: `Share ${link} with them` }));
  assert.equal(r.status, 0, r.stderr);
  const change = evalDocs(e.env).find((d) => d.includes("change!:"));
  assert.ok(change, "change record written");
  assert.ok(!change.includes("SECRETKEY") && !change.includes("abc123"), "no link in the record");
  assert.ok(change.includes(LINK_REMOVED));
  assert.match(change, /redacted: true/);
  // and nowhere in what was handed to tonk at all
  assert.ok(!JSON.stringify(calls(e.env)).includes("SECRETKEY"));
});

test("queue: a job the lock-holder cannot take stays queued, the next writer puts it in, in order", (t) => {
  const e = makeEnv(t);
  const dir = queueDir("testspace", e.env);
  fs.mkdirSync(path.join(dir, ".writer"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".writer", "pid"), String(process.pid)); // a live writer holds the lock
  const a = enqueue("testspace", { kind: "eval", doc: "note!: { body: \"first\" }\n" }, e.env);
  const b = enqueue("testspace", { kind: "eval", doc: "note!: { body: \"second\" }\n" }, e.env);
  const d1 = drain("testspace", e.env, { until: b, waitMs: 150 });
  assert.equal(d1.writer, false);
  assert.equal(pending("testspace", e.env).length, 2, "nothing lost while another writer holds the lock");
  assert.equal(evalDocs(e.env).length, 0);
  fs.rmSync(path.join(dir, ".writer"), { recursive: true });
  const d2 = drain("testspace", e.env);
  assert.equal(d2.writer, true);
  assert.equal(d2.results[a].status, "written");
  assert.deepEqual(evalDocs(e.env).map((d) => d.match(/"(first|second)"/)[1]), ["first", "second"]);
  assert.equal(pending("testspace", e.env).length, 0);
});

test("queue: a crashed writer's lock is taken over; a job tonk refuses is kept in failed/, not dropped", (t) => {
  const e = makeEnv(t);
  const dir = queueDir("testspace", e.env);
  fs.mkdirSync(path.join(dir, ".writer"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".writer", "pid"), "999999"); // no such process
  enqueue("testspace", { kind: "no-such-kind" }, e.env);
  const good = enqueue("testspace", { kind: "eval", doc: "x!: {}\n" }, e.env);
  const d = drain("testspace", e.env);
  assert.equal(d.results[good].status, "written", "a bad job does not block the ones behind it");
  assert.equal(d.writer, true, "stale lock recovered");
  assert.equal(pending("testspace", e.env).length, 0);
  assert.equal(failedCount("testspace", e.env), 1);
});

test("swarm: 5 agents x 4 turns at once on one space — every turn recorded, tonk never written to in parallel", async (t) => {
  const e = makeEnv(t);
  const sessions = ["a", "b", "c", "d", "e"];
  for (const s of sessions) runHook(e.env, "session-start", JSON.stringify({ hook_event_name: "session_start", session_id: s, cwd: e.proj }));
  const one = (s, n) =>
    new Promise((resolve) => {
      fs.appendFileSync(path.join(e.proj, `${s}.txt`), `line ${n}\n`);
      spawnSync("node", [TOOL, "hook", "pre-agent"], { env: e.env, input: JSON.stringify({ hook_event_name: "pre_agent", session_id: s, cwd: e.proj, turn_id: `${s}-t${n}`, prompt: `edit ${s} ${n}` }) });
      const child = spawn("node", [TOOL, "hook", "post-agent"], { env: e.env });
      child.on("close", resolve);
      child.stdin.end(JSON.stringify({ hook_event_name: "post_agent", session_id: s, cwd: e.proj, turn_id: `${s}-t${n}`, response_text: "done" }));
    });
  await Promise.all(sessions.map(async (s) => { for (let n = 1; n <= 4; n++) await one(s, n); }));
  drain("testspace", e.env, { waitMs: 10000 }); // what a later hook / checkpoint would do
  const turns = new Set(evalDocs(e.env).filter((d) => d.includes("change!:")).map((d) => d.match(/turn: "([^"]+)"/)[1]));
  assert.equal(turns.size, 20, `recorded ${turns.size}/20 turns`);
  assert.equal(pending("testspace", e.env).length, 0);
  assert.equal(failedCount("testspace", e.env), 0);
});

test("worktree: a git worktree of a connected repository resolves to the same space", (t) => {
  const e = makeEnv(t);
  assert.equal(rememberGitSpace(e.proj, "testspace"), true);
  const wt = path.join(e.root, "worktrees", "builder-1");
  git(e.proj, ["worktree", "add", "-q", "-b", "agent/builder-1", wt]);
  assert.deepEqual(resolveSpace(wt, { env: e.env }), { space: "testspace", source: "git-config" });
  // a space this machine does not have is not honoured
  git(e.proj, ["config", "tonk.space", "elsewhere"]);
  assert.equal(resolveSpace(wt, { env: e.env }), null);
  git(e.proj, ["config", "tonk.space", "testspace"]);
  // and the hook records from inside the worktree, naming the space to tonk
  const r = runHook(e.env, "session-start", payload("session_start", wt));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(evalDocs(e.env).some((d) => d.includes("session!:")));
  assert.ok(calls(e.env).every((c) => c.argv[0] === "--space" && c.argv[1] === "testspace"), "every tonk call names the space");
});

test("session-start note: the agent is told its role, the role's instructions, the others, its tasks and how to coordinate", (t) => {
  const q = fs.mkdtempSync(path.join(os.tmpdir(), "flow-q-"));
  t.after(() => fs.rmSync(q, { recursive: true, force: true }));
  const w = (c, rows) => fs.writeFileSync(path.join(q, `${c}.json`), JSON.stringify(rows));
  w("role", [
    { name: "builder", instructions: "You write the code. Claim a task first.", at: "2026-11-21T00:00:00Z" },
    { name: "reviewer", instructions: "You review what builders finish.", at: "2026-11-21T00:00:00Z" },
  ]);
  w("agent", [{ name: "rev-1", role: "reviewer", harness: "claude", at: "2026-11-21T10:00:00Z" }]);
  w("task", [
    { title: "Add login page", detail: "Email + password", for: "builder", by: "rev-1", at: "2026-11-21T11:00:00Z" },
    { title: "Old thing", detail: "x", for: "builder", by: "rev-1", at: "2026-11-21T09:00:00Z" },
    { title: "Review login", detail: "y", for: "reviewer", by: "b", at: "2026-11-21T11:30:00Z" },
  ]);
  w("task-status", [{ task: "Old thing", status: "done", by: "b0", note: "shipped", at: "2026-11-21T09:30:00Z" }]);
  w("note", [{ to: "builder", from: "rev-1", body: "Use the session helper", at: "2026-11-21T11:05:00Z" }]);
  const e = makeEnv(t, { queryDir: q });
  writeIdentity(e.proj, { space: "testspace", agent: "build-1", role: "builder", harness: "vibe" }, e.env);

  const r = runHook(e.env, "session-start", payload("session_start", e.proj));
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hook_specific_output.additional_context;
  assert.match(ctx, /agent `build-1`, playing the role `builder`/);
  assert.match(ctx, /Recording to Tonk space testspace as build-1 \(builder\)/);
  assert.match(ctx, /## Your role: builder\n\nYou write the code\. Claim a task first\./);
  assert.match(ctx, /`rev-1` — reviewer \(claude\)/);
  assert.match(ctx, /"Add login page" \[open\] — from rev-1/);
  assert.ok(!ctx.includes('"Old thing"'), "finished tasks are not listed");
  assert.ok(!ctx.includes('"Review login"'), "another role's tasks are not listed");
  assert.match(ctx, /from rev-1 .*Use the session helper/);
  assert.match(ctx, /tonk --space testspace eval --no-sync -c 'task-status!:/);
  assert.match(ctx, /## Accepted decisions/, "decisions section still follows");
  // the agent registered itself under its role, once
  const reg = evalDocs(e.env).filter((d) => d.includes("agent!:"));
  assert.equal(reg.length, 1);
  assert.match(reg[0], /name: "build-1"\n  role: "builder"/);
  runHook(e.env, "session-start", payload("session_start", e.proj));
  assert.equal(evalDocs(e.env).filter((d) => d.includes("agent!:")).length, 1, "not registered twice");
});

test("session-start note: an agent with no role is told to take one", (t) => {
  const q = fs.mkdtempSync(path.join(os.tmpdir(), "flow-q-"));
  t.after(() => fs.rmSync(q, { recursive: true, force: true }));
  fs.writeFileSync(path.join(q, "role.json"), JSON.stringify([{ name: "builder", instructions: "You write the code.", at: "x" }]));
  const e = makeEnv(t, { queryDir: q });
  const ctx = JSON.parse(runHook(e.env, "session-start", payload("session_start", e.proj)).stdout).hook_specific_output.additional_context;
  assert.match(ctx, /## You have no role yet/);
  assert.match(ctx, /tonk-recorder role <name>/);
});

test("a brand-new project (git init, no commits yet) still records its first turn", (t) => {
  const e = makeEnv(t);
  const fresh = path.join(e.root, "fresh");
  fs.mkdirSync(fresh);
  git(fresh, ["init", "-q", "-b", "main", "."]);
  const reg = path.join(e.home, "Library", "Application Support", "tonk", "spaces.json");
  const j = JSON.parse(fs.readFileSync(reg, "utf8"));
  j.bindings[fresh] = "testspace";
  fs.writeFileSync(reg, JSON.stringify(j));
  assert.equal(runHook(e.env, "session-start", payload("session_start", fresh)).status, 0);
  runHook(e.env, "pre-agent", payload("pre_agent", fresh, { prompt: "start the site", turn_id: "t1" }));
  fs.writeFileSync(path.join(fresh, "index.html"), "<h1>hi</h1>\n");
  const r = runHook(e.env, "post-agent", payload("post_agent", fresh, { turn_id: "t1", response_text: "done" }));
  assert.equal(r.stderr, "", "no fail-open error");
  const change = evalDocs(e.env).find((d) => d.includes("change!:"));
  assert.ok(change, "change record written");
  assert.match(change, /branch: "main"/);
  assert.match(change, /commit: "\(no commits yet\)"/);
});
