# contracts/cli-checks.md — verified against installed tonk 0.8.0 (W0)

All checks run **fully offline** with a fake `HOME` and a local-only space
(`tonk space new lab --site <path>`), `DO_NOT_TRACK=1`, no network. tonk
0.8.0 at `/Users/goblin/.nvm/versions/node/v22.22.3/bin/tonk`. Anything from
PR #1146 (`feat/tonk-log`) is marked **DEV** and is ABSENT in 0.8.0 —
consumers build against `fixtures/tonk-log/*.json`.

## Verdict table

| Check | Result on 0.8.0 | Notes |
|---|---|---|
| `tonk eval --no-sync` | ✅ EXISTS | flag on `eval`, `assert`, `concept add`, `blob add` |
| `TONK_NO_SYNC=1` env | ✅ EXISTS | same effect, all write verbs |
| `tonk blob add` / `blob cat` round-trip | ✅ WORKS | **deviation:** `blob add` prints `asset:<hash>`, not `blob:<hash>`; `blob cat` accepts BOTH `blob:<hash>` and `asset:<hash>` — writer may store either spelling; use `blob:<hash>` per SPEC §5.1 |
| `tonk blob add --json` | ❌ | `--json` is only on the `blob` group for listing; `add` rejects it. Parse the `asset:<hash>` line from stdout |
| binding resolution from a subdirectory | ✅ WORKS | `tonk space new` binds the dir; from any descendant, `tonk status` reports `selected via: directory <ancestor>` |
| binding precedence | ✅ `--space` > `TONK_SPACE` > dir binding | `TONK_SPACE=lab tonk status` in an unbound dir works (`selected via: env`) |
| unbound directory | ⚠️ exit **4**, `error: no space active for this directory` | hooks must treat exit 4 + this message as "no binding → no-op" (SPEC §6.1) |
| binding registry | ✅ `~/Library/Application Support/tonk/spaces.json` | `{"spaces": {name: {site}}, "bindings": {absDir: name}}` |
| one `eval` = one revision | ✅ | each committing eval prints `revision-before` / `revision-after` DIDs; no-op re-assert leaves the hash unchanged |
| re-assert identical body | ✅ no-op | same `revision-after`; safe under retry |
| claim author from signed history | ✅ at revision level | `tonk eval --json` envelope: `revision_before`/`revision_after` = `{branch, issuer, tree[], edition, region, count, signature[]}` — **`issuer` is the author DID**. Per-claim `tree/entry` has an `origin` operand but needs raw tree navigation; use the envelope |
| concurrent `eval --no-sync` on one local space | ⚠️ **COLLIDE** | 8 parallel writers → 6 failed with exit **4**: `Lock error: Concurrent write in progress (lock <site>/main/memory/branch/main/revision.lock held)`. Retry succeeds; the failed write commits nothing |
| failed / timed-out push leaves local records intact | ✅ | dead upstream (`http://127.0.0.1:9/…`): `tonk push` exits non-zero, `tonk query` still returns everything |
| plain `eval` (no `--no-sync`) with dead upstream | ⚠️ warns but commits | exit 0, local revision saved, `warning: local eval was saved, but auto-sync push failed … do not repeat the eval … retry only remote delivery with tonk push`. Still: per-turn path MUST use `--no-sync`/`TONK_NO_SYNC=1` to avoid network latency on every turn (SPEC §6.4) |
| `tonk pull` with dead upstream | ❌ hard error, non-zero | local records intact; checkpoint treats as fail-soft |
| `tonk query <concept> --json` | ✅ JSON array | keys = field names verbatim (dash-case); many-valued (`pick: :all`) fields return **repeated rows, same `this`**; `--where field=value` is exact text/boolean equality, repeatable AND |
| `tonk status --json` | ✅ | `schemaVersion: "tonk.status.v3"`, `sync: {state, hash, fetched}`, `space: {name, site, selectedVia, branch}` |
| `tonk log`, `tonk restore`, `tonk switch` | ❌ **DEV** (PR #1146) | absent in 0.8.0; build consumers against `fixtures/tonk-log/*.json`; binary selectable via `TONK_BIN` |
| `tonk blob list` | ❌ absent in 0.8.0 | only `blob add` / `blob cat` |
| exit codes | 0 = ok; **4** = lock error or no active space | other non-zero = command failure |

## CONTRACT for writers (R2) — from the concurrency finding

tonk's local space serialises writers with `revision.lock` and **rejects**
a concurrent writer (exit 4, nothing committed). Therefore every recorder
write must:

1. take its own lock first — `flock`-style lock on
   `$DATA_ROOT/locks/<space>.lock` (see `contracts/layout.md` §4);
2. run `tonk eval --no-sync` (and `TONK_NO_SYNC=1` in the child env) while
   holding it;
3. on exit 4 / `Lock error` from tonk, retry with short backoff
   (≤ 3 attempts), then give up **without failing the hook** (fail-open,
   `contracts/hooks.md`);
4. before writing a `change`, query by `session` + `turn` — a repeat write
   is a no-op (§6.4 idempotency).

## Checkpoint sync (SPEC §6.5) — what the CLI gives us

- `tonk pull` / `tonk push` are manual and independent; wrap each in a
  hard timeout (default 20 s, e.g. child-process `timeout`); on timeout or
  non-zero exit → fail-soft, return normally (records are already local).
- random 0–3 s delay before `push` (swarm de-synchronisation).
- moved head: tonk's auto-sync merges both sides' facts and retries; with
  manual pull/push the pull performs the merge. Records are add-only, so
  merges never conflict in content.

## `eval --json` envelope shape (used by R5 fixtures and the author check)

```json
{
  "revision_before": { "branch": "did:key:…", "issuer": "did:key:…",
    "tree": [/* bytes */], "edition": 9, "region": true, "count": 10,
    "signature": [/* bytes */] },
  "revision_after":  { "…": "same shape" },
  "commits": { "claims": 6, "entities": { "change": "concept:…" } }
}
```

## DEV build — `~/.local/bin/tonk-dev` (PR #1146, L1) — VERIFIED 2026-11-21

The dev CLI is published on the GitHub dev channel and installed at
`~/.local/bin/tonk-dev`. It reports `tonk 0.6.16-rc.1`. **npm `next`
(0.9.0-rc.1) does NOT include log/restore — do not rely on it.** Use
`TONK_BIN=~/.local/bin/tonk-dev` for dev-build consumers. Verified offline:

- `tonk log [CONCEPT] [ENTITY] [--revision <edition>@<origin>] [--limit N]
  [--json]` — **positional concept, not a subcommand** (`tonk log change`
  works; there is no `log change` subcommand). `--limit` defaults to 20.
  `--json` → `{"schemaVersion": "tonk.log.v1", "rows": [{"version":
  "<edition>@<origin-b58>", "edition", "issuer", "authority", "parents":
  ["<version>"]}]}`, newest first. **One eval = one revision** (edition
  increments 1:1; genesis `0@<origin>`). Claim author = `issuer` (and
  `authority` = the space DID).
- `tonk log change --json` / `tonk log decision --json` →
  `{"schemaVersion": "tonk.log-changes.v1", "rows": [{"version", "edition",
  "change": "assert"|"retract", "entity", "attribute": "tonk.recorder.…",
  "value", "supersedes": []}]}` — **one row per recorded claim**, grouped by
  revision, newest first. Verified shapes in `fixtures/tonk-log/*.json`.
- `tonk restore --revision <edition>@<origin>|#<treehash> [--dry-run]
  [--json]` → new local branch `restore-<edition>-<hash>`, **no upstream**,
  `main` preserved; `tonk branch` lists, `tonk switch main` returns. Query on
  the restored branch shows the point-in-time state (verified: revision 3
  shows exactly the changes recorded up to edition 3).
- `tonk pull` / `tonk push` on a restored branch → error "branch '…' has no
  upstream configured", non-zero exit — matches §7.2 (never attach an
  upstream to a restored branch).
