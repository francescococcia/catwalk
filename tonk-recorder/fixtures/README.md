# fixtures/ — W0 sample data (all fake, offline, no real spaces or links)

| Path | What | Consumed by |
|---|---|---|
| `hooks/vibe/*.json` | Sample Vibe stdin payloads for `session_start`, `pre_agent`, `post_agent` (+ a subagent variant with `parent_session_id`), `session_end` — fields per SPEC §4.1 and `contracts/hooks.md` | R3, H1 |
| `hooks/claude/*.json` | Sample Claude Code stdin payloads for `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` (matches H2's `tests/h2/fixtures/stdin/`) | R3, H2 |
| `diffs/normal.diff` | Small git diff: added / modified / deleted / renamed files | R1, R2 |
| `diffs/big-1k-line.diff` | 1000 added lines, 110,054 bytes > 64 KB → exercises the `blob add` path (`diff-blob`) | R1, R2 |
| `diffs/secret.diff` | Diff containing fake credentials (`sk-FAKE…`, `AKIAIOSFODNN7EXAMPLE`, `password=…`, a fake `PRIVATE KEY` block) → secret scan sets `redacted: true` | R1, R2 |
| `records/*.json` | Sample records in the camelCase JSON mirror (mapping in `contracts/records.md` §"JSON mirror"; shape consumed by `views/lib/records.mjs`) | S2, R5 |
| `records/*.notation` | The same records as tonk notation, evaluable after `packs/recorder.notation` loads | S1, R2, R4 |
| `tonk-log/*.json` | VERIFIED shapes for `tonk log --json` (`tonk.log.v1`) and `tonk log <concept> --json` (`tonk.log-changes.v1`) from the dev build `~/.local/bin/tonk-dev` (PR #1146; absent in npm 0.8.0) | R5, S2 |

Rules: no invite links, no real spaces, no real secrets anywhere in this
directory (SPEC §8). All timestamps are fake. All DIDs/hashes are fake.
