// tests/h1/pack-fresh.test.mjs — the committed src/install/tool.mjs is exactly
// what src/install/pack.mjs produces from the current sources (no drift).
import test from 'node:test';
import assert from 'node:assert/strict';
import { read, TOOL_MJS } from './testkit.mjs';
import { packToolMjs } from '../../src/install/pack.mjs';

test('src/install/tool.mjs is up to date with its sources', () => {
  assert.equal(read(TOOL_MJS), packToolMjs());
});
