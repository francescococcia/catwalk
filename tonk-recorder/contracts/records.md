# contracts/records.md — the record contracts (W0)

Final field names and types for the concepts of SPEC §5, written in **tonk
0.8.0 notation** (verified against the installed CLI — see
`contracts/cli-checks.md`). Consumers: S1 loads these as
`packs/recorder.notation`; R2 writes them; S2/R5 read them.

Notation facts this contract relies on (all verified on 0.8.0):

- A **concept** is `concept!: &name` with `with:` (required fields) and
  `maybe:` (optional fields); each value is an attribute reference.
- An **attribute** is `attribute!: &anchor` with `description:`,
  `the: <domain/name>` (the relation URI, unquoted), `as: <type>`, and for
  many-valued relations `pick: :all`.
- Types (built-in anchors): `text`, `boolean`, `natural`, `integer`,
  `float`, `bytes`, `entity`, `symbol`, `record`. There is **no time type** —
  timestamps are `text` in ISO 8601 UTC (`"2026-11-21T12:00:00Z"`).
- A **keyword** value is written `:word` and reads back as `word:`.
- An **entity** value is a URI: `did:key:…`, `id:name`, `blob:<hash>` /
  `asset:<hash>` (both spellings accepted by `tonk blob cat`), or a bare
  symbol resolved through the name table.
- Strings **must be quoted** (`prompt: "fix the bug"`); a bare lowercase
  token is a symbol and resolves or fails. Field names are symbols:
  lowercase, digits, `-`, `.`, `+`, at most one `/` — hence dash-case
  (`lines-added`, not `linesAdded`).
- Assertion: `concept!:` with a body; `this:` selects the entity (omitted →
  content-addressed). Re-asserting an identical body is a no-op (same
  revision); records are add-only.
- **Single-document write pattern (verified on 0.8.0):** a query expression
  does NOT see assertions made earlier in the same document, so lens rows
  must be bound with `this: ?var` on the owner assertion, not with a query
  join:
  ```yaml
  change!:
    this: ?c
    session: "s1"  turn: "t1"  …
  change-file!:
    change: ?c
    path: "src/a.ts"  status: :added  added: 3  removed: 0
  ```
  One `tonk eval` then writes the record and all its lens rows (one
  revision per turn, SPEC §6.4). Cross-document references (e.g.
  `supersedes`) use an anchor name (`&decision-x` → `id:decision-x`) or a
  `did:key:…` URI.

## Conventions

- **Record id** (JSON mirror only): a `change` is identified by
  `"<session>:<turn>"` (e.g. `"vibe-session-aaa:turn-1"`). In notation there
  is no id field; idempotency is by querying `turn` + `session` (SPEC §6.4).
- **Many-valued fields go through lens concepts** (§5): one instance of the
  lens per value, pointing back at the owning entity. Do NOT use
  `pick: :all` on the owner (separate assertions mint separate entities
  unless `this:` is bound — verified; lenses are the reliable shape).
- **Timestamps**: `at`, `started`, `ended`, `published-at` are `text`,
  ISO 8601 UTC.
- **The writer's Tonk identity is not a field** (§5.1); tonk attaches it.
  It is readable from the signed revision envelope as
  `revision_after.issuer` (`tonk eval --json`) — see cli-checks.md.

## JSON mirror mapping

`fixtures/records/*.json` and S2's record files use a camelCase JSON mirror
of the notation records (the shape `views/lib/records.mjs` normalises).
Mapping: dash-case notation field → camelCase JSON key
(`lines-added`→`linesAdded`, `diff-blob`→`diffBlob`, `parent-session`→
`parentSession`, `published-at`→`publishedAt`); lens instances flatten into
an array on the owner (`files: [...]` for `change-file`, `about: [...]` for
`decision-about`). `tonk query <concept> --json` itself returns the
dash-case field names verbatim, one row per lens value (repeated `this`).

---

## `change` — one per agent turn that changed files (SPEC §5.1)

```yaml
concept!: &change
  description: "One agent turn that changed files, recorded by the harness hook"
  with:
    session:      change-session        # text — hook stdin session_id
    turn:         change-turn           # text — hook stdin turn_id
    agent:        change-agent          # text — agent_name + harness + --agent-name at join
    harness:      change-harness        # entity keyword: :vibe | :claude
    prompt:       change-prompt         # text — pre_agent.prompt stashed by turn_id
    project:      change-project        # text — project dir name
    branch:       change-branch         # text — current git branch ("main")
    base:         change-base           # text — git tree hash of before-snapshot
    head:         change-head           # text — git tree hash of after-snapshot
    commit:       change-commit         # text — git HEAD the turn sat on
    lines-added:  change-lines-added    # natural — git diff --numstat sum
    lines-removed: change-lines-removed # natural
    redacted:     change-redacted       # boolean — secret scan removed something
    at:           change-at             # text — ISO 8601 UTC
  maybe:
    parent-session: change-parent-session # text — subagent turns
    response:       change-response       # text — post_agent.response_text
    diff:           change-diff           # text — inline diff, ≤ 64 KB
    diff-blob:      change-diff-blob      # entity — blob:<hash> / asset:<hash>, > 64 KB
```

Exactly one of `diff` / `diff-blob` is set (§11.2 default: inline ≤ 64 KB,
blob above). `files` is the lens `change-file` below. JSON mirror keys:
`session, turn, parentSession?, agent, harness, prompt, response?,
project, branch, base, head, commit, files[], linesAdded, linesRemoved,
diff?, diffBlob?, redacted, at`, plus derived `id = "<session>:<turn>"`.

### Lens `change-file` — one value per changed path

