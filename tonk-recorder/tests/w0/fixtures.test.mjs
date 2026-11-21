// tests/w0/fixtures.test.mjs — validate fixtures/ against contracts/ (W0).
// Fully offline, zero-dependency. Run: node --test tests/w0/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = join(ROOT, 'fixtures');

const readJson = (p) => JSON.parse(readFileSync(join(FX, p), 'utf8'));
const readText = (p) => readFileSync(join(FX, p), 'utf8');

// --- hook stdin fixtures -------------------------------------------------

test('vibe hook fixtures carry the SPEC §4.1 payload facts', () => {
  const base = { hook_event_name: '', session_id: '', transcript_path: '', cwd: '' };
  for (const f of readdirSync(join(FX, 'hooks/vibe'))) {
    const p = readJson(`hooks/vibe/${f}`);
    for (const k of Object.keys(base)) assert.ok(k in p, `${f}: missing ${k}`);
    assert.match(p.cwd, /^\/tmp\/fake-home\//, `${f}: cwd must be fake`);
  }
  const pre = readJson('hooks/vibe/pre-agent.json');
  assert.ok(pre.prompt && pre.turn_id, 'pre-agent needs prompt + turn_id');
  const post = readJson('hooks/vibe/post-agent.json');
  assert.ok(post.agent_name && post.turn_id && 'response_text' in post, 'post-agent needs agent_name/turn_id/response_text');
  const sub = readJson('hooks/vibe/post-agent-subagent.json');
  assert.ok(sub.parent_session_id, 'subagent fixture needs parent_session_id');
});

test('claude hook fixtures match the four events and H2 stdin shape', () => {
  const dir = readdirSync(join(FX, 'hooks/claude')).map((f) => f.replace('.json', ''));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.ok(dir.includes(ev), `missing ${ev}.json`);
  }
  const ups = readJson('hooks/claude/UserPromptSubmit.json');
  assert.ok(ups.prompt, 'UserPromptSubmit carries prompt');
  assert.ok(!('turn_id' in ups), 'Claude payloads have no turn_id (adapter synthesises)');
  const stop = readJson('hooks/claude/Stop.json');
  assert.ok('stop_hook_active' in stop);
});

// --- diff fixtures -------------------------------------------------------

test('normal.diff has added/modified/deleted/renamed', () => {
  const d = readText('diffs/normal.diff');
  for (const marker of ['new file mode', 'deleted file mode', 'rename from', 'rename to', 'similarity index']) {
    assert.ok(d.includes(marker), `normal.diff missing ${marker}`);
  }
});

test('big-1k-line.diff has 1000 added lines and exceeds the 64 KB blob threshold', () => {
  const d = readText('diffs/big-1k-line.diff');
  const added = d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  assert.equal(added.length, 1000);
  assert.ok(statSync(join(FX, 'diffs/big-1k-line.diff')).size > 64 * 1024, 'must exceed 64 KB');
});

test('secret.diff contains the fake credential patterns the scan must catch', () => {
  const d = readText('diffs/secret.diff');
  for (const pat of [/sk-[A-Za-z0-9]{20,}/, /AKIA[A-Z0-9]{16}/, /-----BEGIN PRIVATE KEY-----/, /password\s*=/i, /ghp_[A-Za-z0-9]{20,}/]) {
    assert.match(d, pat, `secret.diff missing pattern ${pat}`);
  }
  // and they are all fake
  assert.ok(d.includes('FAKE') || d.includes('EXAMPLE'), 'secrets must be fake');
});

// --- record fixtures -----------------------------------------------------

const MIRROR_FIELDS = {
  'change-001.json': ['id', 'session', 'turn', 'agent', 'harness', 'prompt', 'project', 'branch', 'base', 'head', 'commit', 'files', 'linesAdded', 'linesRemoved', 'diff', 'diffBlob', 'redacted', 'at'],
  'change-002-secret.json': ['id', 'session', 'turn', 'agent', 'redacted', 'diffBlob', 'at'],
  'decision-001.json': ['title', 'chosen', 'why', 'rejected', 'about', 'supersedes', 'by', 'at'],
  'decision-002-supersedes.json': ['title', 'chosen', 'supersedes', 'by', 'at'],
  'decision-status-001.json': ['decision', 'status', 'by', 'at'],
  'session-001.json': ['id', 'agent', 'harness', 'project', 'started', 'ended', 'changes'],
  'tool-001.json': ['name', 'version', 'blob', 'sha256', 'publisher', 'publishedAt', 'changelog'],
  'trusted-publisher-001.json': ['identity', 'at'],
};

