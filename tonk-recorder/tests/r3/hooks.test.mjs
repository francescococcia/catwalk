// R3 tests — hook runtime driven by fixture stdin (W0 fixtures/hooks/* on
// master use /tmp/fake-home paths, so these tests generate equivalent stdin
// with the real tmp cwd; shape per contracts/hooks.md) with a stub tonk via
// TONK_BIN and a fake HOME holding tonk's spaces.json registry.
// Fully offline. Run: node --test tests/r3/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "..", "src", "hooks", "tool.mjs");
const STUB = path.join(HERE, "fixtures", "stub-tonk.mjs");
const STDIN = (f) => path.join(HERE, "fixtures", "stdin", f);
const QUERY_DIR = path.join(HERE, "fixtures", "query");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function makeEnv(t, { bound = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });
  if (bound) {
    const regDir = path.join(home, "Library", "Application Support", "tonk");
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(
      path.join(regDir, "spaces.json"),
      JSON.stringify({ spaces: { testspace: { site: path.join(root, "site") } }, bindings: { [fs.realpathSync(proj)]: "testspace" } }),
    );
  }
  git(proj, ["init", "-q", "-b", "main", "."]);
  fs.writeFileSync(path.join(proj, "README.md"), "# proj\n");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "init"]);

  const env = {
    ...process.env,
    HOME: home,
    PLUGIN_DATA: pluginData,
    TONK_BIN: STUB,
    TONK_AGENT_NAME: "agent-a",
    TONK_SYNC_JITTER: "0",
    STUB_LOG: path.join(root, "stub.log"),
    STUB_EVALS: path.join(root, "evals.log"),
    STUB_QUERY_DIR: QUERY_DIR,
    DO_NOT_TRACK: "1",
  };
  return { root, home, proj, pluginData, env };
}

const stdinFor = (file, cwd) => fs.readFileSync(STDIN(file), "utf8").replaceAll("{{CWD}}", cwd);

function runHook(env, event, stdin, extraArgs = []) {
  const t0 = Date.now();
  const r = spawnSync("node", [TOOL, "hook", event, ...extraArgs], { input: stdin, encoding: "utf8", env, timeout: 30000 });
  return { ...r, durationMs: Date.now() - t0 };
}

const stubCalls = (env) =>
  fs.existsSync(env.STUB_LOG) ? fs.readFileSync(env.STUB_LOG, "utf8").trim().split("\n").map(JSON.parse) : [];
const evalDocs = (env) =>
  fs.existsSync(env.STUB_EVALS) ? fs.readFileSync(env.STUB_EVALS, "utf8").split("\n---\n").filter((s) => s.trim()) : [];
const isPullPush = (c) => /(^| )pull$|(^| )push$/.test(c);

test("unbound folder: zero tonk calls; session-start tells the agent how to connect, other events say nothing", (t) => {
  const e = makeEnv(t, { bound: false });
  const r = runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hook_specific_output.additional_context;
  assert.match(ctx, /not connected to a Tonk space/);
  assert.match(ctx, /tonk-recorder new <space-name>/);
  assert.match(ctx, /tonk-recorder join '<link>'/);
  assert.match(ctx, /never repeat it back/);
  assert.ok(r.durationMs < 400, `unbound session-start took ${r.durationMs}ms`);
  const r2 = runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, "");
  assert.deepEqual(stubCalls(e.env), []);
});

test("session-start: snapshot + session record + checkpoint + additional_context with age/decisions/others", (t) => {
  const e = makeEnv(t);
  fs.mkdirSync(path.join(e.pluginData, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(e.pluginData, "state", "sess-1.json"),
    JSON.stringify({ turns: 4, lastCheckpointAt: null, lastSeenOtherAgentAt: "2026-11-20T00:00:00Z", agentName: "agent-a" }),
  );
  const r = runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hook_specific_output?.additional_context, "context nested under hook_specific_output (where Vibe reads it)");
  assert.equal(out.additional_context, undefined, "not top-level: Vibe ignores it there");
  const ctx = out.hook_specific_output.additional_context;
  assert.match(ctx, /decision/i, "decision instructions included");
  assert.match(ctx, /as of \d+ turns? ago/, "local copy age stated");
  assert.match(ctx, /Use SQLite for local state/, "accepted decision listed");
  assert.ok(!ctx.includes("Use Postgres"), "rejected decision not listed");
  assert.match(ctx, /- agent-b: add tests for auth — files: tests\/auth\.test\.js/, "other agent's change, one line, files from lens");
  assert.ok(!ctx.includes("my own earlier change"), "own changes excluded");
  const calls = stubCalls(e.env).map((c) => c.argv.join(" "));
  assert.ok(calls.some((c) => /(^| )pull$/.test(c)), "checkpoint pull");
  assert.ok(calls.some((c) => /(^| )push$/.test(c)), "checkpoint push");
  const docs = evalDocs(e.env);
  assert.equal(docs.length, 1, "one eval on session-start (session record)");
  assert.match(docs[0], /session!:\n {2}id: "sess-1"\n {2}agent: "agent-a"\n {2}harness: :vibe\n {2}project: "proj"\n {2}started: "[^"]+"\n {2}changes: 0/);
  // snapshot saved per contracts/layout.md
  const tree = fs.readFileSync(path.join(e.pluginData, "snapshots", "sess-1.tree"), "utf8").trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
});

