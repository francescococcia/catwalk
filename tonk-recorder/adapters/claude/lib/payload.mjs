// adapters/claude/lib/payload.mjs — map a Claude Code hook payload (stdin
// JSON) onto the harness-neutral payload the shared `tool.mjs hook …` entry
// points consume (SPEC §4.2, §5.1, contracts/hooks.md pending W0).
//
// Claude Code payloads carry session_id, transcript_path, cwd on every
// event; the prompt arrives only on UserPromptSubmit; there is no turn_id.
// The adapter therefore synthesises a turn_id per submitted prompt and
// stashes it (with the prompt) in a small per-session state file, so the
// later Stop hook can attach the same turn_id (SPEC §5.1: "prompt …
// stashed … by turn_id").

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** Claude Code event name -> neutral tool.mjs hook event. */
export const CC_TO_NEUTRAL = Object.freeze({
  SessionStart: 'session-start',
  UserPromptSubmit: 'pre-agent',
  Stop: 'post-agent',
  SessionEnd: 'session-end',
});

/** Accept either a Claude Code event name or an already-neutral one. */
export function normalizeEvent(event) {
  if (CC_TO_NEUTRAL[event]) return CC_TO_NEUTRAL[event];
  if (Object.values(CC_TO_NEUTRAL).includes(event)) return event;
  throw new Error(`unknown hook event: ${event}`);
}

/** Per-session turn state: { sessionId: { turn_id, prompt, at } } in <dir>/<sessionId>.json */
export class TurnStore {
  constructor(dir) {
    this.dir = dir;
  }

  _file(sessionId) {
    // session ids are not path-safe in general; hash them for the filename
    const safe = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32);
    return join(this.dir, `${safe}.json`);
  }

  load(sessionId) {
    if (!sessionId) return null;
    try {
      return JSON.parse(readFileSync(this._file(sessionId), 'utf8'));
    } catch {
      return null;
    }
  }

  save(sessionId, record) {
    if (!sessionId) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this._file(sessionId), JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  clear(sessionId) {
    if (!sessionId) return;
    try {
      rmSync(this._file(sessionId));
    } catch {
      /* already gone */
    }
  }

  /** Test/debug helper: does state exist for this session? */
  has(sessionId) {
    return sessionId ? existsSync(this._file(sessionId)) : false;
  }
}

function newTurnId() {
  return `cc-${randomUUID()}`;
}

/**
 * Build the neutral payload for a hook event.
 *
 * @param neutralEvent one of session-start | pre-agent | post-agent | session-end
 * @param cc           the parsed Claude Code stdin payload (object)
 * @param store        TurnStore for stashing prompt/turn_id
 * @returns the neutral payload object to pipe into `tool.mjs hook <event>`
 */
export function adaptPayload(neutralEvent, cc, store) {
  const src = cc && typeof cc === 'object' ? cc : {};
  const out = { hook_event_name: neutralEvent };
  for (const key of ['session_id', 'transcript_path', 'cwd', 'parent_session_id', 'agent_name']) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  const sessionId = src.session_id;

  if (neutralEvent === 'pre-agent') {
    // UserPromptSubmit: the prompt lives here. Synthesise (or reuse) the
    // turn id and stash both so the later Stop can attach the same turn.
    const prompt = typeof src.prompt === 'string' ? src.prompt : '';
    const prev = store?.load(sessionId);
    const turnId = prev?.turn_id ?? newTurnId();
    store?.save(sessionId, { turn_id: turnId, prompt, at: new Date().toISOString() });
    out.prompt = prompt;
    out.turn_id = turnId;
  }

  if (neutralEvent === 'post-agent') {
    // Stop: attach the turn id stashed at UserPromptSubmit (if any).
    const rec = store?.load(sessionId);
    if (rec?.turn_id) out.turn_id = rec.turn_id;
    if (typeof src.response_text === 'string') out.response_text = src.response_text;
  }

  if (neutralEvent === 'session-end') {
    store?.clear(sessionId);
  }

  return out;
}
