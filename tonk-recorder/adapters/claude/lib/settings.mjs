// adapters/claude/lib/settings.mjs — pure functions for managing TAGGED
// hook entries in ~/.claude/settings.json (SPEC §4.2, §8; marker convention
// documented in adapters/claude/README.md and tests/h2/fixtures/layout.stub.md
// — H2's draft of contracts/layout.md, which W0 owns).
//
// Zero-dependency, Node ESM. No network, no side effects beyond the file the
// caller passes in.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Marker substring identifying recorder-managed hook entries. */
export const MARKER = '@tonk-recorder';

/** Harness this adapter supports. */
export const HARNESS = 'claude';

/**
 * Claude Code hook event -> shared tool.mjs hook entry point (SPEC §4.2).
 * Payloads carry session_id, transcript_path, cwd; the prompt arrives on
 * UserPromptSubmit.
 */
export const EVENT_MAP = Object.freeze({
  SessionStart: 'session-start',
  UserPromptSubmit: 'pre-agent',
  Stop: 'post-agent',
  SessionEnd: 'session-end',
});

/** Error thrown when an existing settings file is not valid JSON. */
export class SettingsParseError extends Error {
  constructor(path, cause) {
    super(`settings file ${path} is not valid JSON: ${cause?.message ?? cause}`);
    this.name = 'SettingsParseError';
    this.path = path;
  }
}

/** The managed hook object for one event, tagged via the command marker. */
export function managedHook(adapterPath, neutralEvent) {
  return {
    type: 'command',
    command: `node ${JSON.stringify(adapterPath)} ${neutralEvent} # ${MARKER}`,
  };
}

/** Is this hook entry managed by the recorder? */
export function isManagedHook(hook) {
  return (
    hook !== null &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    hook.command.includes(MARKER)
  );
}

/** Read + parse a settings file. Missing file -> {}. Bad JSON -> SettingsParseError. */
export function loadSettings(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top level is not a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new SettingsParseError(file, err);
  }
}

/** Serialize settings the way Claude Code writes them: 2-space JSON + newline. */
export function serializeSettings(settings) {
  return JSON.stringify(settings, null, 2) + '\n';
}

/**
 * Write settings atomically (tmp file + rename), creating the parent dir.
 * Never called with a parse-failed object: loadSettings throws first, so a
 * broken user file is never clobbered.
 */
export function writeSettings(file, settings) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tonk-tmp-${process.pid}`;
  writeFileSync(tmp, serializeSettings(settings), 'utf8');
  renameSync(tmp, file);
}

function clone(obj) {
  return obj === undefined ? {} : structuredClone(obj);
}

/**
 * Install the four tagged hook entries into a settings object.
 * Returns a NEW object; the input is not mutated.
 * Idempotent: existing managed entries are removed first, then exactly one
 * managed entry per event is added (appended to an existing '' matcher
 * group when present, so the user's own hooks in that group survive).
 */
export function installHooks(settings, { adapterPath } = {}) {
  if (!adapterPath) throw new Error('installHooks: adapterPath is required');
  const out = clone(settings);
  if (out.hooks === undefined) out.hooks = {};
  if (typeof out.hooks !== 'object' || out.hooks === null || Array.isArray(out.hooks)) {
    throw new Error('settings.hooks is not an object — refusing to touch it');
  }
  const added = [];
  for (const [ccEvent, neutralEvent] of Object.entries(EVENT_MAP)) {
    const prev = Array.isArray(out.hooks[ccEvent]) ? out.hooks[ccEvent] : [];
    // Drop previously managed entries (re-install / update path) and any
    // group left empty by that removal, so a rerun is a true no-op.
    const arr = [];
    for (const group of prev) {
      if (group && Array.isArray(group.hooks)) {
        const hadManaged = group.hooks.some(isManagedHook);
        group.hooks = group.hooks.filter((h) => !isManagedHook(h));
        if (group.hooks.length > 0 || !hadManaged) arr.push(group);
      } else {
        arr.push(group);
      }
    }
    const hook = managedHook(adapterPath, neutralEvent);
    let group = arr.find(
      (g) => g && g.matcher === '' && Array.isArray(g.hooks) && g.hooks.length > 0,
    );
    if (!group) {
      group = { matcher: '', hooks: [] };
      arr.push(group);
    }
    group.hooks.push(hook);
    out.hooks[ccEvent] = arr;
    added.push({ event: ccEvent, hookEvent: neutralEvent, command: hook.command });
  }
  return { settings: out, added };
}

/**
 * Remove ONLY the tagged entries. Returns a NEW object plus a removal
 * count. Hook groups left empty are dropped, event keys left empty are
 * dropped, and a `hooks` key left empty is dropped — the user's own entries
 * are never modified.
 */
export function uninstallHooks(settings) {
  const out = clone(settings);
  let removed = 0;
  if (out.hooks === undefined || typeof out.hooks !== 'object' || out.hooks === null) {
    return { settings: out, removed };
  }
  for (const event of Object.keys(out.hooks)) {
    const arr = out.hooks[event];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (const group of arr) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => {
        if (isManagedHook(h)) {
          removed += 1;
          return false;
        }
        return true;
      });
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (kept.length > 0) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

/** List the managed entries currently present: [{event, hookEvent, command}]. */
export function statusHooks(settings) {
  const found = [];
  const hooks = settings?.hooks;
  if (typeof hooks !== 'object' || hooks === null) return found;
  const neutralByCommand = new Map();
  for (const [ccEvent, neutralEvent] of Object.entries(EVENT_MAP)) neutralByCommand.set(ccEvent, neutralEvent);
  for (const [event, arr] of Object.entries(hooks)) {
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isManagedHook(hook)) {
          found.push({ event, hookEvent: neutralByCommand.get(event) ?? null, command: hook.command });
        }
      }
    }
  }
  return found;
}
