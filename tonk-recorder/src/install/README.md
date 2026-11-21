# src/install — B2: install-from-space + verification (SPEC §3.2, §3.3, §8)

| File | Role |
|---|---|
| `tonk.mjs` | Child-process wrapper around the `tonk` CLI. Binary selectable via `TONK_BIN` (may be a full spec like `node /path/stub.mjs`); default `tonk`. Sets `TONK_NO_SYNC=1` on writes unless `noSync:false` (§6.4). Exit codes: 0 ok · 1 error · 2 sha256 mismatch · 3 untrusted publisher · 4 no tool record. |
| `verify.mjs` | sha256 helpers; `latestToolRecord` (max `at`, ties by version); tolerant field getters for `tool` / `trusted-publisher` rows of `tonk query … --json`; `isTrustedPublisher`. |
| `join.mjs` | The join flow (SPEC §3.2): `tonk join` → latest `tool` record → publisher ∈ `trusted-publisher` → `tonk blob cat` → sha256 verify (refuse on mismatch) → stage `~/.tonk/tools/<wrapper>/<version>/tool.mjs` → `node tool.mjs install --harness vibe --expect-sha256 … --version …` (composes H1). Library `joinSpace(opts)` + CLI. The invite link is only ever passed to `tonk join` as argv — never written to any file (SPEC §8); errors redact it. |
| `bootstrap.mjs` | The no-wrapper path (SPEC §3.3): `bootstrapBlock()` generates the AGENTS.md block (verbatim §3.3 shape, no links); `parseBootstrapBlock()` extracts it from `tonk space agents get` output; `runBootstrap()` runs the steps programmatically. |
| `pack.mjs` | Builds the single self-contained `tool.mjs` from `adapters/vibe/tool-side.mjs` + `instructions/decisions.md`. |
| `tool.mjs` | GENERATED — do not edit by hand; rerun `node src/install/pack.mjs`. |

## Integration points (deps not on master yet)

- W0 `contracts/records.md` / `contracts/layout.md`: exact `tool` /
  `trusted-publisher` field spelling and install layout. Coded to SPEC §5.4/§8
  + the verified 0.8.0 `query --json` shape (tolerant getters in verify.mjs).
- B0 wrapper: `<wrapper> join` should delegate to `joinSpace()`; the npm
  package pins `@tonk/cli` (SPEC §2/§7.4) — B0 owns `package.json`.
- B1 publish: embeds `bootstrapBlock()` output into the space AGENTS.md.
- R3 hook runtime: the shipped tool.mjs packs it as
  `globalThis.__TONK_HOOK_RUNTIME__ = { run }`; until then `hook <event>`
  fails open (exit 0).
- L1 (`tonk log`/`restore`, PR #1146): not needed by anything here; DEV-only
  mentions live in `instructions/decisions.md`.

## Tests (offline, fake HOME, stub `tonk` via TONK_BIN)

```sh
node --test 'tests/h1/*.test.mjs' 'tests/r4/*.test.mjs' 'tests/b2/*.test.mjs'
# optional, needs a real tonk 0.8.0 on disk (still offline: local --site space):
TONK_REAL_BIN="$(which tonk)" node --test 'tests/r4/real-tonk.test.mjs'
```
