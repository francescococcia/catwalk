// `<wrapper> connect` — hook the recorder into the harnesses on this machine,
// once, before any space exists. Touches no space: it installs the logic this
// package ships (dist/tool.mjs). A later `new` / `join` replaces that copy
// with the version stored in the space (SPEC §2). Until a folder is bound to
// a space the hooks are a no-op (SPEC §6.1).
import fs from "node:fs";
import path from "node:path";
import { installPlugin } from "../install.mjs";
import { parseArgs, opt, ensureDist, home, rememberThisWrapper, PKG_NAME, PKG_VERSION } from "./shared.mjs";

/** Harness → the directory whose presence means "this harness is used here". */
const HARNESS_HOME = { vibe: ".vibe", claude: ".claude" };

/** What the person has to do so an already-open session picks the hooks up. */
const PICK_UP = {
  vibe: "start Vibe, or type /reload in a session that is already open; /plugins lists it",
  claude: "start a new Claude Code session; /hooks lists it",
};

export function detectHarnesses(homePath) {
  return Object.keys(HARNESS_HOME).filter((h) => fs.existsSync(path.join(homePath, HARNESS_HOME[h])));
}

export async function cmdConnect(argv, { env = process.env } = {}) {
  const args = parseArgs(argv);
  const homePath = home(env);
  const asked = opt(args, "harness");
  if (asked && asked !== "all" && !HARNESS_HOME[asked]) {
    const err = new Error(`usage: ${PKG_NAME} connect [--harness vibe|claude|all]`);
    err.exitCode = 1;
    throw err;
  }
  const harnesses = asked === "all" ? Object.keys(HARNESS_HOME) : asked ? [asked] : detectHarnesses(homePath);
  if (harnesses.length === 0) {
    const err = new Error(
      `no harness found (looked for ~/${HARNESS_HOME.vibe} and ~/${HARNESS_HOME.claude}). ` +
        `Install one, or force it with: ${PKG_NAME} connect --harness vibe|claude`,
    );
    err.exitCode = 1;
    throw err;
  }

  const toolSource = fs.readFileSync(ensureDist());
  let failed = 0;
  for (const harness of harnesses) {
    try {
      await installPlugin({ home: homePath, version: PKG_VERSION, toolSource, harness, env });
      console.log(`${harness}: connected (recorder v${PKG_VERSION}) — ${PICK_UP[harness]}`);
    } catch (e) {
      failed++;
      console.log(`${harness}: NOT connected — ${e && e.message ? e.message : e}`);
    }
  }
  const call = rememberThisWrapper(env);
  if (failed < harnesses.length) {
    console.log("");
    console.log("Nothing is recorded until a project is connected to a space. In the project folder, tell your agent to run one of:");
    console.log(`  ${call} new <space-name>`);
    console.log(`  ${call} join '<link>'`);
  }
  return failed ? 1 : 0;
}
