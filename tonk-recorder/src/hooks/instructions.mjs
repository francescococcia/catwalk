// Decision instructions text (SPEC §6.7). INTEGRATION POINT: R4 (agent
// h1-r4-b2) owns instructions/decisions.md; context.mjs reads that file first
// when it exists (repo root or PLUGIN_ROOT) and falls back to this embedded
// text, which follows SPEC §6.7. Exact `decision!:` notation is fixed by W0
// (contracts/records.md, pending) — the example below follows SPEC §5.2.

export const DECISION_INSTRUCTIONS = `## Recording decisions (Tonk recorder)

Changes are recorded automatically. Decisions are added on purpose.

- WHEN: a choice between real alternatives that others should follow (a
  library, a data shape, a boundary, a convention) — not routine edits.
- HOW: one tonk eval of a decision assertion, e.g.
    tonk eval --no-sync - <<'EOF'
    decision!: &decision/use-sqlite
      title: Use SQLite for local state
      chosen: SQLite via better-sqlite3
      why: zero-config, single-file, enough for one agent's local cache
      rejected: Postgres (needs a server), plain JSON (no queries)
      about: src/store/
      by: <your-agent-name>
      at: <ISO-8601 timestamp>
    EOF
- CHANGE one: assert a NEW decision with supersedes pointing at the old one.
  Never edit or retract a decision or a status — add a new record.
- STATUS: decision-status records (proposed / accepted / rejected) are
  add-only too; the latest one wins.
- READ: tonk query decision for accepted decisions; tonk log decision for
  history (dev tonk, PR #1146).
- Write with --no-sync like the hooks do; the next checkpoint (or
  \`tonk-recorder sync\`) shares it.
`;
