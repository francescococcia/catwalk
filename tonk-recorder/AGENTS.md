# AGENTS.md — how we build the Tonk recorder (hackathon)

Read `SPEC.md` first (v3 design + §9 work-plan DAG). `README.md` is the
user-facing summary. This file is the working protocol for parallel agents.

## Where you work

- Integration branch: `master` in `/Users/goblin/Workspace/mistral_hackathon`.
- Each build agent works in its own git worktree (see
  `git worktree list`) on its own branch `agent/<name>`:

| Worktree (under `~/.vibe/worktrees/mistral_hackathon-ff46b5d643c9/`) | Branch | Packages (SPEC §9.2) | Owns (dirs) |
|---|---|---|---|
| `w0-s1-r2` | `agent/w0-s1-r2` | W0 → S1 → R2 | `contracts/`, `fixtures/`, `packs/`, `src/writer/`, `tests/w0*`, `tests/r2*` |
| `r1-r3-r5` | `agent/r1-r3-r5` | R1 → R3 → R5 | `src/snapshot/`, `src/hooks/`, `src/decisions-at/`, `tests/r1*`, `tests/r3*`, `tests/r5*` |
| `h1-r4-b2` | `agent/h1-r4-b2` | H1 → R4 → B2 | `adapters/vibe/`, `instructions/`, `src/install/`, `tests/h1*`, `tests/r4*`, `tests/b2*` |
| `h2-s2` | `agent/h2-s2` | H2 → S2 | `adapters/claude/`, `views/`, `tests/h2*`, `tests/s2*` |
| `b0-b1-b3` | `agent/b0-b1-b3` | B0 → B1 → B3 | `package.json`, `bin/`, `src/cli/`, `src/publish/`, `src/update/`, `tests/b0*`, `tests/b1*`, `tests/b3*` |

## Rules

1. **Own only your dirs.** Build against the W0 contracts
   (`contracts/records.md`, `contracts/hooks.md`, `contracts/layout.md`) and
   `fixtures/`, never against another agent's unfinished code. If a
   dependency isn't on `master` yet, code to the contract and note the
   integration point. You may `git merge master` into your branch any time to
   pick up landed contracts/fixtures.
2. **Commit everything on your branch**, often. The lead merges finished
   branches into `master` (`git merge --no-ff agent/<name>`); do not merge
   into `master` yourself and do not touch other agents' branches.
3. **L1 is not available:** the dev `tonk` CLI with `tonk log` / `tonk
   restore` (PR #1146) is still building on CI/CD. Installed `tonk` is 0.8.0.
   Code the log/restore consumers (R5, anything reading history) against the
   fixture JSON in `fixtures/`; make the tonk binary selectable via `TONK_BIN`
   and pin `@tonk/cli` in `package.json` per SPEC §2/§7.4. Verify what 0.8.0
   actually supports (`tonk eval --help`, `tonk blob --help`, …) and record
   results in `contracts/cli-checks.md` (W0 owner); mark dev-only flags `DEV`.
4. **Never write invite links into files, commits, records or AGENTS.md**
   (SPEC §8). No real spaces, no network side effects in tests — fixtures only.
5. JS, Node ESM (`"type": "module"`), zero-dependency where possible; the
   recorder logic ships as a single self-contained `tool.mjs`. Tests: `node
   --test`, runnable fully offline.
6. Naming: npm package / bin placeholder `tonk-recorder`, plugin dir
   `~/.vibe/plugins/tonk-recorder/` (SPEC §11.6 — placeholders).
7. When your package's "done when" (SPEC §9.2) is met, leave the branch fully
   committed and report: what was produced, file list, how to run its tests,
   deviations from the spec, open questions.
