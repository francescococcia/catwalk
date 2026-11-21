#!/usr/bin/env node
// adapters/vibe/tool-side.mjs — Vibe harness adapter (SPEC §4.1, §9.2 H1) and
// the install-side command logic of the single-file recorder (tool.mjs).
//
// This file is deliberately SELF-CONTAINED: only `node:` builtins, only
// line-leading `export ` keywords. src/install/pack.mjs inlines it (plus the
// instructions text) into the single tool.mjs that is stored in the space and
// copied into ~/.vibe/plugins/tonk-recorder/tool.mjs.
//
// CLI (repo side: `node adapters/vibe/install.mjs …`; packed side: `node
// tool.mjs …`):
//
//   install   --harness vibe [--home DIR] [--source PATH] [--expect-sha256 SHA] [--version V]
//   uninstall --harness vibe [--home DIR]
//   status    --harness vibe [--home DIR]
//   instructions            print the "add a decision by hand" text (SPEC §6.7)
//   hook <event>            delegated to the packed hook runtime (R3); fails
//                           open (exit 0) when this build has none
//   --help | --version
//
// `install --harness vibe` writes a USER-LEVEL plugin and nothing else
// (SPEC §4.1):
//
//   ~/.vibe/plugins/tonk-recorder/plugin.json
//   ~/.vibe/plugins/tonk-recorder/tool.mjs
//   ~/.vibe/plugins/tonk-recorder/ai.mistral.vibe/hooks.toml
//
// It never touches the project repo, never touches ~/.vibe/hooks.toml, and
// writes no state file of its own. Reruns are idempotent (same bytes in, same
// bytes out). `uninstall` removes exactly the files install wrote.
//
// Exit codes: 0 ok · 1 usage/other error · 2 integrity refusal (sha256
// mismatch) · 3 untrusted publisher · 4 no tool record (3/4 used by the
// join side in src/install/, kept here so packed tool.mjs shares them).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_NAME = 'tonk-recorder';
export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_DESCRIPTION = 'Records agent code changes into the bound Tonk space.';
export const HARNESS = 'vibe';
export const EXIT = { OK: 0, ERROR: 1, INTEGRITY: 2, UNTRUSTED: 3, NO_TOOL: 4 };
export const DEFAULT_VERSION = '0.0.0';

// The four hooks of SPEC §4.1, in order. post_agent carries timeout = 30.0.
export const HOOKS = [
  { name: 'tonk-session-start', type: 'session_start', command: 'node tool.mjs hook session-start' },
  { name: 'tonk-pre-agent', type: 'pre_agent', command: 'node tool.mjs hook pre-agent' },
  { name: 'tonk-post-agent', type: 'post_agent', command: 'node tool.mjs hook post-agent', timeout: 30.0 },
  { name: 'tonk-session-end', type: 'session_end', command: 'node tool.mjs hook session-end' },
];

// ---------------------------------------------------------------------------
// Templates (byte-exact per SPEC §4.1)
// ---------------------------------------------------------------------------

export function pluginJson(version) {
  // Byte-for-byte the manifest block of SPEC §4.1, version substituted.
  return (
    '{\n' +
    `  "$schema": ${JSON.stringify(PLUGIN_SCHEMA)},\n` +
    `  "name": ${JSON.stringify(PLUGIN_NAME)},\n` +
    `  "version": ${JSON.stringify(version)},\n` +
    `  "description": ${JSON.stringify(PLUGIN_DESCRIPTION)},\n` +
    '  "extensions": { "ai.mistral.vibe": { "schemaVersion": 1, "displayName": "Tonk recorder" } }\n' +
    '}\n'
  );
}

export function hooksToml() {
  // Byte-for-byte the hooks.toml block of SPEC §4.1.
  const blocks = HOOKS.map((h) => {
    const lines = [
      '[[hooks]]',
      `name = ${JSON.stringify(h.name)}`,
      `type = ${JSON.stringify(h.type)}`,
      `command = ${JSON.stringify(h.command)}`,
    ];
    if (h.timeout !== undefined) {
      // SPEC §4.1 spells it `timeout = 30.0` — keep the trailing .0
      lines.push(`timeout = ${Number.isInteger(h.timeout) ? h.timeout.toFixed(1) : String(h.timeout)}`);
    }
    return lines.join('\n');
  });
  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function pluginDir(home) {
  return path.join(home, '.vibe', 'plugins', PLUGIN_NAME);
}

export function pluginFiles(home) {
  const dir = pluginDir(home);
  return {
    manifest: path.join(dir, 'plugin.json'),
    tool: path.join(dir, 'tool.mjs'),
    hooks: path.join(dir, 'ai.mistral.vibe', 'hooks.toml'),
  };
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function normalizeSha(s) {
  return String(s ?? '').trim().toLowerCase().replace(/^sha256:/, '');
}

export function shaMatches(buf, expected) {
  const e = normalizeSha(expected);
  return /^[0-9a-f]{64}$/.test(e) && sha256Hex(buf) === e;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function validVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v);
}

// ---------------------------------------------------------------------------
// Install / uninstall / status
// ---------------------------------------------------------------------------

function defaultSourcePath() {
  // When run as the packed `tool.mjs`, the source is the running file itself
  // (self-copy). When run unpacked from the repo (adapters/vibe/install.mjs),
  // the logic file is tool-side.mjs next to this module.
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
    if (argv1 && path.basename(argv1) === 'tool.mjs') return argv1;
  } catch { /* fall through */ }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'tool-side.mjs');
}

