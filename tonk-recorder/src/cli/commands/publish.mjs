// `<wrapper> publish` — B1 entry point (SPEC §3 table, §3.4).
// Trusted publishers only (SPEC §8): refuses when the current identity is not
// in the space's trusted-publisher records.
import fs from "node:fs";
import { publishLogic } from "../../publish/publish.mjs";
import { parseArgs, opt, resolveInstructions, ensureDist, PKG_VERSION, PKG_NAME } from "./shared.mjs";

export async function cmdPublish(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const file = opt(args, "file") ?? ensureDist();
  const version = opt(args, "version") ?? PKG_VERSION;
  const changelog = opt(args, "changelog") ?? `v${version}: published by ${env.USER ?? "agent"}`;
  const pub = await publishLogic({
    file,
    version,
    changelog,
    name: PKG_NAME,
    markCreatorTrusted: false, // publish requires EXISTING trust (SPEC §8)
    instructionsText: resolveInstructions(),
    env,
    cwd,
  });
  console.log(`published ${pub.name} v${pub.version}`);
  console.log(`  blob:    ${pub.blobRef}`);
  console.log(`  sha256:  ${pub.sha256}`);
  console.log(`  by:      ${pub.publisher} (trusted publisher)`);
  console.log(`  at:      ${pub.publishedAt}`);
  console.log(`  changelog: ${pub.changelog}`);
  console.log("AGENTS.md bootstrap block updated (existing content preserved).");
  console.log("Members' recorders will announce this version at their next session start (no auto-update, SPEC §3.4).");
  return 0;
}