```yaml
concept!: &change-file
  description: "One changed path of a change record (lens for change.files)"
  with:
    change: change-file-change   # entity — the change instance
    path:   change-file-path     # text — repo-relative path
    status: change-file-status   # entity keyword: :added | :modified | :deleted | :renamed
    added:  change-file-added    # natural — numstat for this path
    removed: change-file-removed # natural
```

JSON mirror: `files: [{ path, status, added, removed }]` on the change.

## `decision` — added by hand in v1 (SPEC §5.2)

```yaml
concept!: &decision
  description: "A decision between real alternatives. Add-only: never edit; supersede."
  with:
    title: decision-title     # text — one line
    chosen: decision-chosen   # text — what was decided
    why:   decision-why       # text — the reasoning
    by:    decision-by        # text — agent or person who recorded it
    at:    decision-at        # text — ISO 8601 UTC
  maybe:
    rejected:   decision-rejected   # text — alternatives considered
    supersedes: decision-supersedes # entity — an earlier decision instance
```

`about` is the lens `decision-about`. A decision is **never edited or
retracted**; changing one means asserting a new `decision` with `supersedes`.

### Lens `decision-about` — one value per related file / area / change

```yaml
concept!: &decision-about
  description: "One target a decision is about (lens for decision.about)"
  with:
    decision: decision-about-decision # entity — the decision instance
    target:   decision-about-target   # entity — a change, a change-file, or a named area (id:…)
```

JSON mirror: `about: [...]` on the decision (entity URIs as strings).

## `decision-status` — add-only status record (SPEC §5.2)

```yaml
concept!: &decision-status
  description: "Status of a decision. Add-only; current = latest by `at`."
  with:
    decision: decision-status-decision # entity — the decision instance
    status:   decision-status-status   # entity keyword: :proposed | :accepted | :rejected
    by:       decision-status-by       # text
    at:       decision-status-at       # text — ISO 8601 UTC
```

### State machine — `decision-status`

```
                 assert decision            hand-added (§11.8 default)
   (new) ───────────────────────────────► :accepted
     │                                        ▲
     │ default when written by the distiller  │
     ▼                                        │
 :proposed ── accept ──► :accepted            │
     │                                        │
     └── reject ──► :rejected ◄──────────────┘
```

- Allowed transitions: `proposed → accepted`, `proposed → rejected`.
  Hand-added decisions start directly at `:accepted` (§11.8 default).
- `:accepted` and `:rejected` are **terminal in v1** — a change of mind is
  a new `decision` with `supersedes` (which may carry its own status
  records), never an edit.
- **Current status** = the `decision-status` record with the latest `at`
  for that decision; the status at a past point = latest `at` ≤ that point
  (§7.3). Enforced by read-side fold, not by the store.

## `session` — one per harness session (SPEC §5.3)

```yaml
concept!: &session
  description: "One harness session that recorded into the space"
  with:
    id:      session-id      # text — hook stdin session_id
    agent:   session-agent   # text
    harness: session-harness # entity keyword: :vibe | :claude
    project: session-project # text
    started: session-started # text — ISO 8601 UTC
    changes: session-changes # natural — number of change records written
  maybe:
    ended: session-ended     # text — ISO 8601 UTC, set at session-end
```

### State machine — `session`

```
 session-start: assert (started, changes: 0) ──► running
 session-end:   re-assert same entity with ended + final changes ──► ended
```

`ended` is added once; `changes` is a cardinality-one field, so the
session-end write supersedes the start value on the same entity (bind the
entity with a query `this: ?s` + `id: "…"`, then assert — do not mint a
second session instance).

## `tool` — the recorder logic stored in the space (SPEC §5.4)

```yaml
concept!: &tool
  description: "One published version of the recorder logic blob"
  with:
    name:         tool-name         # text — "<wrapper>" placeholder, e.g. "tonk-recorder"
    version:      tool-version      # text — semver
    blob:         tool-blob         # entity — blob:<hash> / asset:<hash> of tool.mjs
    sha256:       tool-sha256       # text — hex sha256 of the blob bytes
    publisher:    tool-publisher    # entity — did:key:… of a trusted-publisher identity
    published-at: tool-published-at # text — ISO 8601 UTC
    changelog:    tool-changelog    # text — one line
```

Only identities listed in `trusted-publisher` may publish `tool` records
that installed recorders accept (§8). The publisher DID is read from the
signed revision (`revision_after.issuer` of the write) and checked against
`trusted-publisher`.

## `trusted-publisher` — who may publish `tool` records (SPEC §5.5)

```yaml
concept!: &trusted-publisher
  description: "An identity allowed to publish tool records (set by the space owner)"
  with:
    identity: trusted-publisher-identity # entity — did:key:…
    at:       trusted-publisher-at       # text — ISO 8601 UTC
```

## Lens pattern for any other many-valued field (incl. `needs`)

`files`, `about` above; a future `needs` field (SPEC §10 coordination packs)
follows the same shape — a lens concept `<owner>-<field>` with
`<owner>` (entity back-ref) + value fields, one instance per value. Never
`pick: :all` on the owner concept for cross-record values.

## Attribute URI namespace

All relations live under `tonk.recorder.*`:
`tonk.recorder.change/<field>`, `tonk.recorder.change-file/<field>`,
`tonk.recorder.decision/<field>`, `tonk.recorder.decision-about/<field>`,
`tonk.recorder.decision-status/<field>`, `tonk.recorder.session/<field>`,
`tonk.recorder.tool/<field>`, `tonk.recorder.trusted-publisher/<field>`.
Anchors (in `packs/recorder.notation`) are `<concept>-<field>`.
