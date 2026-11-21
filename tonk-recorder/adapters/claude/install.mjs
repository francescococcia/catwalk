#!/usr/bin/env node
// adapters/claude/install.mjs — `install|uninstall|status --harness claude`
// (SPEC §4.2, §9.2 H2). Manages TAGGED entries in ~/.claude/settings.json;
// the wrapper's `install --harness claude` delegates here (integration
// point: B0's src/cli dispatches to this file per-harness).
//
//   node install.mjs install   --harness claude [--home DIR] [--settings FILE] [--adapter PATH]
//   node install.mjs uninstall --harness claude [--home DIR] [--settings FILE]
//   node install.mjs status    --harness claude [--home DIR] [--settings FILE]
//
// --home defaults to $HOME (tests use a fake HOME). --settings defaults to
// <home>/.claude/settings.json. --adapter defaults to adapter.mjs next to
// this file — the command written into the tagged hook entries.
//
// Exit codes: 0 ok · 1 usage/other error · 2 settings file exists but is
// not valid JSON (file is left untouched).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  HARNESS,
  EVENT_MAP,
  loadSettings,
  writeSettings,
  installHooks,
  uninstallHooks,
  statusHooks,
  SettingsParseError,
} from './lib/settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADAPTER = join(HERE, 'adapter.mjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  return [
    'usage: node install.mjs <install|uninstall|status> --harness claude [--home DIR] [--settings FILE] [--adapter PATH]',
    '',
    `events managed (${HARNESS}): ` +
      Object.entries(EVENT_MAP).map(([cc, n]) => `${cc} -> tool.mjs hook ${n}`).join(', '),
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !['install', 'uninstall', 'status'].includes(command)) {
    process.stderr.write(usage() + '\n');
    return 1;
  }
  if (args.harness !== HARNESS) {
    const got = args.harness === undefined ? '(none)' : String(args.harness);
    process.stderr.write(`error: this adapter only supports --harness ${HARNESS} (got ${got})\n`);
    return 1;
  }
  const home = args.home || process.env.HOME;
  if (!home) {
    process.stderr.write('error: no HOME; pass --home DIR\n');
    return 1;
  }
  const settingsFile = args.settings || join(home, '.claude', 'settings.json');
  const adapterPath = args.adapter || DEFAULT_ADAPTER;

  if (command === 'status') {
    const settings = existsSync(settingsFile) ? loadSettings(settingsFile) : {};
    const found = statusHooks(settings);
    process.stdout.write(JSON.stringify({ settings: settingsFile, harness: HARNESS, managed: found }, null, 2) + '\n');
    return 0;
  }

  let settings;
  try {
    settings = loadSettings(settingsFile);
  } catch (err) {
    if (err instanceof SettingsParseError) {
      process.stderr.write(`error: ${err.message} — leaving the file untouched\n`);
      return 2;
    }
    throw err;
  }

  if (command === 'install') {
    const { settings: next, added } = installHooks(settings, { adapterPath });
    writeSettings(settingsFile, next);
    process.stdout.write(
      JSON.stringify({ settings: settingsFile, harness: HARNESS, installed: added }, null, 2) + '\n',
    );
    return 0;
  }

  // uninstall
  if (!existsSync(settingsFile)) {
    process.stdout.write(JSON.stringify({ settings: settingsFile, harness: HARNESS, removed: 0, note: 'no settings file' }, null, 2) + '\n');
    return 0;
  }
  const { settings: next, removed } = uninstallHooks(settings);
  writeSettings(settingsFile, next);
  process.stdout.write(JSON.stringify({ settings: settingsFile, harness: HARNESS, removed }, null, 2) + '\n');
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`error: ${err?.message ?? err}\n`);
  process.exit(1);
}
