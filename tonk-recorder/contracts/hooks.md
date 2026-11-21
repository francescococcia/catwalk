# contracts/hooks.md — hook stdin → behaviour → stdout (W0)

The harness calls `node tool.mjs hook <event>` with a JSON payload on
**stdin**. Internal events (harness-neutral core, R3):
`session-start | pre-agent | post-agent | session-end`.
Harness mapping (H1/H2 adapters):

| Vibe (hooks.toml `type`) | Claude Code (settings.json) | Internal event   | `tool.mjs hook …` |
|---|---|---|---|
| `session_start` | `SessionStart`   | session-start | `session-start` |
| `pre_agent`     | `UserPromptSubmit` | pre-agent   | `pre-agent`     |
| `post_agent`    | `Stop`           | post-agent    | `post-agent`    |
| `session_end`   | `SessionEnd`     | session-end   | `session-end`   |

**Fail-open contract (both harnesses):** every hook exits `0` and prints
nothing on any internal error (bad JSON, missing fields, tonk failure,
timeout). Vibe fails open by design (`strict` not allowed on these four);
the Claude adapter also swallows errors (see
`adapters/claude/adapter.mjs`: "fail open", exit 0). Hooks must never
block the agent: the per-turn path makes **no network call** (SPEC §6.4);
only checkpoint syncs touch the network, with a hard timeout and fail-soft
(§6.5).

Sample stdin payloads: `fixtures/hooks/vibe/*.json`,
`fixtures/hooks/claude/*.json`.

## Shared stdin facts (SPEC §4.1/§4.2)

All events carry: `hook_event_name` (string), `session_id` (string),
`transcript_path` (string, absolute), `cwd` (string, absolute project dir).
Vibe adds `parent_session_id` when inside a subagent. Event-specific:

- Vibe `pre_agent`: `prompt` (string), `turn_id` (string).
- Vibe `post_agent`: `agent_name` (string), `turn_id` (string),
  `response_text` (string).
- Claude `UserPromptSubmit`: `prompt` (string). **No `turn_id`** — the
  adapter synthesises one per session (`turn-1`, `turn-2`, … counter kept
  in the data root, §layout.md) and pairs the n-th `UserPromptSubmit` with
  the n-th `Stop`.
- Claude `Stop`: `stop_hook_active` (boolean) — if true, this Stop is
  itself hook-generated; still record (the turn still changed files), but
  never loop.
- Claude `SessionEnd`: `reason` (string, e.g. `"logout"`).
- Vibe `post_agent` fires for subagents too (unscoped) — wanted
  ("record every change"); the record carries `parent_session_id`
  (§11.4 default: subagent turns recorded separately).

## Per-hook contract

### `session-start` (Vibe `session_start` / Claude `SessionStart`)

- stdin: shared facts (+ `additional_context` may exist on Vibe
  `session_start`; it is input, not output).
- behaviour (SPEC §6.3):
  1. **Binding check** (§6.1): resolve the space for `cwd` exactly as tonk
     does (`--space` > `TONK_SPACE` > nearest ancestor `tonk space use`
     binding). No binding → exit 0, record nothing. Not a git repo →
     exit 0, one warning per session. Active git branch ≠ `main` →
     exit 0, record nothing.
  2. First snapshot (§6.2): temp-index `git add -A` + `write-tree` →
     `$DATA_ROOT/snapshots/<session_id>.tree` + keep the temp index.
  3. **Checkpoint sync** (§6.5): `tonk pull` then `tonk push`, hard
     timeout 20 s each, random 0–3 s delay before push, fail-soft (exit 0
     regardless).
  4. Update check (§3.4): compare local tool version with the space's
     latest `tool` record; if newer **and** from a `trusted-publisher`,
     add a one-line `system_message` with the update command. v1 never
     auto-updates.
  5. Build context from the **local** copy (age stated): decision
     instructions (§6.7), accepted decisions, changes by **other** agents
     since this agent's last session (one line each: agent, prompt first
     line, files).
- stdout:
  - Vibe: `{"hook_specific_output": {"additional_context": "<markdown>"}}`
    — it MUST be nested; Vibe 3.1.4 ignores a top-level `additional_context`
    (`app_server/_host_hooks.py`, `_session_start_output`) (added unseen to the
    session's next user message); plus `{"system_message": "<one line>"}`
    only when an update is available. Both keys may be present in one
    object. Nothing else.
  - Claude `SessionStart`: `{"hookSpecificOutput": {"hookEventName":
    "SessionStart", "additionalContext": "<markdown>"}}`; plus
    `{"systemMessage": "<one line>"}` when an update is available.
  - No context to add → print nothing, exit 0.

### `pre-agent` (Vibe `pre_agent` / Claude `UserPromptSubmit`)

- stdin: shared facts + `prompt` + (Vibe) `turn_id`; Claude: adapter
  synthesises `turn_id`.
- behaviour: binding check (no binding → exit 0 silently); stash
  `{"prompt": …}` at `$DATA_ROOT/prompts/<session_id>/<turn_id>.json`.
  No rewrite, no context.
- stdout: **none** (exit 0, empty stdout).

### `post-agent` (Vibe `post_agent` / Claude `Stop`)

- stdin: shared facts + (Vibe) `agent_name`, `turn_id`, `response_text`;
  Claude: adapter pairs with the stashed prompt, reads `response_text`
  best-effort from `transcript_path` (may be `""`).
- behaviour (SPEC §6.3–§6.6):
  1. Binding + branch check (as session-start; silent exit 0).
  2. New snapshot with the temp index; `git diff <prev-tree> <new-tree>`
     (+ `--numstat`, per-file status via `git diff --name-status`).
  3. Empty diff → exit 0, **write nothing** (no-change turns write
     nothing).
  4. Build the `change` record per `contracts/records.md`; secret scan
     (§6.6) over the diff — matches replaced with `[redacted]`,
     `redacted: true`.
  5. Diff > 64 KB → `tonk blob add` first (with `--no-sync`), reference
     as `blob:<hash>` in `diff-blob`; else inline `diff`.
  6. **Idempotency** (§6.4): `tonk query change --where session=…
     --where turn=…`; if an instance exists → skip the write, exit 0.
  7. **Write**: exactly ONE `tonk eval --no-sync` per turn, with
     `TONK_NO_SYNC=1` in the child env, under the writer lock
     (`contracts/cli-checks.md` — tonk's own `revision.lock` rejects
     concurrent writers with exit 4; take
     `$DATA_ROOT/locks/<space>.lock` first, retry with backoff on exit 4).
     One revision per turn.
  8. Snapshot becomes prev. Turn counter per session +1; if counter
     mod N (default 10, §11.9) == 0 → checkpoint sync (§6.5, fail-soft,
     never block the turn).
- stdout: **none** (exit 0, empty stdout). Vibe `post_agent` has
  `timeout = 30.0` in hooks.toml.

### `session-end` (Vibe `session_end` / Claude `SessionEnd`)

- stdin: shared facts (+ Claude `reason`).
- behaviour: write/update the `session` record (`ended`, final `changes`
  count) via one `tonk eval --no-sync` under the writer lock; then
  **checkpoint sync** (§6.5). Clean up `$DATA_ROOT/prompts/<session_id>/`.
- stdout: ignored by Vibe; print nothing, exit 0.

## Exit codes

Always `0` from `tool.mjs hook …` — including on internal failure
(fail-open). The process may still fail to *start* (missing node); that is
the harness's fail-open path, not ours.
