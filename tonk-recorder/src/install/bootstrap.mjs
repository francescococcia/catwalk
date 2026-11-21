#!/usr/bin/env node
// src/install/bootstrap.mjs — B2, the no-wrapper bootstrap path (SPEC §3.3).
//
// The space's AGENTS.md carries a generated bootstrap block; an agent with
// only `tonk` and a link pastes it:
//
//   # Tonk recorder bootstrap — generated; do not edit
//   ```sh
//   mkdir -p ~/.tonk/tools/<wrapper>/<version>
//   npx --yes @tonk/cli blob cat <blob-ref> > ~/.tonk/tools/<wrapper>/<version>/tool.mjs
//   node ~/.tonk/tools/<wrapper>/<version>/tool.mjs install --expect-sha256 <sha256>
//   ```
//
// This module generates that block (B1 embeds it into the space AGENTS.md —
// integration point), parses it back out of AGENTS.md text, and can run the
// same steps programmatically (used by tests; in tests `npx --yes @tonk/cli`
// is replaced by $TONK_BIN, keeping everything offline).
//
// The block never contains an invite link (SPEC §8).
import fs from 'node:fs';
import path from 'node:path';
import { runTonk, EXIT } from './tonk.mjs';
import { sha256Hex, shaMatches, normalizeSha } from './verify.mjs';

export const BOOTSTRAP_HEADING = '# Tonk recorder bootstrap — generated; do not edit';
export const DEFAULT_WRAPPER = 'tonk-recorder';

export function toolsDir(home, wrapper = DEFAULT_WRAPPER, version) {
  return path.join(home, '.tonk', 'tools', wrapper, version);
}

export function bootstrapBlock({ wrapper = DEFAULT_WRAPPER, version, blobRef, sha256 }) {
  return [
    BOOTSTRAP_HEADING,
    '',
    '```sh',
    `mkdir -p ~/.tonk/tools/${wrapper}/${version}`,
    `npx --yes @tonk/cli blob cat ${blobRef} > ~/.tonk/tools/${wrapper}/${version}/tool.mjs`,
    `node ~/.tonk/tools/${wrapper}/${version}/tool.mjs install --expect-sha256 ${sha256}`,
    '```',
    '',
  ].join('\n');
}

// Parse the bootstrap block out of AGENTS.md markdown (as printed by
// `tonk space agents get`). Returns { wrapper, version, blobRef, sha256,
// commands } or null.
export function parseBootstrapBlock(markdown) {
  if (typeof markdown !== 'string') return null;
  const idx = markdown.indexOf(BOOTSTRAP_HEADING);
  if (idx === -1) return null;
  const fence = markdown.slice(idx).match(/```sh\n([\s\S]*?)```/);
  if (!fence) return null;
  const commands = fence[1].split('\n').map((l) => l.trim()).filter(Boolean);
  const text = fence[1];
  const mkdir = text.match(/~\/\.tonk\/tools\/([^/\s]+)\/([^/\s]+)/);
  const blobRef = text.match(/\b(?:blob|asset):[0-9A-Za-z]+/);
  const sha = text.match(/\b(?:sha256:)?[0-9a-fA-F]{64}\b/);
  if (!mkdir || !blobRef || !sha) return null;
  return {
    wrapper: mkdir[1],
    version: mkdir[2],
    blobRef: blobRef[0],
    sha256: normalizeSha(sha[0]),
    commands,
  };
}

// Run the bootstrap steps programmatically (SPEC §3.3) against a fake or real
// HOME. `tonkBin` overrides the binary (tests pass the stub). Verifies the
// sha256 BEFORE running install; install re-verifies (defense in depth).
export async function runBootstrap(opts) {
  const {
    home,
    wrapper = DEFAULT_WRAPPER,
    version,
    blobRef,
    sha256,
    harness = 'vibe',
    tonkBin,
    cwd,
  } = opts;
  if (!home) return { ok: false, code: EXIT.ERROR, error: 'no HOME; pass --home DIR' };
  if (!version || !blobRef || !sha256) {
    return { ok: false, code: EXIT.ERROR, error: 'need version, blobRef and sha256' };
  }
  const dir = toolsDir(home, wrapper, version);
  const staged = path.join(dir, 'tool.mjs');

  const cat = runTonk(['blob', 'cat', blobRef], { cwd, tonkBin });
  if (cat.status !== 0) {
    return { ok: false, code: EXIT.ERROR, error: `tonk blob cat ${blobRef} failed: ${cat.stderr.trim()}` };
  }
  const bytes = cat.stdout;
  if (!shaMatches(bytes, sha256)) {
    return {
      ok: false,
      code: EXIT.INTEGRITY,
      error: `sha256 mismatch for ${blobRef}: expected ${normalizeSha(sha256)}, got ${sha256Hex(bytes)} — refusing to install`,
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(staged, bytes);

  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [staged, 'install', '--harness', harness, '--expect-sha256', normalizeSha(sha256), '--version', version, '--home', home], {
    cwd,
    env: { ...process.env, HOME: home, ...(tonkBin ? { TONK_BIN: tonkBin } : {}) },
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) {
    return { ok: false, code: r.status ?? EXIT.ERROR, error: `install failed: ${(r.stderr || '').trim()}`, staged };
  }
  return { ok: true, code: EXIT.OK, staged, sha256: sha256Hex(bytes), stdout: r.stdout };
}

const isMain = (() => {
  try {
    const a = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
    return !!a && a === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  // node bootstrap.mjs run --home DIR --version V --blob-ref REF --sha256 SHA [--wrapper W]
  const argv = process.argv.slice(2);
  const get = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  if (argv[0] !== 'run') {
    process.stderr.write('usage: node bootstrap.mjs run --home DIR --version V --blob-ref REF --sha256 SHA [--wrapper W] [--harness vibe]\n');
    process.exit(EXIT.ERROR);
  }
  runBootstrap({
    home: get('home') || process.env.HOME,
    wrapper: get('wrapper') || DEFAULT_WRAPPER,
    version: get('version'),
    blobRef: get('blob-ref'),
    sha256: get('sha256'),
    harness: get('harness') || 'vibe',
    tonkBin: process.env.TONK_BIN,
    cwd: get('cwd') || process.cwd(),
  }).then((res) => {
    if (!res.ok) process.stderr.write(`error: ${res.error}\n`);
    else process.stdout.write(res.stdout ?? `bootstrapped ${res.staged}\n`);
    process.exit(res.code);
  });
}
