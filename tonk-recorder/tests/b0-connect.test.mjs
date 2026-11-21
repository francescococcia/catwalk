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
  const pdir = pluginDirOf(ws.project);
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
  fs.mkdirSync(path.join(ws.project, ".claude"), { recursive: true });
  const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /claude: connected/);
  const settings = fs.readFileSync(path.join(ws.project, ".claude", "settings.json"), "utf8");
  assert.match(settings, /tonk-recorder/);
});

test("connect: no harness found is a readable error", async (t) => {
  const ws = makeWorkspace(t);
  fs.rmSync(path.join(ws.home, ".vibe"), { recursive: true, force: true });
  fs.rmSync(path.join(ws.project, ".claude"), { recursive: true, force: true });
  const r = await runCli(["connect"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no harness found/);
  assert.match(r.stderr, /connect --harness/);
});

const NO_REMOTE = { responses: [{ match: ["remote", "--json"], stdout: '{"schemaVersion":"tonk.remote-list.v1","rows":[]}' }] };
const HAS_REMOTE = { responses: [{ match: ["remote", "--json"], stdout: '{"schemaVersion":"tonk.remote-list.v1","rows":[{"name":"origin"}]}' }] };

test("invite on a local space: attaches it to tonk.foundation first, pushes, then mints the link", async (t) => {
  const ws = makeWorkspace(t, { scenario: NO_REMOTE });
  let r = await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const before = readCalls(ws.state).length;
  r = await runCli(["invite"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const calls = readCalls(ws.state).slice(before).map((c) => c.argv);
  const at = (pred) => calls.findIndex(pred);
  const link = calls.find((a) => a[0] === "space" && a[1] === "link");
  assert.deepEqual(link, ["space", "link", "projx", "--via", "https://tonk.foundation/settings/link"]);
  assert.ok(at((a) => a[1] === "link") < at((a) => a[0] === "push"), "attach, then push");
  assert.ok(at((a) => a[0] === "push") < at((a) => a[0] === "invite"), "push, then invite");
  assert.match(r.stdout, /sign in to Tonk there if asked/);
  assert.match(r.stdout, /join 'https:\/\/tonk\.example\.invalid\/join#stub-invite-token'/);
});

test("invite on a space that already has a remote: no attach, no sign-in", async (t) => {
  const ws = makeWorkspace(t, { scenario: HAS_REMOTE });
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  const before = readCalls(ws.state).length;
  const r = await runCli(["invite"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const calls = readCalls(ws.state).slice(before).map((c) => c.argv);
  assert.ok(!calls.some((a) => a[0] === "space" && a[1] === "link"));
  assert.ok(calls.some((a) => a[0] === "invite"));
});

test("invite: another deployment via TONK_RECORDER_DEPLOYMENT; a declined attach makes no invite", async (t) => {
  const ws = makeWorkspace(t, { scenario: NO_REMOTE });
  await runCli(["new", "projz"], { cwd: ws.project, env: ws.env });
  let r = await runCli(["invite"], { cwd: ws.project, env: { ...ws.env, TONK_RECORDER_DEPLOYMENT: "https://tonk.network/" } });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(readCalls(ws.state).map((c) => c.argv).find((a) => a[1] === "link")[4], "https://tonk.network/settings/link");

  const ws2 = makeWorkspace(t, { scenario: { responses: [...NO_REMOTE.responses, { match: ["space", "link"], exit: 1, stderr: "declined\n" }] } });
  await runCli(["new", "projq"], { cwd: ws2.project, env: ws2.env });
  r = await runCli(["invite"], { cwd: ws2.project, env: ws2.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /was not attached/);
  assert.ok(!readCalls(ws2.state).some((c) => c.argv[0] === "invite"), "no invite without a remote");
});
