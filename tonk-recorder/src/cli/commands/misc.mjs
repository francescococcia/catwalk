// invite / status / sync / hook / instructions / uninstall — SPEC §3 table.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runTonk, tonkOk } from "../tonk.mjs";
import { pluginDir, DIST_TOOL, homeDir } from "../paths.mjs";
import { installedVersion, uninstallPlugin } from "../install.mjs";
import { linkSpace, linkPage } from "./link.mjs";
import { resolveSpace } from "../../hooks/binding.mjs";
import { readIdentity } from "../../hooks/identity.mjs";
import { checkForUpdate } from "../../update/check.mjs";
import { runTonkTool } from "../../update/check.mjs";
import { parseArgs, opt, pasteLine, inviteLink, resolveInstructions, ensureDist, PKG_VERSION } from "./shared.mjs";

/** Does this space have a remote yet? (`tonk invite` on a local-only space
 *  prints an error but exits 0, so ask `tonk remote` instead.) */
export async function hasRemote(opts) {
  const r = await runTonk(["remote", "--json"], opts);
  try {
    return (JSON.parse(r.stdout).rows || []).length > 0;
  } catch {
    return !/no remotes registered/i.test(r.stdout + r.stderr);
  }
}

/**
 * `invite` — print an invite link. A space is created local-only (no remote,
 * no sign-in); the FIRST invite is what gives it a home: it attaches the
 * space to the person's Tonk account on tonk.foundation (browser approval;
 * they sign in there if asked), pushes what is in it, then mints the link.
 */
export async function cmdInvite(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const args = parseArgs(argv);
  if (!(await hasRemote({ env, cwd }))) {
    // the space this folder is bound to, else the one `new` / `join` recorded for it
    const name = resolveSpace(cwd, { env })?.space ?? readIdentity(cwd, env)?.space;
    const binding = name ? { space: name } : null;
    if (!binding) {
      const err = new Error("this folder is not connected to a space — run `tonk-recorder new <name>` first");
      err.exitCode = 1;
      throw err;
    }
    console.log(`Space '${binding.space}' is local to this machine, so there is nowhere to invite anyone to yet.`);
    console.log(`Attaching it to your Tonk account at ${linkPage(env, opt(args, "via"))}.`);
    console.log("Approve it in the browser window that opens; sign in to Tonk there if asked.");
    const linked = await linkSpace(binding.space, { env, cwd, via: opt(args, "via"), noOpen: Boolean(args["no-open"]) });
    if (!linked.ok) {
      const err = new Error(
        `the space was not attached (${linked.timedOut ? "timed out waiting for approval" : `tonk space link exited ${linked.code}`}), so no invite was made. It is still a working local space; run \`tonk-recorder invite\` again when ready.`,
      );
      err.exitCode = 1;
      throw err;
    }
    // send structure, roles, logic and everything recorded so far, so the joiner finds them
    try {
      await tonkOk(["push"], { env, cwd, timeoutMs: 60000 });
    } catch (e) {
      console.log(`(first push failed: ${e.message.split("\n")[0]} — the joiner may find the space empty until \`tonk-recorder sync\` succeeds)`);
    }
  }
  const link = await inviteLink({ env, cwd });
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
  const pdir = pluginDir(process.cwd());
  const installed = installedVersion();
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
  const pd = path.join(pluginDir(process.cwd()), "tool.mjs");
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
  const removed = await uninstallPlugin({ home: process.cwd(), harness: "all", env });
  for (const p of removed) console.log(`removed ${p}`);
  console.log(`hooks and local state removed. The space binding itself stays — remove it with \`tonk space unbind\` if you want.`);
  return 0;
}
