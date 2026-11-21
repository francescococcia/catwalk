// tests/r2/notation.test.mjs — pure unit tests for the notation builder and
// diff split. Offline, no tonk. Run: node --test 'tests/r2/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildChangeNotation, splitDiff, INLINE_DIFF_LIMIT, shouldCheckpoint } from '../../src/writer/tool.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const change001 = JSON.parse(readFileSync(join(ROOT, 'fixtures/records/change-001.json'), 'utf8'));

test('buildChangeNotation: required fields, keyword values, lens rows, this:?c binding', () => {
  const doc = buildChangeNotation(change001, { diff: change001.diff });
  assert.match(doc, /^change!:\n {2}this: \?c\n/m);
  for (const f of ['session', 'turn', 'agent', 'harness: :vibe', 'prompt', 'project', 'branch', 'base', 'head', 'commit', 'lines-added: 150', 'lines-removed: 6', 'redacted: false', `at: "2026-11-21T12:00:00Z"`]) {
    assert.ok(doc.includes(f), `doc missing ${f}`);
  }
  // lens rows bound to the same entity
  const lensRows = doc.match(/^change-file!:\n {2}change: \?c\n {2}path: /gm) || [];
  assert.equal(lensRows.length, 4, 'one change-file row per file');
  assert.ok(doc.includes('status: :added') && doc.includes('status: :renamed'));
  // strings are quoted/escaped (prompt contains a newline)
  assert.ok(doc.includes('prompt: "Add the recorder hook runtime\\n\\nAlso wire'), 'newline escaped in double-quoted scalar');
  assert.ok(!doc.includes('diff-blob:'), 'inline diff → no diff-blob');
});

test('buildChangeNotation: blob reference instead of inline diff', () => {
  const rec = { ...change001, turn: 'turn-2', diff: null, diffBlob: 'blob:abc123', redacted: true };
  const doc = buildChangeNotation(rec, { diff: null, diffBlob: 'blob:abc123' });
  assert.ok(doc.includes('diff-blob: blob:abc123'));
  assert.ok(!/\n {2}diff:/.test(doc), 'no inline diff when blobbed');
  assert.ok(doc.includes('redacted: true'));
});

test('buildChangeNotation: rejects missing/invalid input', () => {
  assert.throws(() => buildChangeNotation({ ...change001, turn: undefined }, { diff: 'x' }), /missing required field "turn"/);
  assert.throws(() => buildChangeNotation(change001, { diff: null, diffBlob: null }), /needs diff/);
  assert.throws(() => buildChangeNotation(change001, { diff: 'x', diffBlob: 'blob:a' }), /pick one/);
  assert.throws(() => buildChangeNotation({ ...change001, files: [] }, { diff: 'x' }), /files/);
});

test('splitDiff: 64 KB threshold (§11.2)', () => {
  assert.equal(splitDiff('x'.repeat(INLINE_DIFF_LIMIT)).inline, true, 'exactly 64 KB is inline');
  assert.equal(splitDiff('x'.repeat(INLINE_DIFF_LIMIT + 1)).inline, false, 'above 64 KB → blob');
  const big = readFileSync(join(ROOT, 'fixtures/diffs/big-1k-line.diff'), 'utf8');
  assert.equal(splitDiff(big).inline, false, '1k-line fixture goes to blob');
  assert.equal(splitDiff(readFileSync(join(ROOT, 'fixtures/diffs/normal.diff'), 'utf8')).inline, true);
});

test('shouldCheckpoint: every N turns', () => {
  assert.equal(shouldCheckpoint(9, 10), false);
  assert.equal(shouldCheckpoint(10, 10), true);
  assert.equal(shouldCheckpoint(20, 10), true);
  assert.equal(shouldCheckpoint(0, 10), false);
});
