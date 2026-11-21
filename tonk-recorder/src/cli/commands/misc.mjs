// invite / status / sync / hook / instructions / uninstall — SPEC §3 table.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runTonk, tonkOk } from "../tonk.mjs";
import { pluginDir, DIST_TOOL, homeDir } from "../paths.mjs";
import { installedVersion, uninstallPlugin } from "../install.mjs";
import { checkForUpdate } from "../../update/check.mjs";
import { runTonkTool } from "../../update/check.mjs";
import { parseArgs, opt, pasteLine, inviteLink, resolveInstructions, ensureDist, PKG_VERSION } from "./shared.mjs";

export async function cmdInvite(argv, opts = {}) {
  const link = await inviteLink(opts);
  console.log(link);
  console.log("");
  console.log("paste line for the next agent:");
  console.log(`  ${pasteLine(link, "<their-agent-name>")}`);
  return 0;
}

export async function cmdStatus(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const opts = { env, cwd };
  // binding + sync state from tonk
  try {
    const r = await runTonk(["status"], opts);
    process.stdout.write(r.stdout);
    if (r.code !== 0 && r.stderr.trim()) process.stdout.write(`(tonk status: ${r.stderr.trim().split("\n")[0]})\n`);
  } catch (err) {
    process.stdout.write(`(no tonk binding resolvable here: ${err.message})\n`);
  }
  // hook state
  const pdir = pluginDir(env);
  const installed = installedVersion(env);
  const hooksToml = path.join(pdir, "ai.mistral.vibe", "hooks.toml");
  console.log(`plugin: ${fs.existsSync(path.join(pdir, "plugin.json")) ? `installed at ${pdir} (v${installed ?? "?"})` : "not installed"}`);
  console.log(`hooks:  ${fs.existsSync(hooksToml) ? "present (" + hooksToml + ")" : "not present"}`);
  // update check (informational; same rules as the session-start notice)
  if (installed) {
    const upd = await checkForUpdate({
      currentVersion: installed,
      run: (args, o) => runTonkTool(args, { env, cwd, ...o }),
    });
    console.log(upd ? `update: ${upd.notice}` : "update: up to date");
  }
  return 0;
}

export async function cmdSync(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const timeoutMs = Number(opt(args, "timeout") ?? 20000); // SPEC §6.5: hard timeout, default 20s each
  const jitter = opt(args, "no-jitter") ? 0 : Number(env.TONK_SYNC_JITTER ?? 3000); // SPEC §6.5: 0–3s before push
  const opts = { env, cwd, timeoutMs };

  // one checkpoint = tonk pull + tonk push (SPEC §6.5)
  await tonkOk(["pull"], opts);
  if (jitter > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitter)));
  await tonkOk(["push"], opts);
  console.log("synced (pull ok, push ok)");
  return 0;
}

const HOOK_EVENTS = new Set(["session-start", "pre-agent", "post-agent", "session-end"]);

/** Resolve which installed logic runs the hook: the space-installed version
 *  wins (SPEC §2 — every agent runs the logic stored in its space). */
export function resolveInstalledTool(env = process.env) {
  if (env.TONK_RECORDER_TOOL) return env.TONK_RECORDER_TOOL;
  const pd = path.join(pluginDir(env), "tool.mjs");
  if (fs.existsSync(pd)) return pd;
  const root = path.join(homeDir(env), ".tonk", "tools", "tonk-recorder");
  try {
    const versions = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "tool.mjs")));
    if (versions.length) return path.join(root, versions.sort().pop(), "tool.mjs");
  } catch { /* none */ }
  if (fs.existsSync(DIST_TOOL)) return DIST_TOOL;
  return null;
}

export async function cmdHook(argv, { env = process.env } = {}) {
  const event = argv[0];
  if (!event || !HOOK_EVENTS.has(event)) {
    const err = new Error(`usage: tonk-recorder hook <${[...HOOK_EVENTS].join("|")}>  (harness calls this; stdin carries the hook JSON)`);
    err.exitCode = 1;
    throw err;
  }
  const tool = resolveInstalledTool(env);
  if (!tool) return 0; // nothing installed → no-op (SPEC §6.1)
  // delegate to src/hooks via the installed tool.mjs (contract: the dist build
  // embeds src/hooks/tool.mjs); stdin/stdout are piped through
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, "hook", event], { env, cwd: process.cwd() });
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  return code;
}

export async function cmdInstructions() {
  process.stdout.write(resolveInstructions());
  return 0;
}

export async function cmdUninstall(argv, { env = process.env } = {}) {
  const removed = await uninstallPlugin({ home: homeDir(env), harness: "all", env });
  for (const p of removed) console.log(`removed ${p}`);
  console.log(`hooks and local state removed. The space binding itself stays — remove it with \`tonk space unbind\` if you want.`);
  return 0;
}
