// Package paths + HOME-aware install locations (SPEC §4.1, §3.3).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
/** npm package / bin placeholder name (SPEC §11.6). */
export const PKG_NAME = pkgJson.name; // "tonk-recorder"
export const PKG_VERSION = pkgJson.version;
/** Pinned tonk CLI version (SPEC §2, §7.4). DEV: once tonk PR #1146 lands in a dev
 *  build, this pin moves to that dev version and the §3.3 bootstrap block must
 *  name it instead of a released tag. */
export const PINNED_TONK_CLI = pkgJson.dependencies["@tonk/cli"];

export const DIST_TOOL = path.join(PKG_ROOT, "dist", "tool.mjs");

export function homeDir(env = process.env) {
  const h = env.HOME || env.USERPROFILE;
  if (!h) throw new Error("HOME is not set; cannot locate harness plugin dirs");
  return h;
}

/** Vibe plugin dir. Callers pass the *install root*: the project folder for a
 * project-local plugin (default — the recorder only exists in folders that
 * connected), or HOME for a legacy user-level install. */
export function pluginDir(root = process.cwd(), env = process.env) {
  if (path.isAbsolute(root)) return path.join(root, ".vibe", "plugins", PKG_NAME);
  return path.join(homeDir(env), ".vibe", "plugins", PKG_NAME); // old { HOME } call style
}

/** Bootstrap tools root used by the no-wrapper paste path (SPEC §3.3). */
export function toolsRoot(env = process.env) {
  return path.join(homeDir(env), ".tonk", "tools", PKG_NAME);
}

export function toolCachePath(version, env = process.env) {
  return path.join(toolsRoot(env), version, "tool.mjs");
}
