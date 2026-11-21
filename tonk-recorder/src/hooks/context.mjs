// session-start additional_context (contracts/hooks.md, SPEC §6.3):
// (a) decision instructions (§6.7 — instructions/decisions.md from R4, now on
//     master, read from PLUGIN_ROOT/repo when present, else embedded),
// (b) accepted decisions, (c) other agents' recent changes since this agent's
// last session (one line each: agent, prompt first line, files) — all read
// from the LOCAL space copy, with its age stated ("as of N turns ago").

import fs from "node:fs";
import path from "node:path";
import { queryJson } from "./tonk.mjs";
import { DECISION_INSTRUCTIONS } from "./instructions.mjs";

/** dash-case notation key -> camelCase JSON mirror key (contracts/records.md). */
export const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[camel(k)] = v;
  return out;
}

export function loadInstructions(env, cwd) {
  const candidates = [];
  if (env.PLUGIN_ROOT) candidates.push(path.join(env.PLUGIN_ROOT, "instructions", "decisions.md"));
  candidates.push(path.join(cwd, "instructions", "decisions.md"));
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {}
  }
  return DECISION_INSTRUCTIONS;
}

/** Latest status per decision entity. Keyword values arrive as "accepted:" —
 *  normalised to "accepted". Default when no status record: 'accepted'
 *  (SPEC §11.8: hand-added decisions start :accepted). */
export function statusOfMap(statusRecords) {
  const norm = (v) => String(v || "").replace(/:$/, "");
  const byDecision = new Map();
  for (const s0 of statusRecords) {
    const s = normalizeRow(s0);
    const d = s.decision;
    if (!d) continue;
    const prev = byDecision.get(d);
    if (!prev || String(s.at) >= String(prev.at)) byDecision.set(d, { status: norm(s.status), at: s.at });
  }
  return (id) => (byDecision.get(id) || { status: "accepted" }).status;
}

export function acceptedDecisions(decisions, statusRecords) {
  const statusOf = statusOfMap(statusRecords);
  return decisions
    .map((d0) => {
      const d = normalizeRow(d0);
      return { ...d, id: d.id || d.this, status: statusOf(d.id || d.this) };
    })
    .filter((d) => d.status === "accepted");
}

/** One line per change: agent, prompt first line, files. */
export function formatChangeLine(c0) {
  const c = normalizeRow(c0);
  const promptLine = String(c.prompt || "").split("\n")[0];
  let files = c.files;
  if (!Array.isArray(files)) files = c.files ? [c.files] : [];
  const fileList = files.map((f) => (typeof f === "string" ? f : normalizeRow(f).path)).filter(Boolean).join(", ");
  return `- ${c.agent ?? "?"}: ${promptLine} — files: ${fileList}`;
}

/**
 * Build the session-start context from the LOCAL space copy (TONK_NO_SYNC
 * queries, no network). `ageTurns` = turns since the last checkpoint.
 */
export function buildSessionStartContext({ space, agentName, lastSeenOtherAgentAt, ageTurns, env, cwd }) {
  const instructions = loadInstructions(env, cwd || env.__CWD || process.cwd());
  const decisions = queryJson(space, "decision", [], env).map(normalizeRow);
  const statusRecords = queryJson(space, "decision-status", [], env);
  const accepted = acceptedDecisions(decisions, statusRecords);

  let changes = queryJson(space, "change", [], env).map(normalizeRow);
  // lens rows: one row per change-file value (repeated this) — group onto owner
  const fileRows = queryJson(space, "change-file", [], env);
  const filesByChange = new Map();
  for (const fr0 of fileRows) {
    const fr = normalizeRow(fr0);
    const key = fr.change;
    if (!filesByChange.has(key)) filesByChange.set(key, []);
    filesByChange.get(key).push(fr);
  }
  changes = changes.map((c) => ({ ...c, files: filesByChange.get(c.this) || c.files || [] }));

  changes = changes.filter((c) => (c.agent || "") !== agentName);
  if (lastSeenOtherAgentAt) changes = changes.filter((c) => String(c.at || "") > String(lastSeenOtherAgentAt));
  changes.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  const recent = changes.slice(0, 20);

  const ageText = `as of ${ageTurns} turn${ageTurns === 1 ? "" : "s"} ago`;
  const parts = [];
  parts.push(`# Tonk recorder context (local space copy, ${ageText})\n`);
  parts.push(instructions.trim());
  parts.push("\n## Accepted decisions\n");
  parts.push(
    accepted.length
      ? accepted.map((d) => `- ${d.title ?? d.id ?? "?"}: ${d.chosen ?? ""} (by ${d.by ?? "?"}, ${d.at ?? ""})`).join("\n")
      : "(none)",
  );
  parts.push("\n## Other agents' recent changes (since your last session)\n");
  parts.push(recent.length ? recent.map(formatChangeLine).join("\n") : "(none)");
  return parts.join("\n") + "\n";
}

/** Update check (SPEC §3.4): newer `tool` record from a trusted publisher →
 *  one-line system_message. Tolerant: no records → null. */
export function updateNotice({ space, localVersion, env }) {
  const tools = queryJson(space, "tool", [], env).map(normalizeRow);
  if (!tools.length) return null;
  const latest = tools.sort((a, b) => String(b.publishedAt || b.at || "").localeCompare(String(a.publishedAt || a.at || "")))[0];
  if (!latest.version || String(latest.version) <= String(localVersion)) return null;
  const trusted = queryJson(space, "trusted-publisher", [], env).map(normalizeRow);
  if (trusted.length && latest.publisher && !trusted.some((t) => t.identity === latest.publisher)) return null;
  return `tonk-recorder: newer recorder version ${latest.version} available in the space (publisher ${latest.publisher ?? "?"}). Update tonk-recorder, then run \`tonk-recorder connect\` in this folder.`;
}
