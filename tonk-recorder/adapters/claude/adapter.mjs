#!/usr/bin/env node
// adapters/claude/adapter.mjs — per-harness runtime adapter (SPEC §4.2).
//
// Installed into ~/.claude/settings.json as the command of each tagged hook
// entry:
//
//   node "<this file>" <event> # @tonk-recorder
//
// It reads the Claude Code hook payload from stdin, maps the event onto the
// shared entry point (`tool.mjs hook <neutral-event>`), normalises the
// payload (session_id, transcript_path, cwd; prompt from UserPromptSubmit;
// synthesised turn_id stashed per session), and execs tool.mjs with the
// neutral payload on stdin, forwarding stdout/stderr and the exit code.
//
// Hooks must fail open (SPEC §4.1): any internal error exits 0 silently on
// stdout so a broken recorder never blocks the harness.
//
// Resolution:
//   tool.mjs   --tool <path> flag > $TONK_TOOL > tool.mjs next to this file
//   state dir  $TONK_RECORDER_STATE_DIR > ~/.tonk/recorder-state

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CC_TO_NEUTRAL, normalizeEvent, adaptPayload, TurnStore } from './lib/payload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const args = process.argv.slice(2);
  const event = args.find((a, i) => i === 0 && !a.startsWith('--'));
  const toolFlagIdx = args.indexOf('--tool');
  const toolPath =
    (toolFlagIdx !== -1 && args[toolFlagIdx + 1]) ||
    process.env.TONK_TOOL ||
    join(HERE, 'tool.mjs');
  const stateDir =
    process.env.TONK_RECORDER_STATE_DIR || join(homedir(), '.tonk', 'recorder-state');

  let neutral;
  try {
    neutral = normalizeEvent(event ?? '');
  } catch {
    process.stderr.write(`tonk-recorder adapter: unknown event ${event ?? '(none)'}\n`);
    return 0; // fail open
  }

  let ccPayload = {};
  const raw = readStdin();
  if (raw.trim() !== '') {
    try {
      ccPayload = JSON.parse(raw);
    } catch {
      process.stderr.write('tonk-recorder adapter: stdin is not JSON; forwarding empty payload\n');
      return 0; // fail open: do not call the recorder with garbage
    }
  }

  const store = new TurnStore(stateDir);
  let neutralPayload;
  try {
    neutralPayload = adaptPayload(neutral, ccPayload, store);
  } catch (err) {
    process.stderr.write(`tonk-recorder adapter: ${err?.message ?? err}\n`);
    return 0; // fail open
  }

  const result = spawnSync(process.execPath, [toolPath, 'hook', neutral], {
    input: JSON.stringify(neutralPayload),
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(`tonk-recorder adapter: cannot run ${toolPath}: ${result.error.message}\n`);
    return 0; // fail open
  }
  return result.status ?? 0;
}

process.exit(main());
