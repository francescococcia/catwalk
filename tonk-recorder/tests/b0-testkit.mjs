// Shared offline test kit for B0/B1/B3 tests: fake HOME + TONK_BIN stub tonk
// (AGENTS.md rule 4 — no real spaces, no network).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(PKG_ROOT, "bin", "tonk-recorder.mjs");
export const STUB_TONK = path.join(PKG_ROOT, "tests", "b0-stub-tonk.mjs");
export const DIST_TOOL = path.join(PKG_ROOT, "dist", "tool.mjs");
export const FAKE_LINK = "https://tonk.example.invalid/join#stub-invite-token";

/** Create a clean workspace: temp project dir + fake HOME + stub state dir. */
export function makeWorkspace(t, { scenario = {} } = {}) {
  fs.chmodSync(STUB_TONK, 0o755); // R3's runner spawns TONK_BIN directly (shebang), not via node
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tonk-recorder-test-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const project = path.join(dir, "project");
  const home = path.join(dir, "home");
  const state = path.join(dir, "tonk-state");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "scenario.json"), JSON.stringify(scenario));
  const env = {
    ...process.env,
    HOME: home,
    TONK_BIN: STUB_TONK,
    TONK_STUB_STATE: state,
    TONK_SYNC_JITTER: "0",
  };
  return { dir, project, home, state, env };
}

/** Run the wrapper CLI: node bin/tonk-recorder.mjs <args...> */
export function runCli(args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: cwd ?? process.cwd(), env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) { child.stdin.write(input); }
    child.stdin.end();
  });
}

/** Run the built logic tool directly: node dist/tool.mjs <args...> */
export function runTool(args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_TOOL, ...args], { cwd: cwd ?? process.cwd(), env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) { child.stdin.write(input); }
    child.stdin.end();
  });
}

export function readCalls(state) {
  const f = path.join(state, "calls.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

export function readJsonState(state, file, fallback = []) {
  const f = path.join(state, file);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback;
}

export function writeJsonState(state, file, value) {
  fs.writeFileSync(path.join(state, file), JSON.stringify(value, null, 2));
}

export function readAgents(state) {
  const f = path.join(state, "agents.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

export function pluginDirOf(home) {
  return path.join(home, ".vibe", "plugins", "tonk-recorder");
}

// --- dist self-sufficiency ---------------------------------------------------
// dist/tool.mjs is gitignored (generated), so on a fresh checkout it does not
// exist. Tests must be self-sufficient: build it synchronously if missing.
import { runBuild } from "../src/cli/build.mjs";
export function ensureDistBuilt() {
  if (!fs.existsSync(DIST_TOOL)) runBuild();
  if (!fs.existsSync(DIST_TOOL)) {
    throw new Error(`dist/tool.mjs missing and build failed — run \`node src/cli/build.mjs\` (also wired as npm pretest)`);
  }
  return DIST_TOOL;
}

// --- bound-repo fixture for R3 hook e2e tests --------------------------------
// R3's session-start needs: a git repo on branch main (snapshots, §6.2), a
// tonk registry binding for the cwd (binding.mjs; TONK_REGISTRY is honoured),
// and DATA_ROOT for recorder state (state.mjs).
import { execFileSync } from "node:child_process";
export function setupBoundRepo(ws, space = "projx") {
  const git = (a) => execFileSync("git", a, { cwd: ws.project, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(ws.project, "README.md"), "# test\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  const registry = path.join(ws.state, "spaces.json");
  fs.writeFileSync(
    registry,
    JSON.stringify({
      spaces: { [space]: { site: path.join(ws.state, "site") } },
      bindings: { [fs.realpathSync(ws.project)]: space },
    }),
  );
  ws.env.TONK_REGISTRY = registry;
  ws.env.DATA_ROOT = path.join(ws.state, "data");
  ws.env.TONK_RECORDER_VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version; // the installed version
  return ws.env;
}
