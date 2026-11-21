// R3 write path. Nothing here writes to tonk directly: every record is
// QUEUED and the single writer puts it in (queue.mjs — tonk cannot take
// parallel local writes). R2 (src/writer/tool.mjs) still owns notation
// building and the 64 KB diff split; the writer applies them when it runs
// the job.
//
// Before anything is queued: tonk links are stripped from the prompt, the
// response and the diff (links.mjs — a link is a key to the space), and the
// diff is secret-scanned (SPEC §6.6).

import { enqueue, drain } from "./queue.mjs";
import { stripLinks } from "./links.mjs";
import { queryJson } from "./tonk.mjs";
import { buildChangeNotation, splitDiff } from "../writer/tool.mjs";
import { scanSecrets } from "../snapshot/tool.mjs";

const y = (v) => JSON.stringify(String(v));
const kw = (v) => `:${v}`;
const ynat = (v) => String(v ?? 0);

export { buildChangeNotation, splitDiff };

/** How long a hook waits for the writer to take its record before leaving it
 *  queued for the next hook / checkpoint. */
const WAIT_MS = 2000;

function queueAndDrain(space, job, env) {
  const file = enqueue(space, job, env);
  const d = drain(space, env, { until: file, waitMs: WAIT_MS });
  return { file, mine: d.results[file] || null, drained: d };
}

/** Queue one change record (idempotent by session+turn when written). */
export async function writeChange(space, rec, env, root) {
  // idempotent by (session, turn): a repeated hook writes nothing (SPEC §6.4)
  if (queryJson(space, "change", [`session=${rec.session}`, `turn=${rec.turn}`], env).length > 0) {
    return { written: false, skipped: true, redacted: Boolean(rec.redacted) };
  }
  const prompt = stripLinks(rec.prompt);
  const response = stripLinks(rec.response);
  const linkFree = stripLinks(rec.diff || "");
  const scan = scanSecrets(linkFree.text);
  const redacted = Boolean(scan.redacted || prompt.removed || response.removed || linkFree.removed);
  const clean = { ...rec, prompt: prompt.text, response: response.text, redacted };
  delete clean.diff;

  const { mine } = queueAndDrain(space, { kind: "change", rec: clean, diff: scan.text }, env);
  if (mine && mine.status === "failed") throw new Error(`tonk refused the change record (kept in the queue's failed/ folder): ${mine.error}`);
  if (mine && mine.status === "skipped") return { written: false, skipped: true, redacted };
  // written by us, or queued for / taken by another writer
  return { written: true, skipped: false, queued: !mine, redacted, blob: mine?.blob ?? null, doc: mine?.doc };
}

/** session-start write (contracts/records.md §session). */
export function buildSessionStartDoc(rec) {
  return [
    "session!:",
    `  id: ${y(rec.session)}`,
    `  agent: ${y(rec.agent)}`,
    `  harness: ${kw(rec.harness || "vibe")}`,
    `  project: ${y(rec.project)}`,
    `  started: ${y(rec.started)}`,
    "  changes: 0",
    "",
  ].join("\n");
}

/** session-end: re-assert the SAME entity (query-bind this: ?s). */
export function buildSessionEndDoc(rec) {
  return [
    "session:",
    "  this: ?s",
    `  id: ${y(rec.session)}`,
    "",
    "session!:",
    "  this: ?s",
    `  ended: ${y(rec.ended)}`,
    `  changes: ${ynat(rec.changes)}`,
    "",
  ].join("\n");
}

function writeDoc(space, doc, env, what) {
  const { mine } = queueAndDrain(space, { kind: "eval", doc }, env);
  if (mine && mine.status === "failed") throw new Error(`tonk refused the ${what} record: ${mine.error}`);
  return { written: true, queued: !mine, doc };
}

export async function writeSessionStart(space, rec, env, root) {
  return writeDoc(space, buildSessionStartDoc(rec), env, "session");
}

export async function writeSessionEnd(space, rec, env, root) {
  return writeDoc(space, buildSessionEndDoc(rec), env, "session-end");
}

/** Register this agent under its role (packs/roles.notation). */
export function buildAgentDoc(rec) {
  return [
    "agent!:",
    `  name: ${y(rec.name)}`,
    `  role: ${y(rec.role)}`,
    `  harness: ${y(rec.harness || "vibe")}`,
    `  at: ${y(rec.at)}`,
    "",
  ].join("\n");
}

export async function writeAgent(space, rec, env) {
  return writeDoc(space, buildAgentDoc(rec), env, "agent");
}
