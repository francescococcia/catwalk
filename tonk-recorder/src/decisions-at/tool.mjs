#!/usr/bin/env node
// R5 — `decisions --at <edition@origin | ISO-time | git-commit>` (SPEC §7.3).
//
// Tries the §7.2 route first (`tonk restore --revision … --dry-run`, DEV —
// tonk-dev / PR #1146); when the signed head is not on this device (e.g. the
// point was made on ANOTHER machine) it folds `tonk log decision --json`
// (+ decision-status + change logs) instead, and says which route was used.
//
// L1: use TONK_BIN=~/.local/bin/tonk-dev (or any dev build with PR #1146);
// @tonk/cli 0.8.0 has no log/restore. Fixture fallback for offline tests:
//   node tool.mjs decisions --at <point> --log F --statuses-log F --changes-log F
// Real tonk:
//   node tool.mjs decisions --at <point> [--space S] [--cwd DIR] [--json]

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { logJson, restoreDryRun, restoreRevision, switchMain, queryJson } from "../hooks/tonk.mjs";
import { normalizeLog, parsePoint, resolvePoint, foldDecisions } from "./fold.mjs";

const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function resolveGitRef(cwd, ref) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** Fetch the three logs: fixture files when given, else the dev tonk (DEV). */
function getModel(space, env, { logFile, statusesLogFile, changesLogFile }) {
  const decisionRaw = logFile ? readJsonFile(logFile) : logJson(space, ["decision"], env);
  const statusesRaw = statusesLogFile ? readJsonFile(statusesLogFile) : logJson(space, ["decision-status"], env);
  const changesRaw = changesLogFile ? readJsonFile(changesLogFile) : logJson(space, ["change"], env);
  if (decisionRaw == null && !logFile) {
    throw new Error("no decision log: pass --log/--statuses-log/--changes-log (fixtures) or TONK_BIN=<dev tonk with PR #1146>");
  }
  const model = normalizeLog(decisionRaw);
  const st = normalizeLog(statusesRaw);
  model.statuses.push(...st.statuses);
  const ch = normalizeLog(changesRaw);
  model.changes.push(...ch.changes);
  return model;
}

async function decisionsAt(pointStr, { env = process.env, space, cwd = process.cwd(), logFile, statusesLogFile, changesLogFile, defaultStatus = "accepted", json = false } = {}) {
  const point = parsePoint(pointStr);
  const model = getModel(space, env, { logFile, statusesLogFile, changesLogFile });
  const resolved = resolvePoint(model, point, { resolveRef: (r) => resolveGitRef(cwd, r) });
  const resolvedRevision = resolved.version || (resolved.edition != null ? `${resolved.edition}@?` : null);

  // Route 1 (DEV): restore --dry-run — only with a real/dev tonk and a space
  let route = "fold";
  let decisions = null;
  if (!logFile && space && resolvedRevision && resolvedRevision !== `${resolved.edition}@?`) {
    if (restoreDryRun(space, resolvedRevision, env)) {
      route = "restore";
      restoreRevision(space, resolvedRevision, env); // switches to the restored branch
      const ds = queryJson(space, "decision", [], env);
      const ss = queryJson(space, "decision-status", [], env);
      switchMain(space, env);
      const strip = (v) => String(v ?? "").replace(/:$/, "");
      const dec = ds.map((d) => ({ ...d, id: d.this || d.id, status: undefined }));
      const stat = new Map();
      for (const s of ss) {
        const key = s.decision;
        const p = stat.get(key);
        if (!p || String(s.at) >= String(p.at)) stat.set(key, strip(s.status));
      }
      const superseded = new Set(dec.map((d) => d.supersedes).filter(Boolean));
      decisions = dec
        .filter((d) => !superseded.has(d.id))
        .map((d) => ({ ...d, status: stat.get(d.id) || defaultStatus }));
    }
  }
  if (!decisions) {
    route = "fold";
    decisions = foldDecisions(model, resolved, { defaultStatus });
  }

  const result = { route, point: pointStr, resolvedRevision, decisions };
  process.stderr.write(`route: ${route}${resolvedRevision ? ` (revision ${resolvedRevision})` : ""}\n`); // always say which route
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (!decisions.length) process.stdout.write("(no decisions at this point)\n");
    for (const d of decisions) {
      process.stdout.write(`- [${d.status}] ${d.title ?? d.name ?? d.id}${d.supersedes ? ` (supersedes ${d.supersedes})` : ""}\n`);
      if (d.chosen) process.stdout.write(`  chosen: ${d.chosen}\n`);
      if (d.by || d.at) process.stdout.write(`  by ${d.by ?? "?"} at ${d.at ?? "?"}\n`);
    }
  }
  return result;
}

export async function main(argv, env = process.env) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  if (argv[0] !== "decisions") {
    process.stderr.write(
      "usage: tool.mjs decisions --at <edition@origin | ISO-time | git-commit> [--space S] [--cwd DIR] [--json]\n" +
        "          [--log FILE] [--statuses-log FILE] [--changes-log FILE] [--default-status accepted|proposed]\n",
    );
    return 2;
  }
  const point = flag("--at");
  if (!point) {
    process.stderr.write("error: --at <point> is required\n");
    return 2;
  }
  await decisionsAt(point, {
    env,
    space: flag("--space") || env.TONK_SPACE || null,
    cwd: flag("--cwd") || process.cwd(),
    logFile: flag("--log"),
    statusesLogFile: flag("--statuses-log"),
    changesLogFile: flag("--changes-log"),
    defaultStatus: flag("--default-status") || "accepted",
    json: argv.includes("--json"),
  });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      process.stderr.write(`decisions --at: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    });
}
