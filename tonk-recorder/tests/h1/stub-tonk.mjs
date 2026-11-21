#!/usr/bin/env node
// tests/h1/stub-tonk.mjs — offline stub for the `tonk` CLI (TONK_BIN).
// Shared by tests/h1*, tests/r4*, tests/b2*.
//
// Behaviour is driven by two env vars:
//   TONK_STUB_STATE — path to a JSON file, mutated in place:
//     { blobs: {ref: absFilePath}, tool: [records], trusted: [dids],
//       agents: "markdown", evals: [docs], anchors: {name: {...}},
//       decisions: [rows], statuses: [rows] }
//   TONK_STUB_CALLS — path to a JSONL file; every invocation appends {argv}.
//
// Supported: --version, help, join, query <c> [--where k=v] [--json],
// eval [-c doc | - | file] [--no-sync], log decision [--limit N] (DEV stub),
// blob add <file> / blob cat <ref>, space agents get|set, pull, push, status,
// identity. Everything else exits 1. No network, ever.

import fs from 'node:fs';
import crypto from 'node:crypto';

const statePath = process.env.TONK_STUB_STATE;
const callsPath = process.env.TONK_STUB_CALLS;

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { blobs: {}, tool: [], trusted: [], agents: '', evals: [], anchors: {}, decisions: [], statuses: [] };
  }
}
function save(s) {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}
if (callsPath) fs.appendFileSync(callsPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\n');

const s = load();
const args = process.argv.slice(2);
const cmd = args[0] ?? '';

function out(x) {
  process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n');
}
function fail(msg, code = 1) {
  process.stderr.write(`stub-tonk: ${msg}\n`);
  process.exit(code);
}
function flags(list) {
  // returns {values: {k: [v]}, bools: Set, rest: []}
  const values = {};
  const bools = new Set();
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) (values[a.slice(2, eq)] ??= []).push(a.slice(eq + 1));
      else {
        const next = list[i + 1];
        if (next === undefined || next.startsWith('--')) bools.add(a.slice(2));
        else { (values[a.slice(2)] ??= []).push(next); i++; }
      }
    } else rest.push(a);
  }
  return { values, bools, rest };
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// --- eval doc validation (minimal, mimics tonk 0.8.0 behaviour we rely on) ---
function evalDoc(doc) {
  if (doc.includes('..: _')) fail('retraction refused: records are add-only (stub)');
  const headRe = /^([a-z][a-z0-9-]*)!:\s*(?:&([a-z0-9-]+))?\s*$/gm;
  let m;
  const heads = [];
  while ((m = headRe.exec(doc))) heads.push({ concept: m[1], anchor: m[2], index: m.index, end: headRe.lastIndex });
  if (!heads.length) fail('no assertion head (`concept!:`) found');
  let n = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const block = doc.slice(h.end, i + 1 < heads.length ? heads[i + 1].index : undefined);
    if (h.concept === 'decision') {
      const isUpdate = /^\s*this:/m.test(block);
      if (!isUpdate) {
        for (const req of ['title', 'chosen', 'why', 'by', 'at']) {
          if (!new RegExp(`^\\s*${req}:`, 'm').test(block)) fail(`decision assertion missing field '${req}'`);
        }
      }
      const sup = block.match(/^\s*supersedes:\s*([a-z0-9-]+)\s*$/m);
      if (sup && !s.anchors[sup[1]] && !sup[1].startsWith('did:')) {
        fail(`unresolved symbol in supersedes: ${sup[1]} (stub name table)`);
      }
      if (isUpdate) {
        // partial update on an existing entity: merge `about` if the target is known
        const t = block.match(/^\s*this:\s*([a-z0-9-]+)\s*$/m)?.[1];
        const target = t && s.anchors[t] ? s.anchors[t].this : null;
        const about = block.match(/^\s*about:\s*"?([^"\n]+)"?\s*$/m)?.[1];
        if (target && about) {
          const row = s.decisions.find((r) => r.this === target);
          if (row) row.about = about;
        }
      } else {
        const row = { this: `did:key:stub-${++n}` };
        for (const fm of block.matchAll(/^\s*([a-z][a-z0-9-]*):\s*(.+?)\s*$/gm)) {
          let v = fm[2];
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
          row[fm[1]] = v;
        }
        s.decisions.push(row);
        if (h.anchor) s.anchors[h.anchor] = { concept: 'decision', this: row.this, title: row.title };
      }
    } else if (h.concept === 'decision-status') {
      for (const req of ['decision', 'status', 'by', 'at']) {
        if (!new RegExp(`^\\s*${req}:`, 'm').test(block)) fail(`decision-status assertion missing field '${req}'`);
      }
      const row = { this: `did:key:stub-status-${++n}` };
      for (const fm of block.matchAll(/^\s*([a-z][a-z0-9-]*):\s*(.+?)\s*$/gm)) {
        let v = fm[2];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        row[fm[1]] = v;
      }
      const dec = block.match(/^\s*decision:\s*([a-z0-9-]+)\s*$/m);
      if (dec && s.anchors[dec[1]]) row.decision = s.anchors[dec[1]].this;
      s.statuses.push(row);
      if (h.anchor) s.anchors[h.anchor] = { concept: 'decision-status', this: row.this };
    } else if (h.anchor) {
      s.anchors[h.anchor] = { concept: h.concept, this: `did:key:stub-${++n}` };
    }
    s.evals.push(doc);
  }
  save(s);
  out('ok (stub eval)\n');
}

