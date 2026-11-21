# adapters/vibe — H1: Vibe plugin installer (SPEC §4.1, §9.2)

`install --harness vibe` writes a **user-level plugin and nothing else**:

```
~/.vibe/plugins/tonk-recorder/
  plugin.json                      # Agent Plugins 1.0 manifest + ai.mistral.vibe extension
  tool.mjs                         # byte copy of the verified logic from the space
  ai.mistral.vibe/hooks.toml       # the four recorder hooks
```

- Nothing is written into the project repo, nothing into the user's own
  `~/.vibe/hooks.toml`, no state files. `uninstall` removes exactly the three
  files install wrote (plus the directories it created, only if they are then
  empty).
- Rerunning `install` is idempotent: same input bytes → same layout, exit 0.
- `install --expect-sha256 <sha256>` refuses (exit 2, writes nothing) when the
  tool source's sha256 does not match — SPEC §3.3/§8.
- `--home DIR` (default `$HOME`) selects the user home; tests use a fake HOME.
- `--source PATH` (default: the running `tool.mjs` itself, i.e. a self-copy)
  is the verified logic file to install. `--version V` sets the manifest
  version (default `0.0.0`, or `$TONK_RECORDER_VERSION`).

## Files

| File | Role |
|---|---|
| `tool-side.mjs` | Self-contained logic (node builtins only): templates, `installVibe`/`uninstallVibe`/`statusVibe`, CLI `main`. Packed into `tool.mjs` by `src/install/pack.mjs`. |
| `install.mjs` | Repo-side CLI entry (`node adapters/vibe/install.mjs install …`), mirroring `adapters/claude/install.mjs` (H2). |

## Draft of the `contracts/layout.md` Vibe section (W0 stub)

> W0 has not landed `contracts/` yet. When it does, fold this section into
> `contracts/layout.md` and delete it here.

| Path | Written by | Content |
|---|---|---|
| `~/.vibe/plugins/tonk-recorder/plugin.json` | `install --harness vibe` | Agent Plugins 1.0 manifest, byte-exact per SPEC §4.1 (`$schema`, `name: tonk-recorder`, `version`, `description`, `extensions.ai.mistral.vibe {schemaVersion: 1, displayName: "Tonk recorder"}`) |
| `~/.vibe/plugins/tonk-recorder/tool.mjs` | `install --harness vibe` | byte copy of the verified logic (`--source`, default: the running tool.mjs) |
| `~/.vibe/plugins/tonk-recorder/ai.mistral.vibe/hooks.toml` | `install --harness vibe` | 4 hooks: `tonk-session-start` (session_start), `tonk-pre-agent` (pre_agent), `tonk-post-agent` (post_agent, `timeout = 30.0`), `tonk-session-end` (session_end); each `command = "node tool.mjs hook <event>"` |

Hook runtime facts (Vibe 3.1.4, `vibe:create-plugin`): plugin hooks run in the
plugin root with `PLUGIN_ROOT`/`PLUGIN_DATA` set; the project folder is the
`cwd` field on stdin; state goes in `PLUGIN_DATA`; hooks fail open.

## Follow-up for the lead

A real-Vibe check (`/plugins` lists `tonk-recorder` with 4 hooks after
install) needs a live Vibe session — not run here; tests are offline and
fixture-driven (see `tests/h1/`).
