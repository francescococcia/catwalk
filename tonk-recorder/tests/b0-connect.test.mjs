// `connect` — hooks the recorder into the harness before any space exists.
// Offline: fake HOME, stub tonk (which must never be called).
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt();
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkspace, runCli, readCalls, pluginDirOf } from "./b0-testkit.mjs";

test("connect: installs the bundled logic into a detected Vibe, touches no space", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.home, ".vibe"), { recursive: true });
  const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const pdir = pluginDirOf(ws.home);
  assert.ok(fs.existsSync(path.join(pdir, "plugin.json")), "plugin.json installed");
  assert.ok(fs.existsSync(path.join(pdir, "ai.mistral.vibe", "hooks.toml")), "hooks.toml installed");
  // (not compared byte-for-byte with dist/: other test files rebuild it in parallel)
  assert.match(fs.readFileSync(path.join(pdir, "tool.mjs"), "utf8"), /recorder logic, self-contained build/, "bundled logic installed");
  assert.match(r.stdout, /vibe: connected .*\/reload/);
  assert.match(r.stdout, /tonk-recorder(\.mjs")? new <space-name>/); // a checkout is called by path, a published install by name
  assert.equal(readCalls(ws.state).length, 0, "connect must not call tonk");
});

test("connect: is idempotent", async (t) => {
  const ws = makeWorkspace(t);
  fs.mkdirSync(path.join(ws.home, ".vibe"), { recursive: true });
  for (let i = 0; i < 2; i++) {
    const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
    assert.equal(r.code, 0, r.stderr + r.stdout);
  }
});

test("connect: installs into Claude Code when it is the harness present", async (t) => {
  const ws = makeWorkspace(t);
  fs.rmSync(path.join(ws.home, ".vibe"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ws.home, ".claude"), { recursive: true });
  const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /claude: connected/);
  const settings = fs.readFileSync(path.join(ws.home, ".claude", "settings.json"), "utf8");
  assert.match(settings, /tonk-recorder/);
});

test("connect: no harness found is a readable error", async (t) => {
  const ws = makeWorkspace(t);
  fs.rmSync(path.join(ws.home, ".vibe"), { recursive: true, force: true });
  fs.rmSync(path.join(ws.home, ".claude"), { recursive: true, force: true });
  const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no harness found/);
  assert.match(r.stderr, /connect --harness/);
});

test("new: attaches the space to tonk.foundation by default; --local skips it", async (t) => {
  const ws = makeWorkspace(t);
  let r = await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  let calls = readCalls(ws.state).map((c) => c.argv);
  const link = calls.find((a) => a[0] === "space" && a[1] === "link");
  assert.deepEqual(link, ["space", "link", "projx", "--via", "https://tonk.foundation/settings/link"]);
  const order = (pred) => calls.findIndex(pred);
  assert.ok(order((a) => a[1] === "new") < order((a) => a[1] === "link"), "linked right after creation");
  assert.ok(calls.some((a) => a[0] === "push"), "first push after linking");
  assert.match(r.stdout, /sign in to Tonk there if asked/);

  const ws2 = makeWorkspace(t);
  r = await runCli(["new", "projy", "--local"], { cwd: ws2.project, env: ws2.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  calls = readCalls(ws2.state).map((c) => c.argv);
  assert.ok(!calls.some((a) => a[0] === "space" && a[1] === "link"), "--local: no link");
});

test("new: another deployment via TONK_RECORDER_DEPLOYMENT", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["new", "projz"], { cwd: ws.project, env: { ...ws.env, TONK_RECORDER_DEPLOYMENT: "https://tonk.network/" } });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const link = readCalls(ws.state).map((c) => c.argv).find((a) => a[1] === "link");
  assert.equal(link[4], "https://tonk.network/settings/link");
});
