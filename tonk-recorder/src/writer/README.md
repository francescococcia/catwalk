# src/writer/ — R2: the record writer

`tool.mjs` is the single self-contained writer module (zero-dependency,
Node ESM). The hook runtime (R3) imports it; it is also a small CLI:

```sh
node tool.mjs write-change <record.json|->   # one change record → one tonk eval
node tool.mjs sync                            # checkpoint sync now (SPEC §6.5)
node tool.mjs has-turn <session> <turn>       # idempotency probe (exit 0 = exists)
node tool.mjs query <concept> [field=value…]  # read the local copy as JSON
```

Env: `TONK_BIN` selects the tonk binary (default `tonk`; use the dev build
for log/restore consumers), `DATA_ROOT` overrides the state dir (default
`~/.tonk/recorder`, or `$PLUGIN_DATA` is expected to be set by R3's caller —
see contracts/layout.md §4).

Behaviour (contracts in `contracts/`):

- **One `tonk eval --no-sync` per turn** with `TONK_NO_SYNC=1` in the child
  env (SPEC §6.4). Notation per `contracts/records.md`, single-document
  pattern: the change asserts with `this: ?c` and every `change-file` lens
  row binds `change: ?c` — one revision per turn.
- **Diff split** (SPEC §11.2): ≤ 64 KB inline as `diff:`; larger →
  `tonk blob add --no-sync` and the record references `blob:<hash>` in
  `diff-blob:` (the CLI prints `asset:<hash>`; both spellings read back via
  `tonk blob cat` — cli-checks.md).
- **Idempotent by turn id**: `tonk query change --where session=… --where
  turn=…` before writing; a repeat write is a no-op.
- **Writer lock**: all tonk writes run under `$DATA_ROOT/locks/<space>.lock`
  (O_EXCL + stale takeover). tonk's own `revision.lock` rejects concurrent
  writers with exit 4 — verified on 0.8.0 (cli-checks.md); lock errors are
  retried with backoff (≤ 3 attempts), then fail-open.
- **Checkpoint sync** (`checkpointSync`, SPEC §6.5): `tonk pull` then random
  0–3 s delay then `tonk push`, hard timeout 20 s each (configurable),
  fail-soft — never throws, never blocks the turn; local records are
  delivered at the next checkpoint. `shouldCheckpoint(turns, 10)` for the
  every-N-turns trigger.
- **Binding rule** (§6.1): `resolveBinding(cwd)` mirrors tonk's space
  resolution; unbound → `{ bound: false }`, nothing written.

Tests (offline): `node --test 'tests/r2/*.test.mjs'` — notation unit tests,
stub-tonk tests (idempotency, blob split, lock serialization, hanging-push
checkpoint + exactly-once next checkpoint, unbound no-op, lock-error retry),
and a live-tonk test against a fake-HOME local space (skips without a tonk
binary; set `TONK_BIN`).