switch (cmd) {
  case '--version':
  case '-V':
    out('tonk 0.8.0-stub\n');
    break;
  case 'help':
    out('stub tonk help\n');
    break;
  case 'join': {
    // args: join [URL] [--agent-name NAME] [--name NAME]
    out('joined (stub)\n');
    break;
  }
  case 'query': {
    const rest = args.slice(1);
    const { values, bools, rest: positional } = flags(rest);
    const concept = positional[0];
    let rows;
    if (concept === 'tool') rows = s.tool ?? [];
    else if (concept === 'trusted-publisher') rows = (s.trusted ?? []).map((d) => ({ identity: d }));
    else if (concept === 'decision') rows = s.decisions ?? [];
    else if (concept === 'decision-status') rows = s.statuses ?? [];
    else rows = [];
    for (const w of values.where ?? []) {
      const eq = w.indexOf('=');
      const k = w.slice(0, eq);
      const v = w.slice(eq + 1);
      rows = rows.filter((r) => String(r[k]) === v);
    }
    if (bools.has('json')) out(rows);
    else out(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    break;
  }
  case 'eval': {
    const rest = args.slice(1);
    let doc;
    const ci = rest.findIndex((a) => a === '-c' || a === '--command' || a.startsWith('--command='));
    if (ci !== -1) {
      if (rest[ci].includes('=')) doc = rest[ci].slice(rest[ci].indexOf('=') + 1);
      else doc = rest[ci + 1];
    } else if (rest.includes('-')) doc = readStdin();
    else {
      const positional = rest.filter((a) => !a.startsWith('-'));
      doc = positional.length ? fs.readFileSync(positional[positional.length - 1], 'utf8') : readStdin();
    }
    evalDoc(doc);
    break;
  }
  case 'log': {
    // DEV stub of tonk log (PR #1146 — not in 0.8.0)
    const sub = args[1];
    if (sub === 'decision') {
      out('(DEV stub of `tonk log` — tonk PR #1146)\n');
      for (const a of Object.entries(s.anchors)) {
        if (a[1].concept === 'decision') out(`# ${a[0]} — ${a[1].title ?? ''}\n`);
      }
    } else out('(DEV stub of `tonk log`)\n');
    break;
  }
  case 'blob': {
    const sub = args[1];
    if (sub === 'add') {
      const file = args[2];
      if (!file || !fs.existsSync(file)) fail(`blob add: no such file ${file}`);
      const bytes = fs.readFileSync(file);
      const ref = 'asset:stub' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      s.blobs[ref] = fs.realpathSync(file);
      save(s);
      out(`${ref}\n  content-type: application/javascript, size: ${bytes.length} bytes\n`);
    } else if (sub === 'cat') {
      const ref = args[2];
      const f = s.blobs?.[ref];
      if (!f) fail(`blob cat: unknown blob ${ref}`);
      process.stdout.write(fs.readFileSync(f));
    } else fail(`blob ${sub}: unsupported in stub`);
    break;
  }
  case 'space': {
    const rest = args.slice(1);
    if (rest[0] === 'agents' && rest[1] === 'get') out(s.agents ?? '');
    else if (rest[0] === 'agents' && rest[1] === 'set') {
      const f = flags(rest.slice(2));
      const positional = f.rest;
      const content = positional.length && positional[0] !== '-' ? fs.readFileSync(positional[0], 'utf8') : readStdin();
      s.agents = content;
      save(s);
      out('revision: #stub\nnext: tonk space agents get\n');
    } else fail(`space ${rest.join(' ')}: unsupported in stub`);
    break;
  }
  case 'pull':
  case 'push':
    out('ok (stub)\n');
    break;
  case 'status':
    out('sync: no-upstream (stub)\n');
    break;
  case 'identity':
    out('device: did:key:stubDevice\naccount: none\n');
    break;
  default:
    fail(`unsupported in stub: ${args.join(' ')}`);
}
