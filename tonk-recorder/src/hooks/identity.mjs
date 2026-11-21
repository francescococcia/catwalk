// Who this agent is, per working folder (a git worktree counts as its own
// folder, so every spawned agent can hold its own name and role).
// Local only: $HOME/.tonk/recorder/agents/<folder-key>.json
//   { space, agent, role, harness }
// The space's copy is the `agent` record the agent registers (packs/roles).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

/** The folder an agent works in: its git work tree root, else the cwd. */
export function workFolder(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  try { return fs.realpathSync(top || cwd); } catch { return top || cwd; }
}

export const folderKey = (cwd) => createHash("sha1").update(workFolder(cwd)).digest("hex").slice(0, 16);

function identityPath(cwd, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".tonk", "recorder", "agents", `${folderKey(cwd)}.json`);
}

export function readIdentity(cwd, env = process.env) {
  try { return JSON.parse(fs.readFileSync(identityPath(cwd, env), "utf8")); } catch { return null; }
}

export function writeIdentity(cwd, identity, env = process.env) {
  const p = identityPath(cwd, env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const merged = { ...(readIdentity(cwd, env) || {}), ...identity, folder: workFolder(cwd) };
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

/** A name nobody had to choose: harness + machine + folder. */
export function defaultAgentName(cwd, harness = "agent") {
  const host = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16) || "machine";
  return `${harness}-${host}-${folderKey(cwd).slice(0, 4)}`;
}

/** The space this repository was connected to — stored in the repository's
 *  own git config, which every worktree of it shares. */
export function gitSpace(cwd) {
  return git(cwd, ["config", "--get", "tonk.space"]);
}

export function rememberGitSpace(cwd, space) {
  if (!git(cwd, ["rev-parse", "--git-dir"])) return false;
  try {
    execFileSync("git", ["-C", cwd, "config", "tonk.space", space], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// --- how to call the wrapper from inside a harness -------------------------
// The session-start note hands the agent commands to run. `npx --yes
// tonk-recorder` only works once the package is published; `connect` / `new`
// / `join` therefore record the command that reaches THIS install.

function wrapperFile(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".tonk", "recorder", "wrapper.json");
}

export function wrapperCommand(env = process.env) {
  try {
    const c = JSON.parse(fs.readFileSync(wrapperFile(env), "utf8")).command;
    if (typeof c === "string" && c.trim()) return c;
  } catch { /* not recorded */ }
  return "npx --yes tonk-recorder";
}

/** @param {string} pkgRoot  the installed package's root
 *  @param {string} pkgName  its npm name */
export function rememberWrapper(pkgRoot, pkgName, env = process.env) {
  let command;
  if (/[\\/]_npx[\\/]/.test(pkgRoot)) command = `npx --yes ${pkgName}`; // ran through npx: its cache path is not stable
  else if (/[\\/]lib[\\/]node_modules[\\/]/.test(pkgRoot)) command = pkgName; // global install: on PATH
  else command = `node ${JSON.stringify(path.join(pkgRoot, "bin", `${pkgName}.mjs`))}`; // a checkout
  try {
    fs.mkdirSync(path.dirname(wrapperFile(env)), { recursive: true });
    fs.writeFileSync(wrapperFile(env), JSON.stringify({ command }, null, 2) + "\n");
  } catch { /* best effort */ }
  return command;
}

// --- which tonk binary -------------------------------------------------------
// Revision history (`tonk log` / `tonk restore`, tonk PR #1146) exists ONLY in
// tonk's dev channel — a GitHub release (`TONK_CHANNEL=dev` install script),
// not an npm tag: npm `latest` (0.8.0) and `next` (0.9.0-rc.1) do not have it.
// One space must be read and written by ONE tonk build, so the wrapper and
// the hooks resolve the same binary, in this order:
//   TONK_BIN  →  the dev build at ~/.local/bin/tonk-dev  →  (caller's fallback)

export function devTonkBin(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [env.TONK_DEV_BIN, path.join(home, ".local", "bin", "tonk-dev")].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* next */ }
  }
  return null;
}
