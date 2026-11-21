// `<wrapper> role [<name>] [--agent-name <n>]` — take (or show) this agent's
// role in the space this folder is connected to. Stored for this working
// folder; the agent registers itself in the space at its next session start,
// and the session-start note then carries the role's instructions.
import { runTonk } from "../tonk.mjs";
import { resolveSpace } from "../../hooks/binding.mjs";
import { readIdentity, writeIdentity, defaultAgentName } from "../../hooks/identity.mjs";
import { enqueue, drain } from "../../hooks/queue.mjs";
import { buildAgentDoc } from "../../hooks/writer.mjs";
import { parseArgs, opt, PKG_NAME } from "./shared.mjs";

async function installedRoles(space, opts) {
  try {
    const r = await runTonk(["--space", space, "query", "role", "--json"], { ...opts, env: { ...opts.env, TONK_NO_SYNC: "1" } });
    const rows = JSON.parse(r.stdout);
    return Array.isArray(rows) ? [...new Set(rows.map((x) => x.name).filter(Boolean))].sort() : [];
  } catch {
    return [];
  }
}

export async function cmdRole(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const binding = resolveSpace(cwd, { env });
  if (!binding) {
    const err = new Error(`this folder is not connected to a space — run \`${PKG_NAME} new <name>\` or \`${PKG_NAME} join '<link>'\` first`);
    err.exitCode = 1;
    throw err;
  }
  const space = binding.space;
  const current = readIdentity(cwd, env);
  const mine = current && current.space === space ? current : null;
  const roles = await installedRoles(space, { env, cwd });
  const want = args._[0];

  if (!want) {
    console.log(`space: ${space}`);
    console.log(`agent: ${mine?.agent ?? "(not named yet)"}`);
    console.log(`role:  ${mine?.role ?? "(none)"}`);
    console.log(`roles installed on this space: ${roles.length ? roles.join(", ") : "(none)"}`);
    return 0;
  }
  if (roles.length && !roles.includes(want)) {
    const err = new Error(`role '${want}' is not installed on space '${space}'. Installed: ${roles.join(", ")}`);
    err.exitCode = 1;
    throw err;
  }
  const harness = opt(args, "harness") ?? mine?.harness ?? "vibe";
  const agent = opt(args, "agent-name") ?? mine?.agent ?? defaultAgentName(cwd, harness);
  // register now, through the single writer
  enqueue(space, { kind: "eval", doc: buildAgentDoc({ name: agent, role: want, harness, at: new Date().toISOString() }) }, env);
  drain(space, env, { waitMs: 5000 });
  writeIdentity(cwd, { space, agent, role: want, harness, registeredRole: want }, env);
  console.log(`agent '${agent}' now has role '${want}' in space '${space}'.`);
  console.log(`Read the role's instructions and follow them: tonk --space ${space} query role --where name=${want}`);
  return 0;
}
