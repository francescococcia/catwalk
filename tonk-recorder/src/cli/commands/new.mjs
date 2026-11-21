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
import { parseArgs, opt, rememberThisWrapper, resolveStructurePack, resolveRolesPack, rememberConnection, ensureGitRepo, resolveInstructions, ensureDist, home, PKG_VERSION } from "./shared.mjs";

export async function cmdNew(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const name = args._[0];
  if (!name) {
    const err = new Error("usage: tonk-recorder new <space-name> [--role <role>] [--agent-name <name>] [--harness vibe|claude]");
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

  // The space stays LOCAL-ONLY here: no remote, no sign-in. It gets a home on
  // tonk.foundation only when the first invite is made (`invite` attaches it,
  // which is the one step that needs the person to sign in to Tonk).

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
    home: cwd,
    version: pub.version,
    toolSource: fs.readFileSync(distTool),
    harness,
    env,
  });

  // 4b. who this agent is here, and let every worktree of this repo find the space
  const me = rememberConnection({ cwd, env, space: name, agentName: agentNameArg, role, harness });

  console.log(`space '${name}' created and bound to ${cwd}`);
  console.log(`you are agent '${me.agent}' with role '${role}'; recording starts on the next turn`);
  console.log(`recorder logic v${pub.version} published (${pub.blobRef}, sha256 ${pub.sha256.slice(0, 12)}…) and installed into harness '${harness}'`);
  console.log("");
  // 5. no invite here — that is what would need a remote and a sign-in
  console.log(`This space is local to this machine. To bring another agent in, run \`${rememberThisWrapper(env)} invite\` — it attaches the space to your Tonk account first (a browser page opens; sign in there if asked).`);
  return 0;
}
