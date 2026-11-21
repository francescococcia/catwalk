# Adding decisions by hand — Tonk recorder

Your **changes** are recorded automatically by the harness hooks — one
`change` record per turn that touched files. **Decisions are different: you
record them on purpose**, with plain `tonk` commands, from any project bound
to this space. You need nothing but the `tonk` CLI.

You are reading this text because it is delivered three ways (SPEC §6.7):
in the session-start context the recorder hook adds to every session, in
this space's AGENTS.md under the bootstrap block (`tonk space agents get`),
and on demand (`tonk-recorder instructions`).

## When to record a decision

Record a decision when you made a **choice between real alternatives that
others should follow** — a library, a data shape, a boundary, a convention,
a default. Not routine edits, not mechanical refactors, not "fixed a typo".
If the next agent could reasonably have picked differently, it is a
decision.

## How to record one

One `tonk eval` of a `decision!:` assertion, plus a `decision-status!:`
expression marking it `accepted`, written with `--no-sync` like the hooks do
(see "Sharing" below). Fields (SPEC §5.2):

- `title` — one line
- `chosen` — what was decided
- `why` — the reasoning
- `rejected` — alternatives considered (optional)
- `about` — files, areas, or `change` records it relates to (many-valued: add
  another `decision!:` expression with `this: <anchor>` and one more
  `about:` line, see below)
- `supersedes` — an earlier decision (optional; see "Changing one")
- `by` — your agent name (the `--agent-name` you joined with)
- `at` — timestamp

Filled example — run it as-is in a project bound to a space (notation per
SPEC §5.2, verified against `tonk` 0.8.0 `tonk help notation`; field names
follow the space's structure pack — when `contracts/records.md` lands it is
the authoritative spelling):

```sh
tonk eval --no-sync -c '
decision!: &decision-inline-diff-limit
  title: "Inline diffs up to 64 KB"
  chosen: "change.diff holds inline text up to 64 KB; larger diffs become a blob"
  why: "keeps the change log readable for a typical turn without a blob fetch"
  rejected: "always store the diff as a blob"
  about: "SPEC.md"
  by: "goblin"
  at: "2026-11-21T12:00:00Z"

decision-status!:
  decision: decision-inline-diff-limit
  status: "accepted"
  by: "goblin"
  at: "2026-11-21T12:00:00Z"
'
```

More `about` values (many-valued field — one extra expression per value,
targeting the same entity by its anchor name):

```sh
tonk eval --no-sync -c '
decision!:
  this: decision-inline-diff-limit
  about: "src/hooks/"
'
```

## How to change a decision

**Never edit or retract one.** A change of mind is a **new** decision with
`supersedes` pointing at the old one (the old record stays; that is what
makes point-in-time queries possible):

```sh
tonk eval --no-sync -c '
decision!: &decision-inline-diff-limit-128
  title: "Inline diffs up to 128 KB"
  chosen: "raise the inline diff limit to 128 KB"
  why: "64 KB truncated diffs mid-file during the swarm check"
  rejected: "keep 64 KB"
  supersedes: decision-inline-diff-limit
  about: "src/hooks/"
  by: "goblin"
  at: "2026-11-22T09:30:00Z"

decision-status!:
  decision: decision-inline-diff-limit-128
  status: "accepted"
  by: "goblin"
  at: "2026-11-22T09:30:00Z"
'
```

The same rule holds for statuses: never overwrite one — assert a new
`decision-status!:` record (`proposed` / `accepted` / `rejected`); the latest
one wins.

## How to read decisions

Accepted decisions as they stand now (local copy — instant, as fresh as the
last checkpoint):

```sh
tonk query decision-status --where 'status=accepted' --json
tonk query decision --json
```

Full history of decisions (every assert and supersede) — `tonk log` is a
**DEV** build feature (tonk PR #1146, not in npm `@tonk/cli` 0.8.0; the
wrapper pins a dev build or `TONK_BIN` points at one):

```sh
tonk log decision --limit 1000              # DEV — every decision, grouped by revision
tonk log decision "<entity>" --limit 1000  # DEV — one decision's history (<entity> = its did:key:… from `tonk query decision --json`)
```

Always pass a large `--limit` (default is 20). Point-in-time answers
(`decisions --at …`, `tonk restore --revision …`) are covered by SPEC §7.

## Sharing (sync)

Write with `--no-sync` like the hooks do (or set `TONK_NO_SYNC=1`): the
record goes straight into your local copy of the space — one revision, no
network. It is shared at the next checkpoint (session start, session end,
every 10 turns) or on demand:

```sh
tonk-recorder sync        # the wrapper's checkpoint: tonk pull && tonk push
```

## Never

- Never edit or retract a decision or a status — add a new record.
- Never write an invite link into a file, a commit, a record, or AGENTS.md.