test("pre-agent stashes prompt under turn_id; post-agent writes one redacted change, no network, <2s", (t) => {
  const e = makeEnv(t);
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  const pre = runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, "");
  const stashed = JSON.parse(fs.readFileSync(path.join(e.pluginData, "prompts", "sess-1", "turn-1.json"), "utf8"));
  assert.equal(stashed.prompt, "add a login endpoint\nwith tests");

  fs.mkdirSync(path.join(e.proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(e.proj, "src", "auth.js"), 'const key = "sk-abc123def456ghi789";\nexport function login() {}\n');

  const post = runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  assert.equal(post.status, 0, post.stderr);
  assert.equal(post.stdout, "", "post-agent outputs nothing");
  assert.ok(post.durationMs < 2000, `non-checkpoint post-agent took ${post.durationMs}ms (must be <2s)`);

  const calls = stubCalls(e.env).map((c) => c.argv.join(" "));
  const evals = calls.filter((c) => /(^| )eval /.test(c));
  assert.equal(evals.length, 2, "session record (session-start) + exactly one change eval --no-sync for the turn");
  assert.ok(evals.every((c) => c.includes("--no-sync")), "evals are --no-sync");
  assert.equal(calls.filter(isPullPush).length, 2, "only session-start's checkpoint pulled+pushed; turn 1 had no sync");
  const docs = evalDocs(e.env);
  assert.equal(docs.length, 2, "session record + change record");
  const doc = docs[1];
  assert.match(doc, /change!:\n {2}this: \?c\n {2}session: "sess-1"\n {2}turn: "turn-1"\n {2}agent: "agent-a"\n {2}harness: :vibe/);
  assert.match(doc, /prompt: "add a login endpoint\\nwith tests"/);
  assert.match(doc, /response: "added POST \/login in src\/auth\.js"/);
  assert.match(doc, /branch: "main"/);
  assert.match(doc, /commit: "[0-9a-f]{40}"/);
  assert.match(doc, /base: "[0-9a-f]{40}"\n {2}head: "[0-9a-f]{40}"/);
  assert.match(doc, /change-file!:\n {2}change: \?c\n {2}path: "src\/auth\.js"\n {2}status: :added\n {2}added: 2\n {2}removed: 0/);
  assert.match(doc, /redacted: true/);
  assert.ok(doc.includes("[redacted]"), "secret redacted in stored diff");
  assert.ok(!doc.includes("sk-abc123def456ghi789"), "secret absent from stored diff");
  assert.match(doc, /diff: "/); // R2 emits the inline diff as a quoted string
});

test("post-agent with no changes writes nothing", (t) => {
  const e = makeEnv(t);
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  const before = evalDocs(e.env).length;
  const post = runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  assert.equal(post.status, 0);
  assert.equal(evalDocs(e.env).length, before, "empty diff -> no change record");
});

test("checkpoint every N turns (TONK_CHECKPOINT_INTERVAL=2): 2nd post-agent pulls+pushes", (t) => {
  const e = makeEnv(t);
  e.env.TONK_CHECKPOINT_INTERVAL = "2";
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  const n0 = stubCalls(e.env).length;
  fs.writeFileSync(path.join(e.proj, "a.txt"), "1\n");
  runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj)); // turn 1
  const after1 = stubCalls(e.env).slice(n0).map((c) => c.argv.join(" "));
  assert.ok(after1.some((c) => /(^| )eval /.test(c)), "turn 1 wrote via eval");
  assert.ok(!after1.some(isPullPush), "turn 1: no sync (interval 2)");
  fs.writeFileSync(path.join(e.proj, "a.txt"), "1\n2\n");
  runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj)); // turn 2 -> checkpoint
  const after2 = stubCalls(e.env).slice(n0).map((c) => c.argv.join(" "));
  assert.ok(after2.some((c) => /(^| )pull$/.test(c)), "turn 2 pulled");
  assert.ok(after2.some((c) => /(^| )push$/.test(c)), "turn 2 pushed");
});

test("session-end updates session record (ended + changes count) + checkpoint + clears prompts", (t) => {
  const e = makeEnv(t);
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  fs.writeFileSync(path.join(e.proj, "a.txt"), "x\n");
  runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  const end = runHook(e.env, "session-end", stdinFor("session-end.json", e.proj));
  assert.equal(end.status, 0);
  const docs = evalDocs(e.env);
  const last = docs[docs.length - 1];
  assert.match(last, /session:\n {2}this: \?s\n {2}id: "sess-1"\n\nsession!:\n {2}this: \?s\n {2}ended: "[^"]+"\n {2}changes: 1/);
  const calls = stubCalls(e.env).map((c) => c.argv.join(" "));
  const tail = calls.slice(-2);
  assert.ok(tail.some((c) => /(^| )pull$/.test(c)) && tail.some((c) => /(^| )push$/.test(c)), "session-end checkpoint");
  assert.ok(!fs.existsSync(path.join(e.pluginData, "prompts", "sess-1")), "prompts cleared at session-end");
});

