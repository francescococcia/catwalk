// `<wrapper> vigil install` — give the security role its harness.
//
// The `security` role proves findings with Vigil (github.com/francescococcia/
// ministral): rules flag a suspect, an attack on the locally running app
// proves it, a fix is applied and re-proven. This fetches Vigil ONCE per
// machine into the recorder's own folder (~/.tonk/recorder/tools/vigil,
// pinned to a known commit) and installs its Vibe skill into THIS project
// (.vibe/skills/vigil/SKILL.md) with every command rewritten to the absolute
// install path — so the security subagent can run it from any project.
//
// Vigil is someone else's code and runs on this machine: it is pinned, and
// `--ref` must be given explicitly to move it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs, opt, PKG_NAME } from "./shared.mjs";

export const VIGIL_REPO = "https://github.com/francescococcia/ministral";
export const VIGIL_REF = "9434dd8"; // "Target profile: Vigil works on any repo via .vigil/target.json"

export function vigilDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".tonk", "recorder", "tools", "vigil");
}

export function vigilInstalled(env = process.env) {
  const d = vigilDir(env);
  return fs.existsSync(path.join(d, "harness", "vigil.py")) ? d : null;
}

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Vigil's skill text with its repo-relative commands made absolute. */
export function rewriteSkill(text, dir) {
  const q = (p) => JSON.stringify(path.join(dir, p));
  return String(text)
    .replaceAll("python harness/vigil.py", `python3 ${q("harness/vigil.py")}`)
    .replaceAll("uv run --project engine engine/run.py", `uv run --project ${q("engine")} ${q("engine/run.py")}`)
    .replaceAll("--json harness/report.json", `--json ${q("harness/report.json")}`)
    .replaceAll("`harness/report.json`", `\`${path.join(dir, "harness/report.json")}\``)
    .replaceAll("harness/viewer/", `${path.join(dir, "harness/viewer")}/`)
    .replaceAll("`engine/CONTRACT.md`", `\`${path.join(dir, "engine/CONTRACT.md")}\``)
    .replace("From the repository root:", `Vigil is installed at \`${dir}\`; these commands work from any folder:`);
}

export function has(cmd) {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

export async function cmdVigil(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest);
  if (sub !== "install" && sub !== "status") {
    const err = new Error(`usage: ${PKG_NAME} vigil install [--ref <commit>] [--repo <url>] | vigil status`);
    err.exitCode = 1;
    throw err;
  }
  const dir = vigilDir(env);
  if (sub === "status") {
    const d = vigilInstalled(env);
    console.log(d ? `vigil: installed at ${d} (${git(d, ["rev-parse", "--short", "HEAD"])})` : `vigil: not installed — run \`${PKG_NAME} vigil install\``);
    console.log(`skill in this project: ${fs.existsSync(path.join(cwd, ".vibe", "skills", "vigil", "SKILL.md")) ? "yes" : "no"}`);
    return 0;
  }
  const repo = opt(args, "repo") ?? env.TONK_RECORDER_VIGIL_REPO ?? VIGIL_REPO;
  const ref = opt(args, "ref") ?? env.TONK_RECORDER_VIGIL_REF ?? VIGIL_REF;
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "-q", repo, dir], { stdio: ["ignore", "inherit", "inherit"] });
  } else {
    try { git(dir, ["fetch", "-q", "origin"]); } catch { /* offline: use what is there */ }
  }
  git(dir, ["checkout", "-q", "--detach", ref]);
  const at = git(dir, ["rev-parse", "--short", "HEAD"]);

  // the Vibe skill, into this project, with absolute commands
  const src = path.join(dir, ".vibe", "skills", "vigil", "SKILL.md");
  if (!fs.existsSync(src)) {
    const err = new Error(`${repo}@${at} has no .vibe/skills/vigil/SKILL.md — not a Vigil checkout`);
    err.exitCode = 1;
    throw err;
  }
  const dest = path.join(cwd, ".vibe", "skills", "vigil", "SKILL.md");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, rewriteSkill(fs.readFileSync(src, "utf8"), dir));

  console.log(`vigil ${at} installed at ${dir}`);
  console.log(`skill installed in this project: ${path.relative(cwd, dest)} (type /reload in an open Vibe session)`);
  const missing = [["python3", "Python 3.12+ (the scanner)"], ["uv", "uv (the proving engine)"]].filter(([c]) => !has(c));
  for (const [, what] of missing) console.log(`  missing: ${what}`);
  if (!has("ollama")) console.log("  optional, not found: Ollama (local Ministral explanations; Vigil runs without it with --no-llm / --no-narrate)");
  console.log(`To prove a finding Vigil attacks the app running on this machine: the project needs .vigil/target.json (see ${path.join(dir, "engine", "CONTRACT.md")}). That file holds test passwords; the recorder never snapshots .vigil/.`);
  return 0;
}
