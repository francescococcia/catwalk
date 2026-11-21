// tests/w0/contracts.test.mjs — the four W0 contract docs exist and carry
// the load-bearing markers other agents build against. Offline, zero-dep.
// Run: node --test tests/w0/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = (f) => readFileSync(join(ROOT, 'contracts', f), 'utf8');

test('contracts/ has the four W0 documents', () => {
  for (const f of ['records.md', 'hooks.md', 'layout.md', 'cli-checks.md']) {
    assert.ok(existsSync(join(ROOT, 'contracts', f)), `missing contracts/${f}`);
  }
});

test('records.md declares all six concepts + the two lenses + state machines', () => {
  const r = C('records.md');
  for (const c of ['&change', '&change-file', '&decision', '&decision-about', '&decision-status', '&session', '&tool', '&trusted-publisher']) {
    assert.ok(r.includes(`concept!: ${c}`), `records.md missing concept ${c}`);
  }
  for (const sm of [':proposed', ':accepted', ':rejected', 'State machine']) {
    assert.ok(r.includes(sm), `records.md missing ${sm}`);
  }
  assert.ok(r.includes('tonk.recorder.'), 'attribute URI namespace');
});

test('hooks.md maps both harnesses to the four internal events, fail-open', () => {
  const h = C('hooks.md');
  for (const ev of ['session-start', 'pre-agent', 'post-agent', 'session-end']) {
    assert.ok(h.includes(ev), `hooks.md missing ${ev}`);
  }
  for (const cc of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    assert.ok(h.includes(cc), `hooks.md missing Claude event ${cc}`);
  }
  assert.match(h, /fail-?open/i);
  assert.ok(h.includes('additional_context') && h.includes('additionalContext'), 'both harness output keys');
});

test('layout.md pins plugin paths, data root, lock, settings marker', () => {
  const l = C('layout.md');
  for (const p of ['~/.vibe/plugins/tonk-recorder/plugin.json', '~/.vibe/plugins/tonk-recorder/tool.mjs',
    'ai.mistral.vibe/hooks.toml', '~/.tonk/tools/<wrapper>/<version>/tool.mjs', '~/.tonk/recorder/',
    'PLUGIN_DATA', 'PLUGIN_ROOT', '@tonk-recorder', 'locks/<space-name>.lock', 'spaces.json']) {
    assert.ok(l.includes(p), `layout.md missing ${p}`);
  }
});

test('cli-checks.md records the verified 0.8.0 findings incl. DEV marks', () => {
  const c = C('cli-checks.md');
  for (const needle of ['--no-sync', 'TONK_NO_SYNC', 'asset:<hash>', 'revision.lock', 'exit 4',
    'issuer', 'revision_after', 'spaces.json', 'DEV', 'PR #1146', 'flock', 'retry']) {
    assert.ok(c.includes(needle), `cli-checks.md missing ${needle}`);
  }
  assert.match(c, /concurrent/i, 'concurrency finding recorded');
});