- **Which revisions a second device can restore after pull (§7.2 limit),
  reproduced offline:** copy the site, wipe `main/memory/tonk/revisions`
  (simulating a device that only pulled the log): `tonk log` still lists
  **all** revisions (the log lives in the branch's own tree and replicates),
  `restore` of the newest head works, but `restore` of an older revision
  fails: `no saved snapshot for revision <v> on this device; this CLI
  retains signed heads as it reads and writes them, but older log entries
  alone do not contain the tree root needed for checkout`. → the §7.3 fold
  over `tonk log` is the dependable cross-device route.

## In npm 0.8.0 these are absent (DEV-only, PR #1146)

0.8.0 has NO `tonk log`, `tonk restore`, `tonk switch`, `tonk branch`. The
wrapper pins the dev build that includes them (SPEC §7.4); `TONK_BIN`
selects it. R5 builds against `fixtures/tonk-log/*.json` (shapes now
VERIFIED against tonk-dev — see the section above).

## Reproduction (offline)

```sh
export FAKE=$(mktemp -d) HOME=$FAKE/home DO_NOT_TRACK=1
mkdir -p $FAKE/proj/sub && cd $FAKE/proj
tonk telemetry off
tonk space new lab --site $FAKE/site          # local-only, no network
cd $FAKE/proj/sub && tonk status               # resolves via ancestor binding
tonk eval --no-sync schema.notation             # define concepts (packs/recorder.notation)
TONK_NO_SYNC=1 tonk eval -c 'change!: {…}'     # local-only write
tonk query change --where 'turn=turn-1' --json # read back
# concurrency: 8× parallel `tonk eval --no-sync -c …` → 6× exit 4 "revision.lock held"
# dead upstream: tonk remote add dead http://127.0.0.1:9/x && tonk remote set-upstream dead
#   → tonk push fails, records intact; plain eval warns but commits locally
```
