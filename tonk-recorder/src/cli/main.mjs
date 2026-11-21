// tonk-recorder CLI dispatch — SPEC §3 command table.
import { PKG_NAME, PKG_VERSION } from "./paths.mjs";
import { cmdNew } from "./commands/new.mjs";
import { cmdJoin } from "./commands/join.mjs";
import { cmdConnect } from "./commands/connect.mjs";
import { cmdRole } from "./commands/role.mjs";
import { cmdLink } from "./commands/link.mjs";
import { cmdRun, cmdReplay } from "./commands/run.mjs";
import { cmdVigil } from "./commands/vigil.mjs";
import { cmdInvite, cmdStatus, cmdSync, cmdHook, cmdInstructions, cmdUninstall } from "./commands/misc.mjs";
import { cmdPublish } from "./commands/publish.mjs";
import { runBuild } from "./build.mjs";

const USAGE = `${PKG_NAME} v${PKG_VERSION} — records every agent's code changes into a bound Tonk space.

usage: ${PKG_NAME} <command> [args]

commands:
  connect [--harness vibe|claude|all] [--update-tonk]
                        hook the recorder into the harnesses on this machine (once,
                        before any space); fetches tonk's dev build (the one with
                        revision history) if missing; then reload the harness
  new <name> [--role <r>] [--agent-name <n>] [--harness vibe|claude]
                        create + bind a LOCAL space (no remote, no sign-in), publish
                        the recorder logic into it, install hooks into this harness
  join '<link>' [--role <r>] [--agent-name <n>] [--harness vibe|claude]
                        join a space, fetch + verify (sha256, trusted publisher) the
                        logic, install hooks
  role [<name>]         show or take this agent's role in the space (builder, reviewer, …)
  link [--via <page>]   attach this folder's local-only space to your Tonk account
  invite                print an invite link + the paste line. The first invite
                        attaches the space to your Tonk account on tonk.foundation
                        (browser approval; sign in there if asked)
  vigil install         fetch the Vigil security harness (pinned) and install its skill
                        into this project — what the security role proves findings with
  run add --about "…" --step "<who>: <what>" [--step …] [--tool T] [--verdict W]
                        add your own account of a piece of work, as ordered steps
                        (for roles whose turns are not recorded automatically)
  replay [<run-id>] [--out F]
                        list runs, or print one run's steps as JSON lines
  status                binding, sync state, hook state, update availability
  sync                  one checkpoint now: tonk pull + tonk push (SPEC §6.5)
  hook <event>          harness entry point: session-start|pre-agent|post-agent|session-end
  instructions          print how to add a decision by hand with plain tonk commands
  publish [--file F] [--version V] [--changelog "line"]
                        store a new logic version in the space (trusted publishers only)
  uninstall             remove the plugin / managed hooks and local state
  build                 (internal) rebuild the self-contained dist/tool.mjs
  version | -v          print the wrapper version

Environment:
  TONK_BIN              tonk binary to run. Default: tonk's dev build (the one with
                        revision history), fetched from its GitHub release into
                        ~/.tonk/recorder/bin/tonk; else ~/.local/bin/tonk-dev.
  TONK_SPACE / --space  handled by tonk itself (precedence per tonk --help).
`;

export async function main(argv, ctx = {}) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "connect": return await cmdConnect(rest, ctx);
      case "role": return await cmdRole(rest, ctx);
      case "link": return await cmdLink(rest, ctx);
      case "vigil": return await cmdVigil(rest, ctx);
      case "run": return await cmdRun(rest, ctx);
      case "replay": return await cmdReplay(rest, ctx);
      case "new": return await cmdNew(rest, ctx);
      case "join": return await cmdJoin(rest, ctx);
      case "invite": return await cmdInvite(rest, ctx);
      case "status": return await cmdStatus(rest, ctx);
      case "sync": return await cmdSync(rest, ctx);
      case "hook": return await cmdHook(rest, ctx);
      case "instructions": return await cmdInstructions(rest, ctx);
      case "publish": return await cmdPublish(rest, ctx);
      case "uninstall": return await cmdUninstall(rest, ctx);
      case "build": {
        const r = runBuild();
        console.log(`built ${r.outFile} (${r.bytes} bytes)`);
        return 0;
      }
      case "version":
      case "--version":
      case "-v":
      case "-V":
        console.log(PKG_VERSION);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        return cmd === undefined ? 1 : 0;
      default: {
        console.error(`${PKG_NAME}: unknown command '${cmd}'\n`);
        process.stderr.write(USAGE);
        return 1;
      }
    }
  } catch (err) {
    console.error(`tonk-recorder: ${err && err.message ? err.message : err}`);
    return err.exitCode ?? 1;
  }
}
