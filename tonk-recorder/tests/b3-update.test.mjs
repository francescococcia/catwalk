// B3 update check tests — SPEC §9.2 B3 done-when: with a stub tonk, a newer
// trusted tool record produces the one-line notice; a newer untrusted one
// produces none; same version produces none. No auto-update in v1 (SPEC §3.4).
import { test } from "node:test";
import { ensureDistBuilt } from "./b0-testkit.mjs";
ensureDistBuilt(); // fresh-checkout safe: dist/ is gitignored
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkspace, runCli, runTool, writeJsonState, readJsonState, setupBoundRepo, FAKE_LINK } from "./b0-testkit.mjs";
import { checkForUpdate, compareVersions, latestToolRecord, isTrustedPublisher } from "../src/update/check.mjs";

const CREATOR = "did:key:zStubCreator111";
const OTHER = "did:key:zSomebodyElse999";

function toolRec(version, publisher = CREATOR, at = "2026-11-21T12:00:00.000Z") {
  return { name: "tonk-recorder", version, blob: "blob:" + "ab".repeat(32), sha256: "cd".repeat(32), publisher, publishedAt: at, changelog: "v" + version };
}
const trusted = [{ identity: CREATOR, addedAt: "2026-11-21T11:00:00.000Z" }];

/** Fake tonk runner driven from in-memory state (no spawn). */
function fakeRun({ tools = [], trustedList = trusted } = {}) {
  return async (args) => {
    if (args[0] === "query" && args[1] === "tool") return { code: 0, stdout: JSON.stringify(tools) };
    if (args[0] === "query" && args[1] === "trusted-publisher") return { code: 0, stdout: JSON.stringify(trustedList) };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

test("compareVersions: ordering", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0") === 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.ok(compareVersions("1.0.0", "0.10.0") > 0);
});

test("newer trusted tool record → one-line notice", async () => {
  const r = await checkForUpdate({ currentVersion: "0.1.0", run: fakeRun({ tools: [toolRec("0.2.0")] }) });
  assert.ok(r, "notice produced");
  assert.match(r.notice, /update available: v0\.2\.0/);
  assert.match(r.notice, /trusted publisher/);
  assert.match(r.notice, /never auto-updates/);
  assert.equal((r.notice.match(/\n/g) ?? []).length, 0, "one line");
});

test("newer UNTRUSTED publisher → silently ignored (null)", async () => {
  const r = await checkForUpdate({ currentVersion: "0.1.0", run: fakeRun({ tools: [toolRec("0.2.0", OTHER)] }) });
  assert.equal(r, null);
});

test("same version → null; older version → null; no records → null; tonk down → null", async () => {
  assert.equal(await checkForUpdate({ currentVersion: "0.2.0", run: fakeRun({ tools: [toolRec("0.2.0")] }) }), null);
  assert.equal(await checkForUpdate({ currentVersion: "0.3.0", run: fakeRun({ tools: [toolRec("0.2.0")] }) }), null);
  assert.equal(await checkForUpdate({ currentVersion: "0.1.0", run: fakeRun({ tools: [] }) }), null);
  assert.equal(await checkForUpdate({ currentVersion: "0.1.0", run: async () => ({ code: 1, stdout: "", stderr: "no space" }) }), null);
});

test("latest record is picked by published-at, not array order", async () => {
  const tools = [toolRec("9.9.9", CREATOR, "2026-11-21T13:00:00.000Z"), toolRec("0.2.0", CREATOR, "2026-11-21T14:00:00.000Z")];
  assert.equal(latestToolRecord(tools).version, "0.2.0");
  assert.ok(isTrustedPublisher(CREATOR, trusted));
  assert.ok(!isTrustedPublisher(OTHER, trusted));
});

// --- end-to-end through the installed logic (dist/tool.mjs now bundles the
// landed R3 runtime, so session-start needs a bound git repo — setupBoundRepo)
async function setupSpaceWithTool(ws, rec, trustedList) {
  writeJsonState(ws.state, "tool-records.json", [rec]);
  writeJsonState(ws.state, "trusted-publishers.json", trustedList);
  await runCli(["build"], { cwd: ws.project, env: ws.env });
}

const HOOK_INPUT = (ws) => JSON.stringify({ hook_event_name: "session_start", session_id: "s1", cwd: ws.project });

test("e2e: session-start hook emits system_message only for newer trusted records", async (t) => {
  const ws = makeWorkspace(t);
  setupBoundRepo(ws);
  const input = HOOK_INPUT(ws);

  // newer + trusted → notice (R3 context.mjs updateNotice, SPEC §3.4)
  await setupSpaceWithTool(ws, toolRec("0.2.0", CREATOR, "2026-11-21T14:00:00.000Z"), trusted);
  let r = await runTool(["hook", "session-start"], { cwd: ws.project, env: ws.env, input });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.system_message, /newer recorder version 0\.2\.0/);

  // newer + untrusted → no notice
  await setupSpaceWithTool(ws, toolRec("0.3.0", OTHER, "2026-11-21T15:00:00.000Z"), trusted);
  r = await runTool(["hook", "session-start"], { cwd: ws.project, env: ws.env, input });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes("system_message"), "untrusted ignored: " + r.stdout);

  // same version as installed (0.1.0) → no notice
  await setupSpaceWithTool(ws, toolRec("0.1.0", CREATOR, "2026-11-21T16:00:00.000Z"), trusted);
  r = await runTool(["hook", "session-start"], { cwd: ws.project, env: ws.env, input });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes("system_message"), "same version → silent: " + r.stdout);
});

test("e2e: wrapper `hook session-start` delegates to the installed plugin tool", async (t) => {
  const ws = makeWorkspace(t);
  await runCli(["new", "projx", "--agent-name", "ada"], { cwd: ws.project, env: ws.env });
  setupBoundRepo(ws);
  // space now has a newer trusted record
  writeJsonState(ws.state, "tool-records.json", [toolRec("0.1.0"), toolRec("0.2.0", CREATOR, "2026-11-21T18:00:00.000Z")]);
  const r = await runCli(["hook", "session-start"], {
    cwd: ws.project,
    env: ws.env,
    input: HOOK_INPUT(ws),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /system_message/);
  assert.match(r.stdout, /newer recorder version 0\.2\.0/);
});
