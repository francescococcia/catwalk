// `<wrapper> run add …` — an agent's own, by-hand account of a piece of work,
// as a few ordered steps (packs/roles.notation: run + run-event). For roles
// whose turns the hooks do NOT record (security): the agent decides what goes
// into the space. Everything is scanned on the way in — tonk links stripped,
// known secret shapes redacted — and written through the single writer, as
// ONE revision.
//
// `<wrapper> replay [<run-id>] [--out file.jsonl]` — the steps back out as
// JSON lines ({seq, ts, type, character, text}), the shape Vigil's offline
// viewer plays.
import fs from "node:fs";
import { runTonk } from "../tonk.mjs";
import { resolveSpace } from "../../hooks/binding.mjs";
import { readIdentity, defaultAgentName } from "../../hooks/identity.mjs";
import { enqueue, drain } from "../../hooks/queue.mjs";
import { stripLinks } from "../../hooks/links.mjs";
import { scanSecrets } from "../../snapshot/tool.mjs";
import { PKG_NAME } from "./shared.mjs";

const y = (v) => JSON.stringify(String(v));

/** Repeatable flags: --step a --step b → { step: [a, b] }. */
function parse(argv) {
  const out = { _: [], step: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (k === "step") out.step.push(String(v));
      else out[k] = v;
    } else out._.push(a);
  }
  return out;
}

/** Links out, known secret shapes redacted. Returns { text, redacted }. */
export function clean(text) {
  const l = stripLinks(text);
  const s = scanSecrets(l.text);
  return { text: s.text, redacted: Boolean(l.removed || s.redacted) };
}

function spaceFor(cwd, env) {
  const space = resolveSpace(cwd, { env })?.space ?? readIdentity(cwd, env)?.space;
  if (!space) {
    const err = new Error(`this folder is not connected to a space — run \`${PKG_NAME} new <name>\` or \`${PKG_NAME} join '<link>'\` first`);
    err.exitCode = 1;
    throw err;
  }
  return space;
}

export function buildRunDoc({ id, tool, about, verdict, by, at, steps }) {
  const lines = ["run!:", `  id: ${y(id)}`, `  tool: ${y(tool)}`, `  about: ${y(about)}`, `  verdict: ${y(verdict)}`, `  by: ${y(by)}`, `  at: ${y(at)}`, ""];
  steps.forEach((st, i) => {
    lines.push("run-event!:", `  run: ${y(id)}`, `  seq: ${i + 1}`, `  character: ${y(st.character)}`, `  text: ${y(st.text)}`, `  at: ${y(at)}`, "");
  });
  return lines.join("\n");
}

export async function cmdRun(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const [sub, ...rest] = argv;
  if (sub !== "add") {
    const err = new Error(`usage: ${PKG_NAME} run add --tool <tool> --about "<what>" --verdict <WORD> --step "<character>: <one sentence>" [--step …] [--by <agent>]`);
    err.exitCode = 1;
    throw err;
  }
  const a = parse(rest);
  if (!a.step.length || a.about === undefined || a.about === true) {
    const err = new Error(`run add needs --about and at least one --step "<character>: <one sentence>"`);
    err.exitCode = 1;
    throw err;
  }
  const space = spaceFor(cwd, env);
  const at = new Date().toISOString();
  const tool = a.tool && a.tool !== true ? String(a.tool) : "manual";
  const by = a.by && a.by !== true ? String(a.by) : env.TONK_AGENT_ROLE || readIdentity(cwd, env)?.agent || defaultAgentName(cwd, "vibe");
  let redacted = false;
  const c = (t) => { const r = clean(t); redacted = redacted || r.redacted; return r.text; };
  const steps = a.step.map((raw) => {
    const m = raw.match(/^\s*([a-z][a-z0-9-]{0,30})\s*:\s*([\s\S]+)$/i);
    return { character: m ? m[1].toLowerCase() : "narrator", text: c(m ? m[2].trim() : raw.trim()) };
  });
  const id = `${tool}-${at.replace(/[:.]/g, "-")}`;
  const doc = buildRunDoc({ id, tool, about: c(String(a.about)), verdict: a.verdict && a.verdict !== true ? String(a.verdict).toUpperCase() : "DONE", by, at, steps });
  const file = enqueue(space, { kind: "eval", doc }, env);
  const d = drain(space, env, { until: file, waitMs: 10000 });
  const mine = d.results[file];
  if (mine && mine.status === "failed") {
    const err = new Error(`tonk refused the run: ${mine.error}`);
    err.exitCode = 1;
    throw err;
  }
  console.log(`run ${id} added to space '${space}' (${steps.length} step${steps.length === 1 ? "" : "s"})${redacted ? " — something that looked like a link or a secret was removed" : ""}${mine ? "" : " — queued, the writer will put it in"}`);
  return 0;
}

export async function cmdReplay(argv, { env = process.env, cwd = process.cwd() } = {}) {
  const a = parse(argv);
  const space = spaceFor(cwd, env);
  const q = async (concept, where = []) => {
    const args = ["--space", space, "query", concept, "--json"];
    for (const w of where) args.push("--where", w);
    const r = await runTonk(args, { env: { ...env, TONK_NO_SYNC: "1" }, cwd });
    try { const j = JSON.parse(r.stdout); return Array.isArray(j) ? j : []; } catch { return []; }
  };
  const runs = (await q("run")).sort((x, yy) => String(x.at).localeCompare(String(yy.at)));
  const id = a._[0];
  if (!id) {
    if (!runs.length) console.log("(no runs in this space yet)");
    for (const r of runs) console.log(`${r.id}  ${r.verdict}  ${r.tool}  by ${r.by}  — ${r.about}`);
    return 0;
  }
  const run = runs.find((r) => r.id === id);
  if (!run) {
    const err = new Error(`no run '${id}' in space '${space}' — \`${PKG_NAME} replay\` lists them`);
    err.exitCode = 1;
    throw err;
  }
  const events = (await q("run-event", [`run=${id}`])).sort((x, yy) => Number(x.seq) - Number(yy.seq));
  const lines = [
    { seq: 0, ts: run.at, type: "run_started", character: events[0]?.character ?? "scout", text: `${run.tool}: ${run.about}`, app: run.about, mode: "replay" },
    ...events.map((e) => ({ seq: Number(e.seq), ts: e.at, type: "step", character: e.character, text: e.text })),
    { seq: events.length + 1, ts: run.at, type: "verdict", character: "gatekeeper", text: `Verdict: ${run.verdict}`, result: run.verdict },
    { seq: events.length + 2, ts: run.at, type: "run_finished", character: "gatekeeper", text: "Run finished." },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  if (a.out && a.out !== true) {
    fs.writeFileSync(String(a.out), lines);
    console.log(`wrote ${events.length + 3} events to ${a.out}`);
  } else process.stdout.write(lines);
  return 0;
}
