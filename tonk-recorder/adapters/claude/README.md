# adapters/claude — Claude Code installer + runtime adapter (H2)

SPEC §4.2 / §9.2 H2. `install --harness claude` manages **tagged** entries in
`~/.claude/settings.json`; `uninstall` removes only those entries and leaves
the user's own hooks untouched.

## Files

| File | Role |
|---|---|
| `install.mjs` | CLI: `install \| uninstall \| status --harness claude [--home DIR] [--settings FILE] [--adapter PATH]`. The wrapper's `install --harness claude` delegates here (integration point with B0's CLI dispatch). |
| `lib/settings.mjs` | Pure functions over a settings object / file: load (missing → `{}`, invalid JSON → `SettingsParseError`, file untouched), install, uninstall, status. Atomic write (tmp + rename), 2-space JSON + newline. |
| `adapter.mjs` | Runtime per-harness adapter installed as the hook command. Reads the Claude Code stdin payload, maps the event, execs `tool.mjs hook <event>`. Fails open (exit 0) on any internal error. |
| `lib/payload.mjs` | Claude Code payload → neutral payload mapping + per-session `turn_id`/prompt stash (`TurnStore`). |

## Tagged-entry marker convention

JSON has no comments, so a managed hook entry is recognised by the marker
substring **`@tonk-recorder`** inside its `command` string (a trailing shell
comment the shell ignores):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node \"/abs/path/adapter.mjs\" session-start # @tonk-recorder" }
        ]
      }
    ]
  }
}
```

Rule: any hook entry whose `command` contains `@tonk-recorder` is managed —
install replaces it, uninstall removes it; **nothing else is touched**.
Also drafted in `tests/h2/fixtures/layout.stub.md` (H2's copy of the
`contracts/layout.md` section; `contracts/` is owned by W0 — when W0 lands,
this convention moves there).

## Event map (SPEC §4.2)

| Claude Code hook (settings key) | `tool.mjs hook …` entry point | Payload notes |
|---|---|---|
| `SessionStart` | `hook session-start` | `session_id`, `transcript_path`, `cwd` |
| `UserPromptSubmit` | `hook pre-agent` | + `prompt` (stashed by synthesised `turn_id`) |
| `Stop` | `hook post-agent` | + `turn_id` re-attached from the stash |
| `SessionEnd` | `hook session-end` | session state cleaned up |

Claude Code payloads carry `session_id`, `transcript_path`, `cwd` on every
event and `prompt` only on `UserPromptSubmit`; there is no `turn_id`, so the
adapter synthesises one per submitted prompt and stashes
`{turn_id, prompt}` in `$TONK_RECORDER_STATE_DIR` (default
`~/.tonk/recorder-state/`), keyed by a hash of the session id.

The hook command written by install is:

```sh
node "<adapter.mjs>" <neutral-event> # @tonk-recorder
```

The adapter execs `node "<tool.mjs>" hook <neutral-event>` with the
normalised payload on stdin. `tool.mjs` resolves from `--tool`, else
`$TONK_TOOL`, else `tool.mjs` next to the adapter (the space-fetched,
sha256-verified logic — §3.2/§3.3, B2).

## Usage

```sh
# install (idempotent — rerun replaces the tagged entries, nothing else)
node adapters/claude/install.mjs install --harness claude

# show managed entries
node adapters/claude/install.mjs status --harness claude

# remove only the tagged entries
node adapters/claude/install.mjs uninstall --harness claude
```

Tests use a fake HOME: `HOME=<tmp> node adapters/claude/install.mjs install --harness claude`.

Exit codes: `0` ok · `1` usage/other error · `2` settings file exists but is
invalid JSON (left untouched).

## Tests

```sh
node --test tests/h2/
```

Fully offline: fixtures + fake HOME + a stub `tool.mjs` (records argv/stdin)
via `TONK_TOOL`. See `tests/h2/`.
