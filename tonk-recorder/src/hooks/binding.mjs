// Binding resolution — resolve the space for a cwd exactly the way tonk 0.8.0
// does (verified against the installed CLI; `tonk help spaces`):
//
//   --space <name>  >  TONK_SPACE  >  `tonk space use` binding in the
//   nearest ancestor directory.  There is no global fallback.
//
// `tonk space use` stores only a pointer in the central registry
// (verified: $HOME/Library/Application Support/tonk/spaces.json on macOS,
// shaped { spaces: { name: { site } }, bindings: { absDir: name } }). We read
// that registry directly — pure local fs, no tonk subprocess, so the unbound
// no-op path stays well under 100 ms (SPEC §6.1).
//
// INTEGRATION POINT: when W0 lands contracts/layout.md, align the registry
// candidate paths with it. A TONK_REGISTRY env var pointing straight at a
// spaces.json is honoured for tests/other layouts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitSpace } from "./identity.mjs";

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Candidate locations of tonk's central registry (spaces.json). */
export function registryPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const out = [];
  if (env.TONK_REGISTRY) out.push(env.TONK_REGISTRY);
  if (env.TONK_STATE_DIR) out.push(path.join(env.TONK_STATE_DIR, "spaces.json"));
  // macOS app-support location (verified on this machine with tonk 0.8.0)
  out.push(path.join(home, "Library", "Application Support", "tonk", "spaces.json"));
  // XDG / Linux locations
  const xdg = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  out.push(path.join(xdg, "tonk", "spaces.json"));
  // legacy flat home
  out.push(path.join(home, ".tonk", "spaces.json"));
  return [...new Set(out)];
}

/** Names of the spaces this machine has (first existing registry), or null. */
export function knownSpaces(env = process.env) {
  for (const p of registryPaths(env)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j && typeof j.spaces === "object" && j.spaces) return new Set(Object.keys(j.spaces));
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Read the first existing registry -> Map(realDir -> spaceName), or null. */
export function readBindings(env = process.env) {
  for (const p of registryPaths(env)) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw);
      const bindings = j && typeof j === "object" ? j.bindings : null;
      if (bindings && typeof bindings === "object") {
        const map = new Map();
        for (const [dir, name] of Object.entries(bindings)) map.set(real(dir), name);
        return map;
      }
    } catch {
      /* not there / unreadable — try next candidate */
    }
  }
  return null;
}

/**
 * Resolve the space for `cwd`.
 * @returns {{ space: string, source: '--space'|'TONK_SPACE'|'binding'|'git-config', dir?: string } | null}
 */
export function resolveSpace(cwd, { env = process.env, spaceArg } = {}) {
  if (spaceArg) return { space: spaceArg, source: "--space" };
  if (env.TONK_SPACE) return { space: env.TONK_SPACE, source: "TONK_SPACE" };
  const bindings = readBindings(env);
  if (bindings) {
    let dir = real(path.resolve(cwd));
    for (;;) {
      const name = bindings.get(dir);
      if (name) return { space: name, source: "binding", dir };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Not bound by folder. A git worktree of a connected repository (Vibe puts
  // spawned agents in ~/.vibe/worktrees/…) is a different folder, so tonk's
  // own binding misses it: `new` / `join` also write the space name into the
  // repository's git config (`tonk.space`), which every worktree shares.
  // Honoured only when this machine actually has that space.
  const name = gitSpace(cwd);
  if (name) {
    const known = knownSpaces(env);
    if (known && known.has(name)) return { space: name, source: "git-config" };
  }
  return null;
}
