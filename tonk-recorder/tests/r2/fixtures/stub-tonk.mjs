#!/usr/bin/env node
// tests/r2/fixtures/stub-tonk.mjs — a fake `tonk` binary for offline R2
// tests. Point TONK_BIN at this file. State lives in $STUB_STATE (a dir):
//   evals.jsonl   — one line per committed `eval` document
//   blobs/<hash>  — blob bytes from `blob add`
//   syncs.log     — one line per pull/push invocation
// Behaviour switches via env:
//   STUB_UNBOUND=1        status/query exit 4 "no space active"
//   STUB_HANG=pull,push   those subcommands sleep 60s (writer must time out)
//   STUB_FAIL=pull,push   those subcommands exit 1
//   STUB_EVAL_DELAY=ms    eval sleeps this long (to exercise the lock)
//   STUB_LOCKERR=1        eval fails once with exit 4 "Lock error … revision.lock held"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE = process.env.STUB_STATE || '/tmp/stub-tonk-state';
const HANG = (process.env.STUB_HANG || '').split(',').filter(Boolean);
const FAIL = (process.env.STUB_FAIL || '').split(',').filter(Boolean);
const args = process.argv.slice(2);
const cmd = args[0];

fs.mkdirSync(STATE, { recursive: true });
const log = (name, line) => fs.appendFileSync(path.join(STATE, name), line + '\n');

const sleep = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* spin */ } };

// record pull/push attempts BEFORE hanging/failing so tests can see them
if (cmd === 'pull' || cmd === 'push') log('syncs.log', cmd);
if (HANG.includes(cmd)) sleep(60_000);
if (FAIL.includes(cmd)) { console.error(`error: stub failure on ${cmd}`); process.exit(1); }

if (cmd === '--version') { console.log('tonk 0.8.0-stub'); process.exit(0); }

if (cmd === 'status') {
  if (process.env.STUB_UNBOUND === '1') {
    console.error('error: no space active for this directory; run `tonk space use <name>`, pass --space, or set TONK_SPACE');
    process.exit(4);
  }
  console.log(JSON.stringify({ schemaVersion: 'tonk.status.v3', space: { name: 'stubspace', site: path.join(STATE, 'site'), branch: 'main', selectedVia: 'directory /stub' }, sync: { state: 'no-upstream', hash: '#stub', fetched: true } }));
  process.exit(0);
}

if (cmd === 'query' && args[1] === 'change') {
  if (process.env.STUB_UNBOUND === '1') { console.error('error: no space active for this directory'); process.exit(4); }
  const wheres = [];
  for (let i = 2; i < args.length; i++) if (args[i] === '--where') wheres.push(args[++i]);
  const want = Object.fromEntries(wheres.map((w) => w.split('=')));
  let docs = [];
  try { docs = fs.readFileSync(path.join(STATE, 'evals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* empty */ }
  const rows = docs
    .map((d) => {
      const get = (f) => { const m = new RegExp(`^  ${f}: "((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(d); return m ? JSON.parse(`"${m[1]}"`) : undefined; };
      return { this: 'did:key:stub' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 8), session: get('session'), turn: get('turn'), doc: d };
    })
    .filter((r) => (!want.session || r.session === want.session) && (!want.turn || r.turn === want.turn))
    .map(({ this: t, session, turn }) => ({ this: t, session, turn }));
  console.log(JSON.stringify(rows));
  process.exit(0);
}

if (cmd === 'eval') {
  if (process.env.STUB_UNBOUND === '1') { console.error('error: no space active for this directory'); process.exit(4); }
  const doc = args.includes('-c') ? args[args.indexOf('-c') + 1] : fs.readFileSync(0, 'utf8');
  if (process.env.STUB_LOCKERR === '1' && !fs.existsSync(path.join(STATE, 'lockerr-used'))) {
    fs.writeFileSync(path.join(STATE, 'lockerr-used'), '1');
    console.error('commit failed: Failed to publish new revision: Storage error: Lock error: Concurrent write in progress (lock …/revision.lock held)');
    process.exit(4);
  }
  const d = Number(process.env.STUB_EVAL_DELAY || 0);
  if (d > 0) sleep(d);
  log('evals.jsonl', JSON.stringify(doc));
  const n = fs.readFileSync(path.join(STATE, 'evals.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
  console.log(`revision-before: did:key:before${n}`);
  console.log(`revision-after: did:key:after${n}`);
  console.log(`claims: 6`);
  process.exit(0);
}

if (cmd === 'blob' && args[1] === 'add') {
  const file = args[2]; // blob add <file> [--no-sync] — the file is the first arg after 'add'
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(path.join(STATE, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(STATE, 'blobs', hash), bytes);
  console.log(`asset:${hash}`);
  console.log(`  content-type: application/octet-stream, size: ${bytes.length} bytes`);
  process.exit(0);
}

if (cmd === 'blob' && args[1] === 'cat') {
  const ref = args[2].replace(/^(blob|asset):/, '');
  // synchronous write: process.stdout.write to a pipe + immediate exit
  // truncates large payloads at the 64 KB pipe buffer
  fs.writeSync(1, fs.readFileSync(path.join(STATE, 'blobs', ref)));
  process.exit(0);
}

if (cmd === 'pull' || cmd === 'push') {
  console.log(`${cmd}: stub ok`);
  process.exit(0);
}

console.error(`stub-tonk: unknown command ${cmd} ${args.slice(1).join(' ')}`);
process.exit(2);
