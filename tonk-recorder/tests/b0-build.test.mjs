// B0 build tests — the single-file dist/tool.mjs is self-contained and its
// install path verifies sha256 (SPEC §3.3/§8).
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt(); // fresh-checkout safe: dist/ is gitignored
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeWorkspace, runCli, runTool, pluginDirOf, DIST_TOOL } from "./b0-testkit.mjs";

test("build: produces a self-contained dist/tool.mjs that runs standalone", async (t) => {
  const ws = makeWorkspace(t);
  const r = await runCli(["build"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(DIST_TOOL));
  const src = fs.readFileSync(DIST_TOOL, "utf8");
  assert.match(src, /^#!\/usr\/bin\/env node/);
  assert.ok(src.includes("data:text/javascript;base64,"), "components embedded as data URLs");

  // runs with no repo around: version + instructions work offline
  const v = await runTool(["version"], { cwd: ws.project, env: { ...ws.env, TONK_BIN: "/nonexistent" } });
  assert.equal(v.code, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const ins = await runTool(["instructions"], { cwd: ws.project, env: ws.env });
  assert.equal(ins.code, 0);
  assert.match(ins.stdout, /decision/i);
});

test("dist tool install: refuses a wrong --expect-sha256, accepts the right one", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["build"], { cwd: ws.project, env: ws.env });
  const sha = crypto.createHash("sha256").update(fs.readFileSync(DIST_TOOL)).digest("hex");

  const bad = await runTool(["install", "--expect-sha256", "0".repeat(64), "--home", ws.home], { cwd: ws.project, env: ws.env });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /sha256 mismatch/);
  assert.ok(!fs.existsSync(pluginDirOf(ws.home)), "nothing installed on mismatch");

  const good = await runTool(["install", "--expect-sha256", sha, "--home", ws.home], { cwd: ws.project, env: ws.env });
  assert.equal(good.code, 0, good.stderr);
  const pdir = pluginDirOf(ws.home);
  assert.ok(fs.existsSync(path.join(pdir, "plugin.json")));
  assert.ok(fs.existsSync(path.join(pdir, "tool.mjs")));
  assert.ok(fs.existsSync(path.join(pdir, "ai.mistral.vibe", "hooks.toml")));
  // installed tool.mjs is byte-identical to the verified source
  assert.equal(fs.readFileSync(path.join(pdir, "tool.mjs")).toString(), fs.readFileSync(DIST_TOOL).toString());
});

test("dist tool hook session-start: unbound (no tonk) → exit 0, tells the agent how to connect", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["build"], { cwd: ws.project, env: ws.env });
  const r = await runTool(["hook", "session-start"], {
    cwd: ws.project,
    env: { ...ws.env, TONK_BIN: "/nonexistent-tonk" },
    input: JSON.stringify({ hook_event_name: "session_start", session_id: "s1", cwd: ws.project }),
  });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).hook_specific_output.additional_context, /not connected to a Tonk space/, "unbound: nothing recorded, agent told how to connect");
});
