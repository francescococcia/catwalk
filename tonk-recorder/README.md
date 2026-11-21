# Mistral hackathon — a Tonk space that agents work in, record into, and replay from

Someone is vibe coding in their own harness (Mistral Vibe first, Claude Code
next). Their project is bound to a Tonk space, and:

1. **The space includes everything an agent needs.** The recorder logic, the
   record structure, the instructions and the setup steps all live in the
   space. A new agent needs only the `tonk` CLI and an invite link.
2. **Agents coordinate their work through the space.** Each role is installed
   on the space as a pack of concepts that let agents interact (tasks, claims,
   reviews, notes). No agent messages another directly.
3. **The harness's hooks record what happens** — every change an agent makes,
   plus the decisions made along the way. The agent does not have to cooperate.
4. **Replaying the history feeds a pipeline that generates video** of what was
   decided and why.

Status (2026-11-21): **design only, nothing built.** The full design and work
plan are in [`SPEC.md`](SPEC.md).

| Point | Where it stands in the spec |
|---|---|
| 1. Self-contained space | specified (§2, §3) |
| 2. Roles + coordination | outlined only (§10) — role packs and the coordination concepts still to be written in |
| 3. Recording | changes and hand-added decisions specified (§5, §6); recording tool actions not yet written in |
| 4. Replay → video | replay specified (§7); the video pipeline is outlined only (§10) |

---

## How it works, in short

One small utility wraps the `tonk` CLI (placeholder name `<wrapper>`; it calls
its own pinned `tonk` underneath).

**Start a project**

```sh
cd <project>
npx --yes <wrapper> new <name>
```

Creates the space, loads the structure, stores the logic in the space,
installs the hooks into your harness, and prints the line for inviting others.

**Bring another agent in**

```sh
npx --yes <wrapper> join '<link>' --agent-name <name>
```

Joins, fetches the logic from the space, checks it, installs the hooks. From
its next session that agent is recording too.

**What happens while agents work**

- At the end of every turn a hook writes one `change` record straight into
  tonk's local copy of the space (`tonk eval --no-sync`): the prompt, the
  agent's answer, the files, the full diff. No network on that path.
- The space is synced (`tonk pull` + `tonk push`) **only at checkpoints**:
  session start, session end, every 10 turns, or `<wrapper> sync`. That keeps
  a swarm of agents from fighting over the shared head or getting stuck
  pulling.
- At session start each agent is given the accepted decisions, what other
  agents changed, and short instructions for adding a decision by hand with
  plain `tonk` commands.

**Read it back**

```sh
tonk log change --limit 1000        # what happened and why
tonk log decision --limit 1000      # every decision
tonk restore --revision <v>         # the space as it stood at a point…
tonk query …                        # …query it…
tonk switch main                    # …and come back
<wrapper> decisions --at <revision | time | git-commit>   # works for any point, on any machine
```

`tonk restore` only works for revisions whose signed head this machine saved;
`decisions --at` computes the same answer from the log, which every machine
has in full.

---

## Things to know before building

- **`tonk log` / `restore` are not released yet.** They come from tonk
  PR #1146 (`feat/tonk-log`). Plan: it merges into dev and the utility targets
  dev; worst case, build the branch and point the utility at it with
  `TONK_BIN`. Everyone in a space must be on the same deployment.
- **The space ships code that runs on members' machines.** Only trusted
  publishers can change the logic; installs check a sha256; no silent updates
  (SPEC §8).
- **Links are bearer credentials.** Never write an invite link into a file, a
  commit or the space.
- **Decisions are never edited.** A change of mind is a new decision that
  supersedes the old one — that is what makes point-in-time queries possible.
- **Named branches per agent/role are not possible in tonk yet** (no way to
  create a named branch at the current head, give it its own remote, or
  merge). Checkpoint syncing covers the hackathon; per-agent remote branches
  are the follow-up if the swarm grows (SPEC §10).
- **Vibe cannot play video inside the harness** (nothing documented). The
  video is opened as a file or link.

---

## Setup

### Tonk CLI

```sh
npm i -g @tonk/cli@latest
which -a tonk          # should show one path only
tonk --version         # 0.8.0 as of 2026-11-21
```

- Several `tonk` binaries can end up on PATH — check `which -a tonk`. An old
  standalone 0.7.0 was moved aside to `~/.local/bin/tonk-0.7.0.bak`.
- The global install lives under the active nvm Node version; switching Node
  versions hides it.
- 0.8.0 has no `tonk log`. For replay you need a dev build that includes
  PR #1146, or a local build of `feat/tonk-log` in `~/Workspace/tonk`.

### Mistral Vibe CLI

```sh
curl -LsSf https://mistral.ai/vibe/install.sh | bash
```

With an old Homebrew `uv` (0.6.x) this fails with `No interpreter found for
executable name cpython-3.14+gil`. Either `brew upgrade uv` and rerun, or:

```sh
uv tool install --python 3.13 mistral-vibe
vibe --version         # 3.1.4 as of 2026-11-21
```

Installs `vibe`, `vibe-acp` and `vibe-app-server` into `~/.local/bin`. Update
with `uv tool upgrade mistral-vibe`. The failed official run leaves a stray
alpha Python: `uv python uninstall 3.14.0a6`.

First run:

```sh
vibe --setup           # API key → OS keychain (or ~/.vibe/.env)
cd <project> && vibe
```

---

## How the utility plugs into Vibe

It installs a **user-level plugin** — nothing in the project repo, nothing
added to your own `~/.vibe/hooks.toml`:

```
~/.vibe/plugins/tonk-recorder/
  plugin.json                  # Agent Plugins 1.0 manifest
  tool.mjs                     # the logic, fetched from the space and verified
  ai.mistral.vibe/hooks.toml   # session_start, pre_agent, post_agent, session_end
```

Vibe facts this relies on (Vibe 3.1.4's built-in reference, under
`…/site-packages/vibe/plugins/builtins/vibe/skills/`):

- Hooks are a stable harness feature: Vibe runs each hook's command itself and
  passes JSON on stdin — `session_id`, `transcript_path`, `cwd`, and per event
  `prompt` (`pre_agent`) or `response_text` (`post_agent`).
- `session_start` and `pre_agent` can add context the model sees and the user
  does not.
- Hooks fail open: a slow or broken hook never blocks the agent.
- A user plugin loads for every project, so the recorder does nothing in
  folders not bound to a space.
- Vibe subagents cannot use MCP tools, which is why everything goes through
  the `tonk` CLI.

Claude Code gets the same behaviour through its `SessionStart`,
`UserPromptSubmit`, `Stop` and `SessionEnd` hooks.

Mistral docs: [Vibe desktop](https://docs.mistral.ai/vibe/code/desktop/overview) ·
[hooks](https://docs.mistral.ai/vibe/code/cli/hooks) ·
[skills](https://docs.mistral.ai/vibe/code/cli/skills) ·
[MCP servers](https://docs.mistral.ai/vibe/code/cli/mcp-servers) ·
[Studio agents](https://docs.mistral.ai/studio/agents/overview) ·
[Studio apps deploy](https://docs.mistral.ai/studio/apps/deploy)

---

## Where to start

`SPEC.md` §9 is the work plan as a dependency graph: one small blocking
package (contracts, fixtures, and checks against real `tonk` and Vibe builds),
then four lanes that run in parallel, then the integration tests — one agent
recording, a five-agent swarm check, a second agent bootstrapping from the
space, and a Claude Code agent joining the same space.
