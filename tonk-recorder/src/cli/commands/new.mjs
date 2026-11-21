// `<wrapper> new <name>` — SPEC §3.1:
//   1. tonk space new <name> (creates, registers, binds this project folder)
//   2. load the structure pack (idempotent, S1) via tonk eval --no-sync
//   3. publish the logic into the space (B1: blob + tool record + trusted
//      publisher for the creator + AGENTS.md bootstrap block)
//   4. install the hooks into this harness (H1 via contract / §4.1 layout)
//   5. print the invite paste line
import fs from "node:fs";
import { tonkOk } from "../tonk.mjs";
import { installPlugin } from "../install.mjs";
import { publishLogic } from "../../publish/publish.mjs";
import { linkSpace, linkPage } from "./link.mjs";
import { parseArgs, opt, pasteLine, inviteLink, resolveStructurePack, resolveRolesPack, rememberConnection, ensureGitRepo, resolveInstructions, ensureDist, home, PKG_VERSION } from "./shared.mjs";

export async function cmdNew(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const name = args._[0];
  if (!name) {
    const err = new Error("usage: tonk-recorder new <space-name> [--role <role>] [--local] [--agent-name <name>] [--harness vibe|claude]");
    err.exitCode = 1;
    throw err;
  }
  const harness = opt(args, "harness") ?? "vibe";
  const role = opt(args, "role") ?? "builder"; // the creator builds unless told otherwise
  const agentNameArg = opt(args, "agent-name");
  const agentName = agentNameArg ?? env.USER ?? "agent";
  const opts = { env, cwd };

  if (ensureGitRepo(cwd)) console.log(`(made ${cwd} a git repository: the recorder snapshots changes with git)`);
  // 1. create + bind the space
  await tonkOk(["space", "new", name], opts);

  // 1b. give it a home: attach it to the person's Tonk account (default
  //     deployment tonk.foundation). `tonk space new` alone is local-only —
  //     no remote, so nothing to sync with and no invite link. The approval
  //     page opens in the browser and asks them to sign in if they are not.
  //     --local skips this. A failed/declined link leaves a working local space.
  let linked = null;
  if (!args.local && env.TONK_RECORDER_LOCAL !== "1") {
    console.log(`Attaching space '${name}' to your Tonk account at ${linkPage(env, opt(args, "via"))}.`);
    console.log("Approve it in the browser window that opens; sign in to Tonk there if asked.");
    linked = await linkSpace(name, { env, cwd, via: opt(args, "via"), noOpen: Boolean(args["no-open"]) });
    if (!linked.ok) {
      console.log(`(not attached: ${linked.timedOut ? "timed out waiting for approval" : `tonk space link exited ${linked.code}`} — continuing with a local-only space; attach it later with \`tonk-recorder link\`)`);
    }
  }

  // 2. structure pack (idempotent)
  await tonkOk(["eval", "--no-sync", resolveStructurePack()], opts);
  // 2b. coordination pack: roles (builder, reviewer), agents, tasks, notes
  const rolesPack = resolveRolesPack();
  if (rolesPack) await tonkOk(["eval", "--no-sync", rolesPack], opts);

  // 3. publish the self-contained logic into the space (build dist if needed)
  const distTool = ensureDist();
  const pub = await publishLogic({
    file: distTool,
    version: PKG_VERSION,
    changelog: `v${PKG_VERSION}: initial publish by ${agentName}`,
    markCreatorTrusted: true, // SPEC §3.1 step 3: creator becomes trusted publisher
    instructionsText: resolveInstructions(),
    env,
    cwd,
  });

  // 4. install hooks into this harness
  await installPlugin({
    home: home(env),
    version: pub.version,
    toolSource: fs.readFileSync(distTool),
    harness,
    env,
  });

  // 4b. who this agent is here, and let every worktree of this repo find the space
  const me = rememberConnection({ cwd, env, space: name, agentName: agentNameArg, role, harness });

  // 4c. send the structure, roles and logic up, so a joiner finds them
  if (linked?.ok) {
    try { await tonkOk(["push"], { ...opts, timeoutMs: 30000 }); } catch (e) { console.log(`(first push failed: ${e.message.split("\n")[0]} — run \`tonk-recorder sync\`)`); }
  }

  console.log(`space '${name}' created and bound to ${cwd}`);
  console.log(`you are agent '${me.agent}' with role '${role}'; recording starts on the next turn`);
  console.log(`recorder logic v${pub.version} published (${pub.blobRef}, sha256 ${pub.sha256.slice(0, 12)}…) and installed into harness '${harness}'`);
  console.log("");
  // 5. print the paste line (link goes to stdout only — SPEC §8); local-only
  // spaces have no remote, so there is no link to invite with yet
  try {
    const link = await inviteLink(opts);
    console.log("Invite others with this one line:");
    console.log(`  ${pasteLine(link, "<their-agent-name>")}`);
  } catch {
    console.log("(no invite link: this space is local-only — attach it to your Tonk account with `tonk-recorder link`, then run `tonk-recorder invite`)");
  }
  return 0;
}