test('record JSON fixtures carry the contract fields (JSON mirror)', () => {
  for (const [file, fields] of Object.entries(MIRROR_FIELDS)) {
    const rec = readJson(`records/${file}`);
    for (const f of fields) assert.ok(f in rec, `${file}: missing ${f}`);
  }
  const ch = readJson('records/change-001.json');
  assert.equal(ch.id, `${ch.session}:${ch.turn}`, 'change id = session:turn');
  for (const f of ch.files) {
    assert.ok(['added', 'modified', 'deleted', 'renamed'].includes(f.status), `bad file status ${f.status}`);
    assert.ok(f.path && Number.isFinite(f.added) && Number.isFinite(f.removed));
  }
  const ch2 = readJson('records/change-002-secret.json');
  assert.equal(ch2.diff, null, 'big diff is not inline');
  assert.match(ch2.diffBlob, /^blob:/, 'big diff referenced as blob:<hash>');
  assert.equal(ch2.redacted, true, 'secret scan flagged');
  const dec2 = readJson('records/decision-002-supersedes.json');
  assert.ok(dec2.supersedes, 'superseding decision must set supersedes');
  const tool = readJson('records/tool-001.json');
  assert.match(tool.sha256, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.match(tool.publisher, /^did:key:/, 'publisher is a DID');
  assert.match(tool.blob, /^blob:/);
});

// notation fixtures must only use concepts/fields declared in records.md
const CONCEPTS = {
  change: ['session', 'turn', 'parent-session', 'agent', 'harness', 'prompt', 'response', 'project', 'branch', 'base', 'head', 'commit', 'lines-added', 'lines-removed', 'diff', 'diff-blob', 'redacted', 'at'],
  'change-file': ['change', 'path', 'status', 'added', 'removed'],
  decision: ['title', 'chosen', 'why', 'rejected', 'supersedes', 'by', 'at'],
  'decision-about': ['decision', 'target'],
  'decision-status': ['decision', 'status', 'by', 'at'],
  session: ['id', 'agent', 'harness', 'project', 'started', 'ended', 'changes'],
  tool: ['name', 'version', 'blob', 'sha256', 'publisher', 'published-at', 'changelog'],
  'trusted-publisher': ['identity', 'at'],
};

test('record notation fixtures use only contract concepts and fields', () => {
  for (const f of readdirSync(join(FX, 'records')).filter((f) => f.endsWith('.notation'))) {
    const doc = readText(`records/${f}`);
    const heads = [...doc.matchAll(/^([a-z][a-z0-9-]*)!?:/gm)].map((m) => m[1]);
    for (const h of heads) {
      assert.ok(h in CONCEPTS, `${f}: unknown concept head ${h}`);
      assert.ok(!['attribute', 'concept', 'name', 'rule'].includes(h), `${f}: schema heads belong in packs/, not record fixtures`);
    }
    const fields = [...doc.matchAll(/^\s{2}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
    for (const fl of fields) {
      const head = [...doc.matchAll(/^([a-z][a-z0-9-]*)!?:/gm)].map((m) => m[1]).pop();
      const known = Object.values(CONCEPTS).some((list) => list.includes(fl)) || ['this', 'when', 'unless', 'assert', 'where'].includes(fl);
      assert.ok(known, `${f}: unknown field ${fl}`);
    }
  }
});

test('tonk-log fixtures have the VERIFIED dev-build (PR #1146) shapes', () => {
  // tonk log --json  →  tonk.log.v1
  const rev = readJson('tonk-log/log-revisions.json');
  assert.equal(rev.schemaVersion, 'tonk.log.v1');
  assert.ok(Array.isArray(rev.rows));
  for (const r of rev.rows) {
    assert.match(r.version, /^\d+@[A-Za-z0-9]+$/, 'version = <edition>@<origin>');
    assert.ok(r.issuer && r.authority && Array.isArray(r.parents) && Number.isInteger(r.edition));
  }
  // tonk log <concept> --json  →  tonk.log-changes.v1, claim-level rows
  for (const f of ['tonk-log/log-change.json', 'tonk-log/log-decision.json']) {
    const lc = readJson(f);
    assert.equal(lc.schemaVersion, 'tonk.log-changes.v1');
    for (const r of lc.rows) {
      assert.match(r.version, /^\d+@/);
      assert.ok(['assert', 'retract'].includes(r.change));
      assert.ok(r.entity && r.attribute && 'value' in r && Array.isArray(r.supersedes));
    }
  }
  const ld = readJson('tonk-log/log-decision.json');
  assert.ok(ld.rows.some((r) => r.attribute === 'tonk.recorder.decision/supersedes'), 'fold needs a supersede case');
  assert.ok(ld.rows.some((r) => r.attribute === 'tonk.recorder.decision-status/status' && r.value === 'accepted:'), 'fold needs a status case');
});

// --- hygiene ---------------------------------------------------------------

test('no fixture contains an invite link or a real-looking secret', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of walk(FX)) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/tonk\.foundation\/join|\/invite\/[A-Za-z0-9]{16,}/.test(text), `${file}: invite link!`);
    assert.ok(!/sk-(?!FAKE)[A-Za-z0-9]{20,}/.test(text), `${file}: real-looking sk- key!`);
    assert.ok(!/AKIA(?!IOSFODNN7EXAMPLE)[A-Z0-9]{16}/.test(text), `${file}: real-looking AKIA key!`);
  }
});
