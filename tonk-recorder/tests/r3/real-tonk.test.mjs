// R3 integration against the REAL tonk 0.8.0 (offline: local --site space under
// a fake HOME, no upstream). Proves a post-agent turn writes one real `change`
// record via `tonk eval --no-sync`. Run: node --test tests/r3/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const TOOL = path.join(ROOT, "src", "hooks", "tool.mjs");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

test("REAL tonk 0.8.0: post-agent writes one queryable change record (offline local space)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r3real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  const pd = path.join(root, "plugin-data");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(pd, { recursive: true });
  const env = { ...process.env, HOME: home, PLUGIN_DATA: pd, TONK_AGENT_NAME: "agent-a", DO_NOT_TRACK: "1" };
  const tonk = (args, input) =>
    spawnSync("tonk", args, { input, encoding: "utf8", env, cwd: proj, timeout: 60000 });

  // local-only space bound to proj + structure pack
  assert.equal(tonk(["space", "new", "r3real", "--site", path.join(root, "site")]).status, 0);
  assert.equal(tonk(["eval", path.join(ROOT, "packs", "recorder.notation")]).status, 0);

  git(proj, ["init", "-q", "-b", "main", "."]);
  fs.writeFileSync(path.join(proj, "README.md"), "# p\n");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "init"]);

  const stdin = (f) =>
    fs.readFileSync(path.join(HERE, "fixtures", "stdin", f), "utf8").replaceAll("{{CWD}}", proj);
  const hook = (ev, f) =>
    spawnSync("node", [TOOL, "hook", ev], { input: stdin(f), encoding: "utf8", env, timeout: 60000 });

  assert.equal(hook("session-start", "session-start.json").status, 0);
  assert.equal(hook("pre-agent", "pre-agent.json").status, 0);
  fs.writeFileSync(path.join(proj, "src.js"), 'const k = "sk-abc123def456ghi789";\n');
  const post = hook("post-agent", "post-agent.json");
  assert.equal(post.status, 0, post.stderr);

  const q = tonk(["query", "change", "--json"]);
  const rows = JSON.parse(q.stdout);
  assert.equal(rows.length, 1, "exactly one change record");
  const c = rows[0];
  assert.equal(c.session, "sess-1");
  assert.equal(c.turn, "turn-1");
  assert.equal(c.agent, "agent-a");
  assert.ok(c.redacted === true || c.redacted === "true", `redacted=true, got ${c.redacted}`);
  assert.ok(String(c.diff).includes("[redacted]"), "secret redacted in stored diff");
  assert.ok(!String(c.diff).includes("sk-abc123def456ghi789"));
  const files = JSON.parse(tonk(["query", "change-file", "--json"]).stdout);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src.js");
  assert.equal(files[0].status, "added:");

  // session record written at session-start, updated at session-end
  assert.equal(hook("session-end", "session-end.json").status, 0);
  const sessions = JSON.parse(tonk(["query", "session", "--json"]).stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "sess-1");
  assert.ok(sessions[0].changes === 1 || sessions[0].changes === "1", `changes=1, got ${sessions[0].changes}`);
  assert.ok(sessions[0].ended, "ended set at session-end");
});
