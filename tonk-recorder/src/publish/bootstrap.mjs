// B1 bootstrap block + AGENTS.md merge (SPEC §3.1 step 3, §3.3, §6.7).
import { PKG_NAME, PINNED_TONK_CLI } from "../cli/paths.mjs";

export const BOOTSTRAP_START = "<!-- tonk-recorder:bootstrap:start -->";
export const BOOTSTRAP_END = "<!-- tonk-recorder:bootstrap:end -->";
export const INSTRUCTIONS_START = "<!-- tonk-recorder:instructions:start -->";
export const INSTRUCTIONS_END = "<!-- tonk-recorder:instructions:end -->";

/**
 * The bootstrap block written into the space AGENTS.md (SPEC §3.3).
 * It must work when pasted with only `tonk` + a link. The blob ref and sha256
 * come from the `tool` record; `<wrapper>`/`<version>` are filled in.
 *
 * DEV (SPEC §7.4): the `npx --yes @tonk/cli@<ver>` line must name the dev
 * build that includes PR #1146 once it lands — until then it names the pinned
 * release (PINNED_TONK_CLI), which has no `tonk log` yet.
 */
export function bootstrapBlock({ version, blobRef, sha256, wrapper = PKG_NAME, cliVersion = PINNED_TONK_CLI }) {
  return [
    BOOTSTRAP_START,
    "# Tonk recorder bootstrap — generated; do not edit",
    "",
    "# With only the tonk CLI and an invite link, run these three lines:",
    `mkdir -p ~/.tonk/tools/${wrapper}/${version}`,
    `npx --yes @tonk/cli@${cliVersion} blob cat ${blobRef} > ~/.tonk/tools/${wrapper}/${version}/tool.mjs`,
    `node ~/.tonk/tools/${wrapper}/${version}/tool.mjs install --expect-sha256 ${sha256}`,
    BOOTSTRAP_END,
    "",
  ].join("\n");
}

/**
 * Merge the bootstrap block + decision instructions into existing AGENTS.md
 * content, PRESERVING any other content (SPEC §3.1 step 3 / §3.3: the AGENTS.md
 * starts with the bootstrap block). Re-running replaces only the marked
 * sections, so `publish` is idempotent.
 */
export function mergeAgentsMd(existing, { bootstrap, instructions }) {
  let md = String(existing ?? "");
  md = replaceMarked(md, BOOTSTRAP_START, BOOTSTRAP_END, bootstrap);
  if (!md.includes(BOOTSTRAP_START)) {
    // SPEC §3.3: the AGENTS.md starts with the bootstrap block.
    const rest = md ? (md.startsWith("\n") ? md : "\n" + md) : "";
    md = bootstrap + rest;
  }
  if (instructions) {
    const section = [
      INSTRUCTIONS_START,
      "## Recording decisions by hand",
      "",
      instructions.trim(),
      "",
      INSTRUCTIONS_END,
      "",
    ].join("\n");
    md = replaceMarked(md, INSTRUCTIONS_START, INSTRUCTIONS_END, section);
    if (!md.includes(INSTRUCTIONS_START)) {
      md = (md.endsWith("\n") || md === "" ? md : md + "\n") + "\n" + section;
    }
  }
  return md;
}

function replaceMarked(md, start, end, block) {
  const si = md.indexOf(start);
  const ei = md.indexOf(end);
  if (si !== -1 && ei !== -1 && ei > si) {
    const rest = md.slice(ei + end.length);
    const sep = rest === "" || rest.startsWith("\n") ? "" : "\n";
    return md.slice(0, si) + block.replace(/\n+$/, "") + "\n" + sep + rest;
  }
  return md;
}
