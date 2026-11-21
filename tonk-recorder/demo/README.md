# demo/ — a live demo Tonk space with the tonk-recorder concepts, sample data, and views

Everything here is **offline and fake**: a local-only space (`--site`, no
upstream), a fake `HOME`, `DO_NOT_TRACK=1`, fixture/sample data only. No
network, no invite links, no real spaces (SPEC §8).

## What it does

```sh
TONK_BIN=~/.local/bin/tonk-dev node demo/seed-space.mjs
```

1. creates `../tonk-demo/` (outside the repo — tonk site data never lives in
   a repo, `contracts/layout.md` §5): `home/` (fake HOME), `site/` (the
   space), `project/` (the bound directory);
2. `tonk-dev space new recorder-demo --site …` — local-only space;
3. loads the tonk-recorder concepts: `packs/recorder.notation` (the six
   concepts + two lenses, `contracts/records.md`);
4. fills it with sample data: `fixtures/records/*.notation` (W0 fixtures)
   plus `demo/sample-extra.notation` (a proposed→rejected decision, an
   accepted one that supersedes it, and one decision linked to a real change);
5. **writes the views into the space** — `view!:` facets for `decision`,
   `decision-status` and `change` from `views/templates/*.html`, so the space
   itself serves the decision history;
6. exports a JSON mirror (`tonk query --json`, lenses folded) to
   `demo/data/` for the static renderer, and renders the in-space views
   headlessly to `../tonk-demo/rendered/`.

Idempotent: re-running recreates the space from scratch (`--keep` to reuse)
and re-asserts the same facts (no-op commits).

## Browse the space (tonk-dev)

```sh
cd ../tonk-demo/project
export HOME=$PWD/../home TONK=/Users/goblin/.local/bin/tonk-dev
$TONK status                 # bound space, branch, sync state
$TONK query decision --json  # the records
$TONK log decision --limit 20        # claim-level history (PR #1146)
$TONK render decision                # the decision-history view, from the space
$TONK render decision-status         # status records (current = latest at)
$TONK render change                  # the change log
$TONK render decision-blob-diffs@decision   # one entity through its ui facet
```

Routes when served member-only: `https://<origin>/space/<did>/decision`,
`…/<entity>@decision`, etc.

## Static view (offline, fixture-driven)

```sh
node views/decisions.mjs --in demo/data --out dist/views
# open dist/views/index.html — landing with links to:
#   decisions/index.html   decision history: current status badge, supersedes
#                          chain, about-chips (linked to changes), newest first
#   decisions/<slug>.html  one decision: full status history, supersede chain,
#                          related changes, chosen/why/rejected
#   timeline.html          merged feed: changes + decisions + status events
#   changes/               the S2 change log (views/render.mjs)
```

`views/decisions.mjs` renders the exported JSON mirror; `views/lib/decisions.mjs`
holds the load/fold (current status = latest status record by `at`; supersede
chains via `supersedes`; `about` targets that are change entities link to them).

## Files

| Path | What |
|---|---|
| `demo/seed-space.mjs` | create space → load pack → seed records → assert views → export JSON → render previews |
| `demo/sample-extra.notation` | extra sample decisions/statuses (fake timeline) |
| `demo/data/*.json` | exported JSON mirror of the space (generated) |
| `views/templates/decision.directory.html`, `decision.ui.html` | `decision` view facets asserted into the space |
| `views/templates/decision-status.directory.html`, `decision-status.ui.html` | `decision-status` view facets |
| `views/decisions.mjs`, `views/lib/decisions.mjs` | static decision-history renderer |

Note on templates: `{field}` placeholders must be the concept's notation
field names (dash-case, e.g. `{lines-added}`); a placeholder that is not a
field of the concept (e.g. `{files}` — a lens row set, not a field) makes the
whole `view!:` document fail to evaluate, verified on tonk-dev 0.6.16-rc.1.
The pre-existing `views/templates/change.ui.html` predates that contract, so
the demo asserts the `change` ui facet with contract field names
(`CHANGE_UI` in `demo/seed-space.mjs`).

## Tests

```sh
node --test tests/s2/*.test.mjs     # includes the decisions-view tests
```
