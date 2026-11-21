// Harness installation — delegates to the landed per-harness installer CLIs
// via child process (never import them: they run main() at module top level):
//   - vibe:   adapters/vibe/install.mjs   (H1, landed — contract contracts/layout.md §1)
//   - claude: adapters/claude/install.mjs (H2, landed — contracts/layout.md §2)
// Until H1 lands, `install --harness vibe` falls back to writing the §4.1
// layout itself (same files, same shape).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT, PKG_NAME, pluginDir, toolCachePath } from "./paths.mjs";

export const HOOKS_TOML = `[[hooks]]
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
`;

export function pluginManifest(version) {
  return {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: PKG_NAME,
    version,
    description: "Records agent code changes into the bound Tonk space.",
    extensions: { "ai.mistral.vibe": { schemaVersion: 1, displayName: "Tonk recorder" } },
  };
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function runNode(file, args, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env, cwd });
    let stderr = "";
    child.stdout.pipe(process.stdout);
    child.stderr.on("data", (d) => (stderr += d));
    child.stderr.pipe(process.stderr);
    child.on("error", () => resolve({ code: 1, stderr: "spawn failed" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/**
 * Install the verified recorder logic into a harness.
 * @param {string} home      (fake-able) HOME
 * @param {string} version   tool record version
 * @param {Buffer|string} toolSource  verified tool.mjs bytes
 * @param {string} harness   "vibe" (v1) | "claude" (v1b)
 */
export async function installPlugin({ home, version, toolSource, harness = "vibe", env = process.env } = {}) {
  // stage the verified bytes at the §3.3 bootstrap path (also the --source
  // for the installer CLIs)
  const staged = toolCachePath(version, { HOME: home });
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, toolSource);
  const sha = createHash("sha256").update(Buffer.isBuffer(toolSource) ? toolSource : Buffer.from(toolSource)).digest("hex");

  if (harness === "claude") {
    const installer = path.join(PKG_ROOT, "adapters", "claude", "install.mjs");
    if (!exists(installer)) throw new Error("harness 'claude' requested but adapters/claude/install.mjs is not present");
    const adapter = path.join(PKG_ROOT, "adapters", "claude", "adapter.mjs");
    const r = await runNode(installer, ["install", "--harness", "claude", "--home", home, "--adapter", adapter], { env, cwd: process.cwd() });
    if (r.code !== 0) throw new Error(`claude installer failed (exit ${r.code})`);
    return { harness, home };
  }

  // vibe: delegate to the H1 installer CLI when present (contracts/layout.md §1)
  const vibeInstaller = path.join(PKG_ROOT, "adapters", "vibe", "install.mjs");
  if (exists(vibeInstaller)) {
    const r = await runNode(
      vibeInstaller,
      ["install", "--harness", "vibe", "--home", home, "--source", staged, "--expect-sha256", sha, "--version", version],
      { env, cwd: process.cwd() },
    );
    if (r.code !== 0) throw new Error(`vibe installer failed (exit ${r.code}): ${r.stderr.trim()}`);
    return { harness, pluginDir: pluginDir({ HOME: home }), version };
  }

  // Fallback until H1 lands: write the §4.1 layout directly.
  const dir = pluginDir({ HOME: home });
  fs.mkdirSync(path.join(dir, "ai.mistral.vibe"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(pluginManifest(version), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "tool.mjs"), toolSource);
  fs.writeFileSync(path.join(dir, "ai.mistral.vibe", "hooks.toml"), HOOKS_TOML);
  return { harness, pluginDir: dir, version };
}

/** Remove the plugin / managed hooks + local state (SPEC §3, §8). */
export async function uninstallPlugin({ home, harness = "all", env = process.env } = {}) {
  const removed = [];
  const vibeInstaller = path.join(PKG_ROOT, "adapters", "vibe", "install.mjs");
  if (exists(vibeInstaller) && exists(path.join(home, ".vibe", "plugins", PKG_NAME))) {
    const r = await runNode(vibeInstaller, ["uninstall", "--harness", "vibe", "--home", home], { env, cwd: process.cwd() });
    if (r.code === 0) removed.push(pluginDir({ HOME: home }));
  }
  const dir = pluginDir({ HOME: home });
  if (exists(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!removed.includes(dir)) removed.push(dir);
  }
  const toolsRoot = path.join(home, ".tonk", "tools", PKG_NAME);
  if (exists(toolsRoot)) {
    fs.rmSync(toolsRoot, { recursive: true, force: true });
    removed.push(toolsRoot);
  }
  if (harness === "all" || harness === "claude") {
    const installer = path.join(PKG_ROOT, "adapters", "claude", "install.mjs");
    if (exists(installer) && exists(path.join(home, ".claude", "settings.json"))) {
      await runNode(installer, ["uninstall", "--harness", "claude", "--home", home], { env, cwd: process.cwd() });
      removed.push(path.join(home, ".claude", "settings.json") + " (managed @tonk-recorder entries)");
    }
  }
  return removed;
}

/** Installed version from the plugin manifest, or null. */
export function installedVersion(env = process.env) {
  try {
    const p = path.join(pluginDir(env), "plugin.json");
    if (!exists(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")).version ?? null;
  } catch {
    return null;
  }
}
