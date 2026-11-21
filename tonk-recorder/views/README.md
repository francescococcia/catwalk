# views/ — S2 change-log view

SPEC §9.2 S2: a route listing `change` records **newest first** (agent, prompt
first line, files with statuses, +/− lines); opening one change shows its
diff (inline ≤ 64 KB, else a `blob:<hash>` link). Access is **member-only**
(SPEC §8) — every page footer states how the route is served:
`https://<origin>/space/<did>/<path>`.

Two render paths ship here, same content:

| Path | Files | How it runs |
|---|---|---|
| **Static renderer** (offline, fixture-driven — the tested one) | `render.mjs`, `lib/records.mjs`, `lib/html.mjs` | `node views/render.mjs --in <dir-of-change-json> --out dist/views` |
| **tonk view facets** (served by the space, `tonk render`-compatible) | `templates/change.directory.html`, `templates/change.ui.html` | asserted into the space as the `change` concept's `directory` / `ui` facets (snippet below) |

## Input records — `change` JSON (SPEC §5.1)

One JSON object per file in `--in` (default `fixtures/changes/` — **W0's
fixtures dir, not landed yet**; until then use `tests/s2/fixtures/changes/`):

```json
{
  "id": "chg-0001", "session": "sess-1", "turn": "cc-…", "parentSession": null,
  "agent": "hermes", "harness": "vibe",
  "prompt": "first line\nrest of the prompt", "response": "…",
  "project": "mistral_hackathon", "branch": "main",
  "base": "tree…", "head": "tree…", "commit": "abc123…",
  "files": [{ "path": "src/a.js", "status": "modified", "added": 10, "removed": 2 }],
  "linesAdded": 12, "linesRemoved": 2,
  "diff": "…unified diff…", "diffBlob": null,
  "redacted": false, "at": "2026-11-21T12:00:00Z"
}
```

Required: `id` (or `session`+`turn`), `agent`, `prompt`, `files[]`, `at`.
`status` ∈ added|modified|deleted|renamed; `linesAdded/Removed` default to
the sum over `files`. `diff` inline vs `diffBlob: "blob:<hash>"` is the
§5.1/§11.2 size split. **Integration point:** when W0 lands
`contracts/records.md` + `fixtures/`, point `--in` at `fixtures/` and align
field names if the notation differs.

## Usage

```sh
# static preview from the sample fixtures (offline)
node views/render.mjs --in tests/s2/fixtures/changes --out dist/views
# then open dist/views/index.html

# once W0's fixtures/ land on master:
node views/render.mjs                 # --in fixtures/changes --out dist/views
```

Emits `<out>/index.html` (list, newest first) and `<out>/change/<id>.html`
per change (meta, files table, diff inline or blob link). `dist/` is
gitignored.

## tonk view facets (space-served route)

Assert the templates into the space (after S1's `packs/recorder.notation`
lands) so `tonk render change` / `tonk render <entity>@change` serve the same
pages at `/space/<did>/change` and `/space/<did>/<entity>@change`:

```yaml tonk=parse
view!:
  this: change
  show:
    directory: |
      <section class="tonk-change-log">
        <h1>Changes</h1>
        <tonk-display model=change view=ui></tonk-display>
      </section>
    ui: |
      <article class="change">
        <h2><a href="{this}@change">{prompt}</a></h2>
        <p>{agent} · {at} · +{linesAdded} / −{linesRemoved}</p>
        <p>{files}</p>
      </article>
```

(Template files: `templates/change.directory.html`, `templates/change.ui.html`.)
`{files}` is many-valued — its expansion goes through the lens concept W0's
pack defines (integration point); the static renderer expands it fully.

## Tests

```sh
node --test tests/s2/*.test.mjs
```

Offline: renders `tests/s2/fixtures/changes/` into a tmp dir and asserts the
list order, badges, totals, detail pages, blob link, footer route note, and
HTML escaping.
