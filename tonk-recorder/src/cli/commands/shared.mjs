// Shared helpers for the CLI commands.
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT, PKG_NAME, PKG_VERSION, DIST_TOOL, homeDir } from "../paths.mjs";
import { CONTRACTS } from "../contracts.mjs";
import { tonkOk } from "../tonk.mjs";
import { runBuild } from "../build.mjs";
import { resolveSpace } from "../../hooks/binding.mjs";
import { writeIdentity, rememberGitSpace, defaultAgentName, rememberWrapper } from "../../hooks/identity.mjs";
import { execFileSync } from "node:child_process";

/** Minimal flag parser: positional args + --key value / --flag. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export function opt(args, name) {
  return args[name] === undefined || args[name] === true ? undefined : args[name];
}

/** The invite paste line (SPEC §3.2). The link is printed to stdout ONLY —
 *  never written into files, commits, records or AGENTS.md (SPEC §8). */
export function pasteLine(link, agentName = "<name>") {
  return `npx --yes ${PKG_NAME} join '${link}' --agent-name ${agentName}`;
}

/** Mint an invite link via tonk; fall back to --no-shorten (offline-safe). */
export async function inviteLink(opts = {}) {
  let r;
  try {
    r = await tonkOk(["invite"], opts);
  } catch {
    r = await tonkOk(["invite", "--no-shorten"], opts); // documented offline mint
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!line || !/^https?:\/\//.test(line)) {
    const err = new Error(`could not parse invite link from \`tonk invite\` output`);
    err.exitCode = 1;
    throw err;
  }
  return line.trim();
}

/** Resolve the structure pack (S1): env override → package packs/ → embedded stub. */
export function resolveStructurePack() {
  if (process.env.TONK_RECORDER_PACK) return process.env.TONK_RECORDER_PACK;
  const inPkg = path.join(PKG_ROOT, CONTRACTS.componentPaths.structurePack);
  if (fs.existsSync(inPkg)) return inPkg;
  return path.join(PKG_ROOT, "src", "cli", "logic", "structure-pack.notation");
}

/** Resolve the R4 decision-instructions text: env → package instructions/ → stub. */
export function resolveInstructions() {
  if (process.env.TONK_RECORDER_INSTRUCTIONS) return fs.readFileSync(process.env.TONK_RECORDER_INSTRUCTIONS, "utf8");
  const inPkg = path.join(PKG_ROOT, CONTRACTS.componentPaths.instructions);
  if (fs.existsSync(inPkg)) return fs.readFileSync(inPkg, "utf8");
  return fs.readFileSync(path.join(PKG_ROOT, "src", "cli", "logic", "instructions.md"), "utf8");
}

/** The coordination pack (roles, agents, tasks, notes), if this package ships it. */
export function resolveRolesPack() {
  const inPkg = path.join(PKG_ROOT, "packs", "roles.notation");
  return fs.existsSync(inPkg) ? inPkg : null;
}

/**
 * After `new` / `join`: remember, for this working folder, which space it is
 * connected to and who this agent is — and write the space name into the
 * repository's git config so every worktree of it (spawned agents) resolves
 * to the same space. Returns the identity.
 */
/** Record how this install is called, for the notes the hooks hand the agent. */
export const rememberThisWrapper = (env) => rememberWrapper(PKG_ROOT, PKG_NAME, env);

/** The recorder snapshots with git (SPEC §6.2). An empty project folder is
 *  made a repository so "create a space" works from nothing. */
export function ensureGitRepo(cwd) {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return false;
  } catch {
    execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
    return true;
  }
}

export function rememberConnection({ cwd, env, space, agentName, role, harness }) {
  const name = agentName ?? defaultAgentName(cwd, harness);
  rememberThisWrapper(env);
  rememberGitSpace(cwd, space);
  return writeIdentity(cwd, { space, agent: name, role: role ?? null, harness, registeredRole: null }, env);
}

/** The space tonk has bound to this folder (after `space new` / `join`). */
export function boundSpace(cwd, env) {
  return resolveSpace(cwd, { env: { ...env, TONK_SPACE: "" } })?.space ?? null;
}

/** Ensure dist/tool.mjs exists (build on demand). */
export function ensureDist() {
  // Always rebuild from src/: an old dist/ would install stale hook logic.
  // (A packed install whose build fails falls back to the dist it shipped.)
  try {
    runBuild();
  } catch (err) {
    if (!fs.existsSync(DIST_TOOL)) throw err;
  }
  return DIST_TOOL;
}

export function home(env = process.env) {
  return homeDir(env);
}

export { PKG_NAME, PKG_VERSION };
