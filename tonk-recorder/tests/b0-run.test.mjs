// `run add` / `replay` — an agent's own by-hand account, scanned on the way in.
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt();
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkspace, runCli, readCalls } from "./b0-testkit.mjs";
import { buildRunDoc, clean } from "../src/cli/commands/run.mjs";

test("run add: one eval through the single writer, ordered steps, links and secrets removed", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx"], { cwd: ws.project, env: ws.env });
  const before = readCalls(ws.state).length;
  const r = await runCli([
    "run", "add", "--tool", "vigil", "--about", "orders route", "--verdict", "fixed",
    "--step", "scout: route reads a record by id without an owner check",
    "--step", "detective: idor_read proved it, see https://tonk.foundation/space/abc#key=SECRETKEY",
    "--step", "mechanic: key was sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD moved to env",
    "--step", "gatekeeper: FIXED",
  ], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /added to space 'projx' \(4 steps\)/);
  assert.match(r.stdout, /was removed/);
  const evals = readCalls(ws.state).slice(before).filter((c) => c.argv.includes("eval"));
  assert.equal(evals.length, 1, "the whole run is ONE revision");
});

test("run add: the document — ordered steps, links and known secret shapes removed", () => {
  const steps = [
    "route reads a record by id without an owner check",
    "idor_read proved it, see https://tonk.foundation/space/abc#key=SECRETKEY",
    "key was sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD moved to env",
  ].map((t, i) => ({ character: ["scout", "detective", "mechanic"][i], text: clean(t).text }));
  const doc = buildRunDoc({ id: "vigil-1", tool: "vigil", about: "orders route", verdict: "FIXED", by: "sec", at: "2026-11-21T15:40:00Z", steps });
  assert.match(doc, /run!:\n  id: "vigil-1"\n  tool: "vigil"\n  about: "orders route"\n  verdict: "FIXED"/);
  assert.match(doc, /seq: 1\n  character: "scout"/);
  assert.match(doc, /seq: 3\n  character: "mechanic"/);
  assert.ok(!doc.includes("SECRETKEY"), "no tonk link");
  assert.ok(!doc.includes("sk-abcdefghijklmnopqrstuvwxyz"), "no token");
  assert.equal(clean("plain sentence").redacted, false);
});

test("run add: needs --about and a step; outside a space it says so", async (t) => {
  const ws = makeWorkspace(t);
  let r = await runCli(["run", "add", "--about", "x"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at least one --step/);
  r = await runCli(["run", "add", "--about", "x", "--step", "scout: y"], { cwd: ws.project, env: ws.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not connected to a space/);
});
