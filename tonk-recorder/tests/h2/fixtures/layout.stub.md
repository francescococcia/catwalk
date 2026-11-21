# layout.stub.md — H2's draft of the `contracts/layout.md` Claude section

> **Stub owned by H2 (`agent/h2-s2`), kept in `tests/h2/fixtures/` because
> `contracts/` belongs to W0.** W0 has not landed `contracts/` yet. Merge
> note for the lead: when W0's `contracts/layout.md` lands on master, fold
> the Claude Code section below into it and delete this stub — the Vibe
> section (§4.1) belongs to H1. Canonical copy of the Claude section also
> lives in `adapters/claude/README.md`.

## Tagged-entry marker convention (all harnesses that use JSON settings)

JSON has no comments, so managed hook entries are tagged **inside the
`command` string**: every hook entry installed by the recorder carries the
marker substring `@tonk-recorder` as a trailing shell comment:

```json
{ "type": "command", "command": "node \"/path/to/adapter.mjs\" session-start # @tonk-recorder" }
```

The shell ignores the trailing comment; the installer/uninstaller recognises
the marker. Rule: **any hook entry whose `command` contains `@tonk-recorder`
is managed by the recorder — install replaces it, uninstall removes it, and
nothing else is ever touched.**

## `install --harness claude` (H2 — `adapters/claude/`)

Writes **only** tagged entries into the user-level settings file:

| Path | What is written |
|---|---|
| `~/.claude/settings.json` | `hooks.SessionStart` / `hooks.UserPromptSubmit` / `hooks.Stop` / `hooks.SessionEnd` — one managed (tagged) entry each, mapping to the shared `tool.mjs hook <event>` entry points through `adapters/claude/adapter.mjs` (event map: `SessionStart→session-start`, `UserPromptSubmit→pre-agent`, `Stop→post-agent`, `SessionEnd→session-end`). All other keys and hook entries are preserved; the file is re-serialised as 2-space JSON with a trailing newline. |
| `~/.tonk/recorder-state/` | Runtime state written by `adapters/claude/adapter.mjs` (per-session `turn_id` + stashed prompt, since Claude Code payloads carry no `turn_id`). Overridable with `TONK_RECORDER_STATE_DIR`. Created lazily by the adapter, **not** by install. |

The hook command written into settings is:

```sh
node "<adapter.mjs path>" <neutral-event> # @tonk-recorder
```

The adapter reads the Claude Code payload on stdin, normalises it
(`session_id`, `transcript_path`, `cwd`; `prompt` from `UserPromptSubmit`;
synthesised `turn_id` stashed per session) and execs:

```sh
node "<tool.mjs path>" hook <neutral-event>
```

`<tool.mjs path>` resolves from `--tool`, else `TONK_TOOL`, else
`tool.mjs` next to the adapter (the space-fetched logic, §3.3).

`uninstall --harness claude` removes exactly the tagged entries (and any
hook group / event key left empty by that removal) and leaves everything
else — including the user's own hooks — untouched. It also removes
`~/.tonk/recorder-state/` only if empty of other harnesses' state (H2
removes only its own `*.json` session files it can attribute; in v1 it
leaves the directory).
