// `<wrapper> join '<link>' --agent-name <name>` — SPEC §3.2:
//   tonk join → read latest `tool` record → verify publisher ∈ trusted-publisher
//   → fetch blob → verify sha256 → install hooks into the harness.
// A tampered blob or an untrusted publisher is refused (SPEC §8).
import { ensureDevTonk } from "../dev-tonk.mjs";
import fs from "node:fs";
import path from "node:path";
import { tonkOk } from "../tonk.mjs";
import { installPlugin } from "../install.mjs";
import { toolCachePath, homeDir as home } from "../paths.mjs";
import { queryToolRecords, queryTrustedPublishers, latestToolRecord, isTrustedPublisher } from "../../publish/records.mjs";
import { field } from "../tonk.mjs";
import { createHash } from "node:crypto";
import { parseArgs, opt, rememberConnection, boundSpace, ensureGitRepo, installRoleAgents } from "./shared.mjs";

export async function cmdJoin(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const link = args._[0];
  if (!link) {
    const err = new Error("usage: tonk-recorder join '<invite-link>' [--role <role>] [--agent-name <name>] [--harness vibe|claude]");
    err.exitCode = 1;
    throw err;
  }
  const agentName = opt(args, "agent-name") ?? env.USER ?? "agent";
  const harness = opt(args, "harness") ?? "vibe";
  const opts = { env, cwd };

  if (ensureGitRepo(cwd)) console.log(`(made ${cwd} a git repository: the recorder snapshots changes with git)`);
  await ensureDevTonk(env); // the tonk with revision history, fetched once if missing
  // 1. join the space (link is a bearer credential — passed as argv to the
  //    child only, never written to files/records, SPEC §8)
  await tonkOk(["join", link, "--agent-name", agentName], opts);

  // 2. latest tool record from the space
  const tools = await queryToolRecords(opts);
  const latest = latestToolRecord(tools);
  if (!latest) {
    const err = new Error("join: this space has no `tool` record yet — ask the creator to run `tonk-recorder publish`");
    err.exitCode = 1;
    throw err;
  }
  const version = field(latest, "version");
  const blobRef = field(latest, "blob");
  const sha256 = field(latest, "sha256");
  const publisher = field(latest, "publisher");

  // 3. authenticity: publisher must be a trusted publisher (SPEC §8)
  const trusted = await queryTrustedPublishers(opts);
  if (!isTrustedPublisher(publisher, trusted)) {
    const err = new Error(`join refused: tool record publisher ${publisher} is not a trusted-publisher in this space (SPEC §8)`);
    err.exitCode = 1;
    throw err;
  }

  // 4. fetch the blob and verify integrity (sha256) — refuses tampered files
  const blobRes = await tonkOk(["blob", "cat", blobRef], opts);
  const actual = createHash("sha256").update(blobRes.buffer).digest("hex");
  if (sha256 && actual !== sha256) {
    const err = new Error(`join refused: sha256 mismatch for ${blobRef} (record ${sha256}, blob ${actual}) — the logic was tampered with (SPEC §8)`);
    err.exitCode = 1;
    throw err;
  }

  // 5. stage the verified logic at the bootstrap path (SPEC §3.3) + install hooks
  const staged = toolCachePath(version, env);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, blobRes.buffer);
  await installPlugin({ home: process.cwd(), version, toolSource: blobRes.buffer, harness, env });

  // who this agent is here, and let every worktree of this repo find the space
  const space = boundSpace(cwd, env);
  const role = opt(args, "role") ?? null;
  let me = null;
  if (space) installRoleAgents({ cwd, env, space });
  if (space) me = rememberConnection({ cwd, env, space, agentName: opt(args, "agent-name"), role, harness });
  if (me) console.log(`connected to space '${space}' as agent '${me.agent}'${role ? ` with role '${role}'` : " (no role yet — take one with `tonk-recorder role <name>`)"}`);

  console.log(`joined as '${agentName}'; recorder logic v${version} verified (sha256 ok, publisher ${publisher}) and installed into harness '${harness}'`);
  console.log("recording starts on the next turn (if the recorder was not connected to this harness before, reload or restart it once)");
  return 0;
}
