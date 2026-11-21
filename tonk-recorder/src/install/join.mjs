#!/usr/bin/env node
// src/install/join.mjs — B2, the join flow (SPEC §3.2): after `tonk join`,
// read the latest `tool` record, fetch the logic blob, verify sha256 AND
// publisher ∈ trusted-publisher, then install the hooks (composing the H1
// installer: `node tool.mjs install --harness vibe --expect-sha256 …`).
//
// Library use (B0's `<wrapper> join '<link>' --agent-name …` delegates here):
//
//   import { joinSpace } from './join.mjs';
//   const res = await joinSpace({ link, agentName, home, cwd, harness: 'vibe' });
//
// CLI (used by tests):
//
//   node src/install/join.mjs join '<link>' --agent-name NAME [--home DIR]
//       [--cwd DIR] [--harness vibe] [--wrapper tonk-recorder]
//
// Exit codes (shared with tool.mjs): 0 ok · 1 error · 2 sha256 mismatch
// (refused) · 3 untrusted publisher · 4 no tool record.
//
// SPEC §8: the invite link is a bearer credential — it is passed to `tonk
// join` as an argument and NEVER written into any file, record or log by
// this module (errors redact it).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTonk, redactLink, EXIT } from './tonk.mjs';
import { latestToolRecord, trustedIdentities, isTrustedPublisher, shaMatches, sha256Hex, normalizeSha } from './verify.mjs';
import { toolsDir, DEFAULT_WRAPPER } from './bootstrap.mjs';

export async function joinSpace(opts) {
  const {
    link,
    agentName,
    home = process.env.HOME,
    cwd = process.cwd(),
    harness = 'vibe',
    wrapper = DEFAULT_WRAPPER,
    tonkBin,
  } = opts;
  if (!home) return { ok: false, code: EXIT.ERROR, error: 'no HOME; pass --home DIR' };
  if (!link) return { ok: false, code: EXIT.ERROR, error: 'no invite link given' };

  // 1. tonk join (the link goes to tonk as an argv, never to disk)
  const joinArgs = ['join', link];
  if (agentName) joinArgs.push('--agent-name', agentName);
  const joined = runTonk(joinArgs, { cwd, tonkBin });
  if (joined.status !== 0) {
    return { ok: false, code: EXIT.ERROR, error: `tonk join failed: ${joined.stderr.trim()} (link ${redactLink(link)})` };
  }

  // 2. latest `tool` record
  const qTool = runTonk(['query', 'tool', '--json'], { cwd, tonkBin });
  if (qTool.status !== 0) {
    return { ok: false, code: EXIT.ERROR, error: `tonk query tool failed: ${qTool.stderr.trim()}` };
  }
  let toolRows;
  try {
    toolRows = JSON.parse(qTool.stdoutText);
  } catch {
    return { ok: false, code: EXIT.ERROR, error: 'tonk query tool --json did not return a JSON array' };
  }
  const tool = latestToolRecord(toolRows);
  if (!tool || !tool.blob || !tool.sha256) {
    return { ok: false, code: EXIT.NO_TOOL, error: 'no usable tool record in the space (need blob + sha256)' };
  }

  // 3. publisher must be a trusted publisher (SPEC §8)
  const qTrust = runTonk(['query', 'trusted-publisher', '--json'], { cwd, tonkBin });
  if (qTrust.status !== 0) {
    return { ok: false, code: EXIT.ERROR, error: `tonk query trusted-publisher failed: ${qTrust.stderr.trim()}` };
  }
  let trustRows = [];
  try {
    trustRows = JSON.parse(qTrust.stdoutText);
  } catch {
    return { ok: false, code: EXIT.ERROR, error: 'tonk query trusted-publisher --json did not return a JSON array' };
  }
  const identities = trustedIdentities(trustRows);
  if (!isTrustedPublisher(tool.publisher, identities)) {
    return {
      ok: false,
      code: EXIT.UNTRUSTED,
      error: `tool record publisher ${tool.publisher ?? '(none)'} is not a trusted publisher — refusing to install`,
      tool,
    };
  }

  // 4. fetch the logic blob and verify its sha256 (REFUSE on mismatch)
  const cat = runTonk(['blob', 'cat', tool.blob], { cwd, tonkBin });
  if (cat.status !== 0) {
    return { ok: false, code: EXIT.ERROR, error: `tonk blob cat ${tool.blob} failed: ${cat.stderr.trim()}` };
  }
  const bytes = cat.stdout;
  if (!shaMatches(bytes, tool.sha256)) {
    return {
      ok: false,
      code: EXIT.INTEGRITY,
      error: `sha256 mismatch for ${tool.blob}: expected ${normalizeSha(tool.sha256)}, got ${sha256Hex(bytes)} — refusing to install`,
      tool,
    };
  }

  // 5. stage the verified logic, then install the hooks via the H1 installer
  const version = tool.version || '0.0.0';
  const dir = toolsDir(home, wrapper, version);
  const staged = path.join(dir, 'tool.mjs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(staged, bytes);

  const r = spawnSync(
    process.execPath,
    [staged, 'install', '--harness', harness, '--expect-sha256', normalizeSha(tool.sha256), '--version', version, '--home', home],
    { cwd, env: { ...process.env, HOME: home, ...(tonkBin ? { TONK_BIN: tonkBin } : {}) }, encoding: 'utf8', timeout: 60000 },
  );
  if (r.status !== 0) {
    return { ok: false, code: r.status ?? EXIT.ERROR, error: `install failed: ${(r.stderr || '').trim()}`, staged, tool };
  }
  return {
    ok: true,
    code: EXIT.OK,
    tool,
    staged,
    sha256: sha256Hex(bytes),
    pluginDir: path.join(home, '.vibe', 'plugins', 'tonk-recorder'),
    stdout: r.stdout,
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else out._.push(a);
  }
  return out;
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
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'join' || !args._[1]) {
    process.stderr.write(
      "usage: node join.mjs join '<link>' --agent-name NAME [--home DIR] [--cwd DIR] [--harness vibe] [--wrapper tonk-recorder]\n",
    );
    process.exit(EXIT.ERROR);
  }
  joinSpace({
    link: args._[1],
    agentName: args['agent-name'],
    home: args.home || process.env.HOME,
    cwd: args.cwd || process.cwd(),
    harness: args.harness === true ? 'vibe' : args.harness || 'vibe',
    wrapper: args.wrapper || DEFAULT_WRAPPER,
    tonkBin: process.env.TONK_BIN,
  }).then((res) => {
    if (!res.ok) process.stderr.write(`error: ${res.error}\n`);
    else process.stdout.write(res.stdout ?? `joined and installed tonk-recorder ${res.tool?.version}\n`);
    process.exit(res.code);
  });
}