function writeFileAtomic(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let same = false;
  try {
    same = fs.readFileSync(dest).equals(bytes);
  } catch { /* not there yet */ }
  if (same) return false;
  const tmp = dest + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
  return true;
}

// SPEC §3.3's bootstrap block has no --version flag; the version lives in
// the staging path ~/.tonk/tools/<wrapper>/<version>/tool.mjs — infer it.
export function inferVersionFromPath(sourcePath) {
  try {
    const m = fs.realpathSync(sourcePath).match(/\/\.tonk\/tools\/[^/]+\/([^/]+)\/tool\.mjs$/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

export function installVibe(opts = {}) {
  const home = opts.home || process.env.HOME;
  if (!home) return { ok: false, code: EXIT.ERROR, error: 'no HOME; pass --home DIR' };
  const sourcePath = opts.source || defaultSourcePath();
  const version =
    opts.version ||
    process.env.TONK_RECORDER_VERSION ||
    inferVersionFromPath(sourcePath) ||
    DEFAULT_VERSION;
  if (!validVersion(version)) {
    return { ok: false, code: EXIT.ERROR, error: `invalid --version ${JSON.stringify(version)}` };
  }
  let sourceBytes;
  try {
    sourceBytes = fs.readFileSync(sourcePath);
  } catch (err) {
    return { ok: false, code: EXIT.ERROR, error: `cannot read tool source ${sourcePath}: ${err.message}` };
  }
  // Integrity check BEFORE any write: refuse on mismatch, install nothing.
  if (opts.expectSha256 !== undefined && !shaMatches(sourceBytes, opts.expectSha256)) {
    return {
      ok: false,
      code: EXIT.INTEGRITY,
      error: `sha256 mismatch for ${sourcePath}: expected ${normalizeSha(opts.expectSha256)}, got ${sha256Hex(sourceBytes)} — refusing to install`,
    };
  }
  const files = pluginFiles(home);
  const written = [];
  if (writeFileAtomic(files.manifest, Buffer.from(pluginJson(version), 'utf8'))) written.push('plugin.json');
  if (writeFileAtomic(files.tool, sourceBytes)) written.push('tool.mjs');
  if (writeFileAtomic(files.hooks, Buffer.from(hooksToml(), 'utf8'))) written.push('ai.mistral.vibe/hooks.toml');
  return {
    ok: true,
    code: EXIT.OK,
    home,
    pluginDir: pluginDir(home),
    version,
    sha256: sha256Hex(sourceBytes),
    written,
    hooks: HOOKS.map((h) => h.name),
  };
}

export function uninstallVibe(opts = {}) {
  const home = opts.home || process.env.HOME;
  if (!home) return { ok: false, code: EXIT.ERROR, error: 'no HOME; pass --home DIR' };
  const dir = pluginDir(home);
  const files = pluginFiles(home);
  const removed = [];
  for (const [key, f] of Object.entries(files)) {
    try {
      fs.unlinkSync(f);
      removed.push(key);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  // Remove the directories install created, but only if now empty — anything
  // else in the plugin dir belongs to someone else and stays.
  for (const d of [path.dirname(files.hooks), dir]) {
    try { fs.rmdirSync(d); } catch (err) { if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') throw err; }
  }
  return { ok: true, code: EXIT.OK, home, pluginDir: dir, removed, installed: fs.existsSync(files.manifest) };
}

export function statusVibe(opts = {}) {
  const home = opts.home || process.env.HOME;
  if (!home) return { ok: false, code: EXIT.ERROR, error: 'no HOME; pass --home DIR' };
  const files = pluginFiles(home);
  const present = {};
  for (const [key, f] of Object.entries(files)) present[key] = fs.existsSync(f);
  let version;
  try { version = JSON.parse(fs.readFileSync(files.manifest, 'utf8')).version; } catch { version = undefined; }
  return {
    ok: true,
    harness: HARNESS,
    home,
    installed: present.manifest && present.tool && present.hooks,
    files: present,
    version,
    hooksExpected: HOOKS.map((h) => h.name),
  };
}

// ---------------------------------------------------------------------------
// Instructions (SPEC §6.7, R4) — text embedded at pack time; repo fallback
// ---------------------------------------------------------------------------

export function instructionsText() {
  if (typeof globalThis.__TONK_INSTRUCTIONS__ === 'string' && globalThis.__TONK_INSTRUCTIONS__) {
    return globalThis.__TONK_INSTRUCTIONS__;
  }
  try {
    return fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'instructions', 'decisions.md'),
      'utf8',
    );
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function usage() {
  return [
    'tonk-recorder tool.mjs — install-side commands (SPEC §3, §4.1)',
    '',
    '  install   --harness vibe [--home DIR] [--source PATH] [--expect-sha256 SHA] [--version V]',
    '  uninstall --harness vibe [--home DIR]',
    '  status    --harness vibe [--home DIR]',
    '  instructions   print the decision instructions (SPEC §6.7)',
    '  hook <event>   recorder hook entry point (delegates to the packed runtime)',
    '  --help | --version',
    '',
    'exit codes: 0 ok · 1 error · 2 sha256 mismatch (refused) · 3 untrusted publisher · 4 no tool record',
  ].join('\n');
}

export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (args.help === true || command === '--help' || command === '-h') {
    process.stdout.write(usage() + '\n');
    return EXIT.OK;
  }
  if (args.version === true || command === '--version') {
    process.stdout.write((env.TONK_RECORDER_VERSION || DEFAULT_VERSION) + '\n');
    return EXIT.OK;
  }
  if (!['install', 'uninstall', 'status', 'instructions', 'hook'].includes(command)) {
    process.stderr.write(usage() + '\n');
    return EXIT.ERROR;
  }
  if (command === 'instructions') {
    const text = instructionsText();
    if (!text) {
      process.stderr.write('error: instructions text not embedded in this build\n');
      return EXIT.ERROR;
    }
    process.stdout.write(text);
    return EXIT.OK;
  }
  if (command === 'hook') {
    const event = args._[1];
    const runtime = globalThis.__TONK_HOOK_RUNTIME__;
    if (runtime && typeof runtime.run === 'function') {
      return await runtime.run(event, { env });
    }
    // Fail open (SPEC §4.1): a hook must never block the harness. Integration
    // point: the full tool.mjs packs R3's hook runtime, which registers itself
    // as globalThis.__TONK_HOOK_RUNTIME__.
    process.stderr.write(`tonk-recorder: hook ${event ?? '(none)'} — no hook runtime packed in this build; nothing recorded\n`);
    return EXIT.OK;
  }
  // install | uninstall | status — SPEC §3.3's bootstrap line omits
  // --harness, so the default harness is vibe (v1 target, SPEC §4.1)
  const harness = args.harness === true ? HARNESS : args.harness || HARNESS;
  if (harness !== HARNESS) {
    process.stderr.write(`error: this adapter only supports --harness ${HARNESS} (got ${String(harness)})\n`);
    return EXIT.ERROR;
  }
  const home = args.home || env.HOME;
  if (command === 'install') {
    const res = installVibe({
      home,
      source: args.source,
      expectSha256: args['expect-sha256'],
      version: args.version,
    });
    if (!res.ok) {
      process.stderr.write(`error: ${res.error}\n`);
      return res.code;
    }
    process.stdout.write(
      [
        `installed tonk-recorder ${res.version} (harness vibe) into ${res.pluginDir}`,
        `  plugin.json  sha256 of tool.mjs: ${res.sha256}`,
        `  tool.mjs`,
        `  ai.mistral.vibe/hooks.toml  hooks: ${res.hooks.join(', ')}`,
      ].join('\n') + '\n',
    );
    return EXIT.OK;
  }
  if (command === 'uninstall') {
    const res = uninstallVibe({ home });
    if (!res.ok) {
      process.stderr.write(`error: ${res.error}\n`);
      return res.code;
    }
    process.stdout.write(
      res.removed.length
        ? `uninstalled tonk-recorder from ${res.pluginDir} (removed: ${res.removed.join(', ')})\n`
        : `nothing to uninstall at ${res.pluginDir}\n`,
    );
    return EXIT.OK;
  }
  // status
  const res = statusVibe({ home });
  if (!res.ok) {
    process.stderr.write(`error: ${res.error}\n`);
    return res.code;
  }
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  return EXIT.OK;
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
    return !!argv1 && pathToFileURL(argv1).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
