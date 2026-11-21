// INTEGRATION POINTS (W0 contracts not landed on master yet — coding to SPEC text).
//
// W0 owns contracts/records.md, contracts/hooks.md, contracts/layout.md and fixtures/.
// Until they merge, the paths below are the assumed contract locations for other
// agents' deliverables, per SPEC §9.2 ownership:
//   - S1 (agent w0-s1-r2):      packs/recorder.notation
//   - R3 (agent r1-r3-r5):      src/hooks/            (hook entry: tool.mjs)
//   - R4 (agent h1-r4-b2):      instructions/
//   - B2/H1 (agent h1-r4-b2):   src/install/, adapters/vibe/
// When contracts land, align these constants with contracts/layout.md.
export const CONTRACTS = {
  records: "contracts/records.md",
  hooks: "contracts/hooks.md",
  layout: "contracts/layout.md",
  componentPaths: {
    hooksTool: "src/hooks/tool.mjs", // R3 hook runtime entry (built into dist/tool.mjs)
    installMod: "src/install/mod.mjs", // B2 install-from-space entry
    vibeAdapter: "adapters/vibe/install.mjs", // H1 Vibe plugin installer
    instructions: "instructions/decisions.md", // R4 decision-instructions text
    structurePack: "packs/recorder.notation", // S1 structure pack
  },
};

// tonk 0.8.0 facts verified against the installed CLI (see contracts/cli-checks.md
// once W0 lands): `eval --no-sync` / TONK_NO_SYNC writes locally only; `blob add`
// prints `blob:<hash>`, `blob cat <blob:...>` writes bytes to stdout; `space agents
// get|set` read/write the AGENTS.md claim (set takes a PATH or `-` for stdin);
// `query <concept> --json` emits a JSON array; `identity` prints the profile DID;
// `space new <name>` creates + registers + binds the cwd; `join <url>
// --agent-name <name>`; `invite` prints the link (`--no-shorten` mints offline).
// DEV-only (tonk PR #1146, NOT in 0.8.0): `tonk log`, `tonk restore`, `tonk switch`.
