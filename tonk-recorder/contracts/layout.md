# contracts/layout.md — files written by install, and state paths (W0)

Names are placeholders per SPEC §11.6: npm/bin `<wrapper>`, plugin dir
`tonk-recorder`.

## 1. Vibe plugin install (`install --harness vibe`, SPEC §4.1)

User-level plugin — **nothing is written into the project repo** and
nothing into the user's own `~/.vibe/hooks.toml`:

```
~/.vibe/plugins/tonk-recorder/plugin.json        # Agent Plugins 1.0 manifest + ai.mistral.vibe extension
~/.vibe/plugins/tonk-recorder/tool.mjs           # copy of the verified logic from the space
~/.vibe/plugins/tonk-recorder/ai.mistral.vibe/hooks.toml  # the four hooks
```

`plugin.json` (exact):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "tonk-recorder",
  "version": "<version>",
  "description": "Records agent code changes into the bound Tonk space.",
  "extensions": { "ai.mistral.vibe": { "schemaVersion": 1, "displayName": "Tonk recorder" } }
}
```

`ai.mistral.vibe/hooks.toml` (exact):

```toml
[[hooks]]
name = "tonk-session-start"
type = "session_start"
command = "node tool.mjs hook session-start"

[[hooks]]
name = "tonk-pre-agent"
type = "pre_agent"
command = "node tool.mjs hook pre-agent"

[[hooks]]
name = "tonk-post-agent"
type = "post_agent"
command = "node tool.mjs hook post-agent"
timeout = 30.0

[[hooks]]
name = "tonk-session-end"
type = "session_end"
command = "node tool.mjs hook session-end"
```

At hook runtime Vibe runs the command in the plugin root with
`PLUGIN_ROOT` and `PLUGIN_DATA` set; the project folder arrives as `cwd` on
stdin (SPEC §4.1).

## 2. Claude Code install (`install --harness claude`, SPEC §4.2)

Managed, tagged entries in `~/.claude/settings.json` (convention already
landed by H2 — `adapters/claude/lib/settings.mjs`):

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "node <abs path to tool.mjs> hook session-start", "@tonk-recorder": true } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "… hook pre-agent",      "@tonk-recorder": true } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "… hook post-agent",     "@tonk-recorder": true } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "… hook session-end",    "@tonk-recorder": true } ] } ]
  }
}
```

The marker key is `@tonk-recorder`; `uninstall` removes only entries
carrying it and leaves all other hooks untouched.

## 3. No-wrapper bootstrap copy (SPEC §3.3)

```
~/.tonk/tools/<wrapper>/<version>/tool.mjs     # blob fetched from the space, sha256-verified
```

## 4. Recorder state — data root (SPEC §4.1, §6.2)

`DATA_ROOT` = `$PLUGIN_DATA` when set (Vibe plugin), else
`~/.tonk/recorder/` (Claude settings hooks and the no-wrapper path — no
`PLUGIN_DATA` there). Layout under `$DATA_ROOT`:

```
$DATA_ROOT/
  snapshots/<session_id>.tree        # last snapshot tree hash per session (§6.2)
  snapshots/<session_id>.index       # the temporary GIT_INDEX_FILE for that session
  prompts/<session_id>/<turn_id>.json  # stashed pre-agent prompt per turn
  state/<session_id>.json            # { turns: n, lastCheckpointAt, lastSeenOtherAgentAt, agentName }
  locks/<space-name>.lock            # writer lock around tonk writes — REQUIRED
                                     # (tonk revision.lock rejects concurrent writers,
                                     #  cli-checks.md); one per bound space
  cache/update-check.json            # last tool-record check (§3.4)
```

All state is local, disposable, and safe to delete (it is rebuilt from the
space + git on the next hook run). Nothing here is ever committed anywhere.

## 5. Tonk's own state (not ours, but part of the layout)

- macOS canonical store: `~/Library/Application Support/tonk/` —
  `spaces.json` is the registry (`{"spaces": {name: {site}}, "bindings":
  {absDir: name}}`), plus `spaces.lock` / `spaces.create.lock`,
  `account/`, `telemetry.json`. Verified on 0.8.0.
- Space site data: `<site>/main/…` (default
  `~/Library/Application Support/tonk/spaces/<name>`), or `--site <path>`
  for local-only spaces. The site holds `main/memory/branch/main/
  revision.lock` — the lock that makes concurrent `eval` fail (see
  cli-checks.md).
- `TONK_BIN` selects the tonk binary (default: the wrapper's pinned
  `@tonk/cli`); `TONK_SPACE` / `--space` select the space; `TONK_NO_SYNC=1`
  disables auto pull/push around writes.

## 6. Gitignored generated files

- The recorder writes **nothing into the bound project repo** (user-level
  plugin), so there is nothing project-side to gitignore.
- This repo's `.gitignore` covers generated build/test artifacts only:
  `node_modules/`, `dist/`, `*.log`, `.DS_Store`.
- Tonk site data and `$DATA_ROOT` live outside any repo and are never
  committed. Invite links are never written into any file, commit, record
  or AGENTS.md (SPEC §8).