test("any git branch records (agents work on master, agent/<name> worktrees, …)", (t) => {
  const e = makeEnv(t);
  git(e.proj, ["checkout", "-qb", "agent/builder-1"]);
  const r = runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).hook_specific_output.additional_context, "context delivered on a non-main git branch");
  assert.ok(evalDocs(e.env).some((d) => d.includes("session!:")), "session record written");
});

test("not a git repo: one warning per session, nothing recorded", (t) => {
  const e = makeEnv(t);
  const notRepo = path.join(e.root, "notrepo");
  fs.mkdirSync(notRepo);
  const reg = path.join(e.home, "Library", "Application Support", "tonk", "spaces.json");
  const j = JSON.parse(fs.readFileSync(reg, "utf8"));
  j.bindings[fs.realpathSync(notRepo)] = "testspace";
  fs.writeFileSync(reg, JSON.stringify(j));
  const r1 = runHook(e.env, "session-start", stdinFor("session-start.json", notRepo));
  assert.equal(r1.status, 0);
  assert.match(r1.stderr, /not a git repo/);
  const r2 = runHook(e.env, "session-start", stdinFor("session-start.json", notRepo));
  assert.equal(r2.stderr, "", "warned only once per session");
  assert.deepEqual(stubCalls(e.env), []);
});

test("write lock: eval exit 4 (revision.lock collision) is retried and succeeds", (t) => {
  const e = makeEnv(t);
  e.env.STUB_EVAL_FAIL_TIMES = "2";
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  fs.writeFileSync(path.join(e.proj, "a.txt"), "x\n");
  runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  const post = runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  assert.equal(post.status, 0, post.stderr);
  const evalCalls = stubCalls(e.env).filter((c) => /(^| )eval /.test(c.argv.join(" "))).length;
  assert.equal(evalCalls, 4, "session eval retried past 2 collisions (3 calls) + change eval (1 call)");
  const docs = evalDocs(e.env);
  assert.ok(docs.some((d) => /change!:\n {2}this: \?c\n {2}session: "sess-1"\n {2}turn: "turn-1"/.test(d)), "change written after retries");
});

test("idempotency: same (session,turn) already in space -> no second write", (t) => {
  const e = makeEnv(t);
  // point the stub at a private query dir where turn-1 is already recorded
  const qdir = path.join(e.root, "query");
  fs.mkdirSync(qdir, { recursive: true });
  for (const f of fs.readdirSync(QUERY_DIR)) fs.copyFileSync(path.join(QUERY_DIR, f), path.join(qdir, f));
  fs.writeFileSync(
    path.join(qdir, "change.json"),
    JSON.stringify([{ this: "did:key:x", session: "sess-1", turn: "turn-1", agent: "agent-a", at: "2026-11-21T09:00:00Z" }]) + "\n",
  );
  e.env.STUB_QUERY_DIR = qdir;
  runHook(e.env, "session-start", stdinFor("session-start.json", e.proj));
  fs.writeFileSync(path.join(e.proj, "a.txt"), "x\n");
  runHook(e.env, "pre-agent", stdinFor("pre-agent.json", e.proj));
  runHook(e.env, "post-agent", stdinFor("post-agent.json", e.proj));
  const docs = evalDocs(e.env);
  assert.equal(docs.length, 1, "only the session record; change skipped (turn already recorded)");
  assert.match(docs[0], /session!:/);
});

test("TONK_SPACE beats registry binding; --space beats TONK_SPACE; subdir resolves via ancestor", async (t) => {
  const { resolveSpace } = await import("../../src/hooks/binding.mjs");
  const e = makeEnv(t);
  assert.equal(resolveSpace(e.proj, { env: e.env }).space, "testspace");
  assert.equal(resolveSpace(e.proj, { env: e.env }).source, "binding");
  assert.equal(resolveSpace(e.proj, { env: { ...e.env, TONK_SPACE: "envspace" } }).space, "envspace");
  assert.equal(resolveSpace(e.proj, { env: { ...e.env, TONK_SPACE: "envspace" }, spaceArg: "argspace" }).space, "argspace");
  const sub = path.join(e.proj, "deep", "deeper");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveSpace(sub, { env: e.env }).space, "testspace");
});

test("claude harness: SessionStart payload -> { additionalContext } output", (t) => {
  const e = makeEnv(t);
  const payload = { hook_event_name: "SessionStart", session_id: "cc-1", transcript_path: "/tmp/fake/t.jsonl", cwd: e.proj };
  const r = runHook(e.env, "session-start", JSON.stringify(payload), ["--harness", "claude"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("decision"), "context nested under hookSpecificOutput (where Claude Code reads it)");
  assert.equal(out.additionalContext, undefined, "not top-level");
});
