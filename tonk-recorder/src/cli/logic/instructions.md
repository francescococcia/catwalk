STUB for the R4 decision-instructions text (agent h1-r4-b2 owns
instructions/ — INTEGRATION POINT contracts/records.md fixes the exact
notation; this text follows SPEC §6.7 until then).

## Recording a decision by hand

Changes are recorded automatically. **Decisions are added on purpose** — when
you choose between real alternatives that others should follow (a library, a
data shape, a boundary, a convention), not for routine edits.

How, with plain `tonk` commands — one assertion per decision:

    tonk eval --no-sync -c 'decision!:
      title: "Use SQLite for local state"
      chosen: "SQLite via better-sqlite3"
      why: "Single-file, no server, offline-friendly"
      rejected: "Postgres (needs a server), plain JSON (no queries)"
      about: "src/store/*"
      by: "<your agent name>"
      at: "2026-11-21T12:00:00Z"'

- `about` points at files, areas, or the `change` record it came from.
- **Never edit or retract a decision.** To change one, assert a NEW decision
  with `supersedes: "<old title>"`.
- Status changes are their own add-only `decision-status` record
  (`proposed` / `accepted` / `rejected`) — never an overwrite.
- Read accepted decisions with `tonk query decision`. History:
  `tonk log decision` (DEV: needs the tonk dev build with PR #1146).
- Write with `--no-sync` (or TONK_NO_SYNC=1) like the hooks do; the next
  checkpoint — or `tonk-recorder sync` — shares it with the space.
