// Attach a local space to the person's Tonk account on a deployment, so it
// has a remote to sync with and invite links to hand out.
//
// `tonk space new` creates LOCAL-ONLY spaces. `tonk space link <name>` is
// tonk's own way to give one a home: it opens an approval page in the
// browser — which asks the person to sign in to Tonk first if they are not —
// and, once approved, wires the deployment as `main`'s upstream.
//
// Default deployment: https://tonk.foundation. Override with --via <page>,
// or TONK_RECORDER_DEPLOYMENT=<origin>. Everyone in a space must be on the
// same deployment.
import { spawn } from "node:child_process";
import { resolveTonkBin } from "../tonk.mjs";
import { resolveSpace } from "../../hooks/binding.mjs";
import { parseArgs, opt, PKG_NAME } from "./shared.mjs";

export const DEFAULT_DEPLOYMENT = "https://tonk.foundation";

export function linkPage(env = process.env, via) {
  if (via) return via;
  const origin = (env.TONK_RECORDER_DEPLOYMENT || DEFAULT_DEPLOYMENT).replace(/\/+$/, "");
  return `${origin}/settings/link`;
}

/**
 * Run `tonk space link`, streaming its output (the approval URL) straight to
 * the terminal. Resolves { ok, code, timedOut } — never throws: a space that
 * could not be linked is still a working local space.
 */
export function linkSpace(name, { env = process.env, cwd = process.cwd(), via, noOpen = false, timeoutMs = 10 * 60_000 } = {}) {
  const page = linkPage(env, via);
  const args = ["space", "link", name, "--via", page];
  if (noOpen) args.push("--no-open");
  return new Promise((resolve) => {
    let bin;
    try { bin = resolveTonkBin(env); } catch (err) { resolve({ ok: false, code: 1, error: String(err.message || err), page }); return; }
    const argv = bin.viaNode ? [process.execPath, bin.bin, ...args] : [bin.bin, ...args];
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch { /* gone */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, code: 1, error: String(err.message || err), page }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code: code ?? 1, timedOut, page }); });
  });
}

/** `<wrapper> link [--via <page>] [--no-open]` — attach this folder's space (retry after a skipped/failed link). */
export async function cmdLink(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const binding = resolveSpace(cwd, { env });
  if (!binding) {
    const err = new Error(`this folder is not connected to a space — run \`${PKG_NAME} new <name>\` first`);
    err.exitCode = 1;
    throw err;
  }
  console.log(`Attaching space '${binding.space}' to your Tonk account at ${linkPage(env, opt(args, "via"))}.`);
  console.log("Approve it in the browser window that opens; sign in to Tonk there if asked.");
  const r = await linkSpace(binding.space, { env, cwd, via: opt(args, "via"), noOpen: Boolean(args["no-open"]) });
  if (!r.ok) {
    const err = new Error(r.timedOut ? "timed out waiting for approval in the browser" : `tonk space link failed (exit ${r.code})${r.error ? `: ${r.error}` : ""}`);
    err.exitCode = 1;
    throw err;
  }
  console.log(`space '${binding.space}' is attached; get an invite with \`${PKG_NAME} invite\``);
  return 0;
}
