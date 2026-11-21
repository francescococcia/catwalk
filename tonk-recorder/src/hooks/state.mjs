// Local hook state under the data root (contracts/layout.md §4):
//   DATA_ROOT = $PLUGIN_DATA (Vibe plugin) else $TONK_RECORDER_STATE_DIR
//               else ~/.tonk/recorder/ (Claude hooks / no-wrapper path)
// Layout (contracts/layout.md):
//   snapshots/<session_id>.tree        last snapshot tree hash per session
//   snapshots/<session_id>.index       the temporary GIT_INDEX_FILE (SPEC §6.2)
//   prompts/<session_id>/<turn_id>.json  stashed pre-agent prompt per turn
//   state/<session_id>.json            { turns, lastCheckpointAt, lastSeenOtherAgentAt, agentName }
//   locks/<space>.lock                 writer lock around tonk writes (REQUIRED)
//   cache/update-check.json            last tool-record check
// All state is local, disposable, never committed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function dataRoot(env = process.env) {
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA;
  if (env.TONK_RECORDER_STATE_DIR) return env.TONK_RECORDER_STATE_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".tonk", "recorder");
}

/** Path-safe session id (vibe ids are already safe; sanitize defensively). */
export const sessionSlug = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");

export const paths = {
  tree: (root, sessionId) => path.join(root, "snapshots", `${sessionSlug(sessionId)}.tree`),
  index: (root, sessionId) => path.join(root, "snapshots", `${sessionSlug(sessionId)}.index`),
  prompt: (root, sessionId, turnId) =>
    path.join(root, "prompts", sessionSlug(sessionId), `${String(turnId).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`),
  promptsDir: (root, sessionId) => path.join(root, "prompts", sessionSlug(sessionId)),
  session: (root, sessionId) => path.join(root, "state", `${sessionSlug(sessionId)}.json`),
  lock: (root, space) => path.join(root, "locks", `${String(space).replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`),
  updateCheck: (root) => path.join(root, "cache", "update-check.json"),
};

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

export function readTree(root, sessionId) {
  try {
    return fs.readFileSync(paths.tree(root, sessionId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeTree(root, sessionId, tree) {
  writeJsonAtomic; // (tree is plain text, write directly)
  fs.mkdirSync(path.dirname(paths.tree(root, sessionId)), { recursive: true });
  fs.writeFileSync(paths.tree(root, sessionId), tree + "\n");
}

export function loadSessionState(root, sessionId) {
  return readJson(paths.session(root, sessionId), {
    turns: 0,
    lastCheckpointAt: null,
    lastSeenOtherAgentAt: null,
    agentName: null,
  });
}

export function saveSessionState(root, sessionId, state) {
  writeJsonAtomic(paths.session(root, sessionId), state);
}

export function stashPrompt(root, sessionId, turnId, prompt, at) {
  writeJsonAtomic(paths.prompt(root, sessionId, turnId), { prompt, at });
}

export function getPrompt(root, sessionId, turnId) {
  const j = readJson(paths.prompt(root, sessionId, turnId), null);
  return j ? j.prompt : null;
}

export function clearPrompts(root, sessionId) {
  try {
    fs.rmSync(paths.promptsDir(root, sessionId), { recursive: true, force: true });
  } catch {}
}
