// B0 single-file build: produces the self-contained dist/tool.mjs (SPEC §2 —
// "built as one self-contained file"). Zero-dependency.
//
// Component resolution — contracts/layout.md (W0, landed):
//   hooks      <- src/hooks/tool.mjs (R3) — inlined as a scoped bundle
//   update     <- src/update/check.mjs (B3 — self-contained, embedded as data: URL)
//   instructions <- instructions/decisions.md (R4) else stub
//   structurePack <- packs/recorder.notation (S1) else stub
//
// The inliner wraps EACH module body in a block scope and exposes its exports
// on a per-module namespace object (__M["<repo-relative-id>"]), rewriting
// relative imports to destructuring from those namespaces. That way duplicate
// top-level declarations across modules (e.g. INLINE_DIFF_LIMIT in both
// src/writer and src/snapshot) cannot collide. Node builtins are imported once
// at the top of the generated file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PKG_ROOT, PKG_NAME, PKG_VERSION, DIST_TOOL } from "./paths.mjs";
import { CONTRACTS } from "./contracts.mjs";

function readIfExists(rel) {
  const p = path.join(PKG_ROOT, rel);
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function dataUrlModule(src) {
  return "data:text/javascript;base64," + Buffer.from(src, "utf8").toString("base64");
}

// --- tiny scoped inliner ------------------------------------------------------
const IMPORT_FROM_RE = /^import\s+([^;]*?)\s+from\s+["']([^"']+)["'];?/gm;
const SIDE_EFFECT_IMPORT_RE = /^import\s+["']([^"']+)["'];?/gm;
const EXPORT_LIST_RE = /^export\s+\{([^}]*)\};?/gm;
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)|^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm;

function resolveDep(fromFile, spec) {
  let dep = path.resolve(path.dirname(fromFile), spec);
  if (!dep.endsWith(".mjs")) dep += ".mjs";
  return dep;
}

/**
 * Inline the entry module + its relative-import graph into one source string.
 * Returns { code, entryId, nodeBindings } where nodeBindings is the set of
 * node: local names the bundle expects the generated file to import.
 */
function bundleModules(entryRel) {
  const entry = path.join(PKG_ROOT, entryRel);
  if (!fs.existsSync(entry)) return null;
  const files = new Map(); // abs -> { id, src }
  const order = [];
  function visit(file) {
    if (files.has(file)) return;
    const src = fs.readFileSync(file, "utf8");
    files.set(file, { id: path.relative(PKG_ROOT, file), src });
    const deps = [];
    let m;
    IMPORT_FROM_RE.lastIndex = 0;
    while ((m = IMPORT_FROM_RE.exec(src))) if (m[2].startsWith(".")) deps.push(resolveDep(file, m[2]));
    SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
    while ((m = SIDE_EFFECT_IMPORT_RE.exec(src))) if (m[1].startsWith(".")) deps.push(resolveDep(file, m[1]));
    for (const d of deps) visit(d);
    order.push(file);
  }
  visit(entry);

  const nodeBindings = new Set(); // local names imported from node: modules
  const parts = [];
  for (const file of order) {
    const { id, src: rawSrc } = files.get(file);
    let src = rawSrc;
    if (src.startsWith("#!")) src = src.slice(src.indexOf("\n") + 1);

    // collect export names from the original source
    const exportNames = new Set();
    let dm;
    EXPORT_DECL_RE.lastIndex = 0;
    while ((dm = EXPORT_DECL_RE.exec(rawSrc))) exportNames.add(dm[1] ?? dm[2]);
    EXPORT_LIST_RE.lastIndex = 0;
    src = src.replace(EXPORT_LIST_RE, (whole, names) => {
      for (const n of names.split(",")) {
        const nm = n.trim().split(/\s+as\s+/).pop().trim();
        if (nm) exportNames.add(nm);
      }
      return "";
    });

    // rewrite imports: record relative ones, note node: bindings, strip all
    const relImports = [];
    src = src.replace(IMPORT_FROM_RE, (whole, clause, spec) => {
      if (spec.startsWith(".")) {
        relImports.push({ clause: clause.trim(), depId: path.relative(PKG_ROOT, resolveDep(file, spec)) });
      } else {
        // record local binding names from the clause: `fs`, `{ spawnSync }`, `def, { a as b }`
        const brace = clause.indexOf("{");
        if (brace === -1) nodeBindings.add(clause.trim());
        else {
          const def = clause.slice(0, brace).replace(/,$/, "").trim();
          if (def) nodeBindings.add(def);
          for (const part of clause.slice(brace + 1, clause.lastIndexOf("}")).split(",")) {
            const p = part.trim();
            if (!p) continue;
            nodeBindings.add(p.includes(" as ") ? p.split(/\s+as\s+/).pop().trim() : p);
          }
        }
      }
      return "";
    });
    src = src.replace(SIDE_EFFECT_IMPORT_RE, () => "");

    // strip line-leading `export ` on declarations
    src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, "");
    // drop the CLI entry guard if present
    src = src.replace(/^if\s*\([^\n]*import\.meta\.url[\s\S]*$/m, "");

    // relative imports become namespace destructuring at the top of the block
    const importLines = relImports.map(({ clause, depId }) => {
      if (clause === "*" || clause.startsWith("*")) throw new Error(`namespace import not supported by inliner: ${clause} in ${id}`);
      const ns = `__M[${JSON.stringify(depId)}]`;
      const brace = clause.indexOf("{");
      const def = brace === -1 ? clause : clause.slice(0, brace).replace(/,$/, "").trim();
      const named = brace === -1 ? null : clause.slice(brace + 1, clause.lastIndexOf("}"));
      const out = [];
      if (def) out.push(`const ${def} = ${ns}.default ?? ${ns};`);
      if (named !== null) {
        const inner = named.split(",").map((s) => s.trim()).filter(Boolean)
          .map((s) => (s.includes(" as ") ? s.replace(/\s+as\s+/, ": ") : s)).join(", ");
        out.push(`const { ${inner} } = ${ns};`);
      }
      return out.join("\n");
    }).join("\n");

    parts.push(
      `// ---- inlined ${id} ----\n{\n${importLines}\n${src.trim()}\n__M[${JSON.stringify(id)}] = { ${[...exportNames].join(", ")} };\n}`,
    );
  }
  return { code: parts.join("\n"), entryId: path.relative(PKG_ROOT, entry), nodeBindings };
}

export function collectComponents() {
  const hooksBundle = bundleModules(CONTRACTS.componentPaths.hooksTool);
  return {
    hooksBundle,
    hooksStub: readIfExists("src/cli/logic/hooks.stub.mjs"),
    update: readIfExists("src/update/check.mjs"),
    instructions: readIfExists(CONTRACTS.componentPaths.instructions) ?? readIfExists("src/cli/logic/instructions.md"),
    structurePack: readIfExists(CONTRACTS.componentPaths.structurePack) ?? readIfExists("src/cli/logic/structure-pack.notation"),
  };
}

// The generated runtime. Placeholders __X__ are substituted below; the runtime
// code itself avoids template literals so this file stays easy to maintain.
const RUNTIME = `#!/usr/bin/env node
// ${PKG_NAME} v${PKG_VERSION} — recorder logic, self-contained build.
// GENERATED by src/cli/build.mjs — do not edit. Installed from the space blob
// and sha256-verified at install time (SPEC §2, §8).
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
__NODE_IMPORTS__

const NAME = "__NAME__";
const VERSION = "__VERSION__";
const HAS_R3_HOOKS = __HAS_R3_HOOKS__;
const SELF_PATH = fileURLToPath(import.meta.url);
const SELF_SOURCE = fs.readFileSync(SELF_PATH);

const MODULES = __MODULES__;
const TEXTS = __TEXTS__;
const __M = {};
__HOOKS_BUNDLE__
const hooksMain = __M[__ENTRY_ID__]?.main ?? null;

async function loadModule(id) {
  if (!MODULES[id]) throw new Error("no such embedded module: " + id);
  return import(MODULES[id]);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function isBound(update) {
  // SPEC §6.1: no binding → no-op. 'tonk status' fails when no space is bound.
  try {
    const r = await update.runTonkTool(["status"], { timeoutMs: 8000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

async function cmdHook(event) {
  if (HAS_R3_HOOKS && hooksMain) {
    // R3 hook runtime (inlined above): reads the harness payload on stdin
    // itself and writes the hook's stdout JSON (SPEC §6.3).
    return (await hooksMain(["hook", event], process.env)) ?? 0;
  }
  // stub runtime until R3 lands
  let payload = {};
  try {
    const raw = await new Promise((resolve) => {
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => resolve(s));
      process.stdin.on("error", () => resolve(s));
    });
    if (raw.trim()) payload = JSON.parse(raw);
  } catch { payload = {}; }
  const update = await loadModule("update");
  const hooks = await loadModule("hooks");
  const ctx = {
    version: VERSION,
    instructions: TEXTS.instructions,
    isBound: () => isBound(update),
    checkForUpdate: (currentVersion) =>
      update.checkForUpdate({
        currentVersion,
        run: (args, opts) => update.runTonkTool(args, opts),
      }),
  };
  const runtime = globalThis.__TONK_HOOK_RUNTIME__ ?? hooks;
  const runHook = runtime.runHook ?? runtime.run;
  const out = (await runHook.call(runtime, event, payload, ctx)) ?? {};
  if (out && Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out) + "\\n");
}

function pluginDirOf(home) {
  return path.join(home, ".vibe", "plugins", NAME);
}

async function cmdInstall(argv) {
  let expectSha = null;
  let home = process.env.HOME;
  let harness = "vibe";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect-sha256") expectSha = argv[++i];
    else if (argv[i] === "--home") home = argv[++i];
    else if (argv[i] === "--harness") harness = argv[++i];
  }
  // SPEC §3.3/§8: install refuses to run if the sha256 does not match.
  if (expectSha && sha256(SELF_SOURCE) !== expectSha) {
    process.stderr.write(NAME + ": install refused — sha256 mismatch (expected " + expectSha + ", got " + sha256(SELF_SOURCE) + ")\\n");
    process.exit(1);
  }
  if (harness !== "vibe") {
    process.stderr.write(NAME + ": harness '" + harness + "' install is delegated to the wrapper (adapters/, H1/H2)\\n");
    process.exit(1);
  }
  // Built-in §4.1 layout (contracts/layout.md §1; the repo-side installer is
  // adapters/vibe/install.mjs — used by the wrapper, not shipped in the blob):
  const dir = pluginDirOf(home);
  fs.mkdirSync(path.join(dir, "ai.mistral.vibe"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: NAME,
      version: VERSION,
      description: "Records agent code changes into the bound Tonk space.",
      extensions: { "ai.mistral.vibe": { schemaVersion: 1, displayName: "Tonk recorder" } },
    }, null, 2) + "\\n",
  );
  fs.writeFileSync(path.join(dir, "tool.mjs"), SELF_SOURCE);
  fs.writeFileSync(path.join(dir, "ai.mistral.vibe", "hooks.toml"), TEXTS.hooksToml);
  process.stdout.write(NAME + " v" + VERSION + " installed at " + dir + "\\n");
}

async function cmdUninstall(argv) {
  let home = process.env.HOME;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--home") home = argv[++i];
  for (const p of [pluginDirOf(home), path.join(home, ".tonk", "tools", NAME)]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.stdout.write(NAME + " uninstalled (plugin + local state removed)\\n");
}

async function runCli() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "hook") return cmdHook(argv[1]);
  if (cmd === "install") return cmdInstall(argv.slice(1));
  if (cmd === "uninstall") return cmdUninstall(argv.slice(1));
  if (cmd === "instructions") return process.stdout.write(TEXTS.instructions);
  if (cmd === "structure-pack") return process.stdout.write(TEXTS.structurePack);
  if (cmd === "sync") return HAS_R3_HOOKS && hooksMain ? (await hooksMain(["sync"], process.env)) ?? 0 : 0;
  if (cmd === "version" || cmd === "--version") return process.stdout.write(VERSION + "\\n");
  process.stderr.write("usage: tool.mjs <hook <event> | install --expect-sha256 <sha> | uninstall | instructions | structure-pack | sync | version>\\n");
  process.exit(cmd ? 2 : 0);
}

runCli().catch((err) => {
  // hooks fail open (SPEC §4.1)
  process.stderr.write(NAME + ": " + (err && err.message ? err.message : err) + "\\n");
  process.exit(0);
});
`;

const DEFAULT_HOOKS_TOML = `[[hooks]]
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

// node: bindings the runtime template already imports
const RUNTIME_NODE_BINDINGS = new Set(["createHash", "spawn", "spawnSync", "execFileSync", "fs", "os", "path", "fileURLToPath"]);

function nodeImportLines(nodeBindings) {
  // The graph only uses bindings the runtime already imports; if a future
  // module needs another node: binding, emit an extra import for it here.
  const missing = [...nodeBindings].filter((b) => !RUNTIME_NODE_BINDINGS.has(b));
  if (missing.length) {
    // conservative fallback: import the whole node modules under those names
    return missing.map((b) => `import * as ${b} from "node:${b}";`).join("\n");
  }
  return "";
}

export function buildToolSource() {
  const c = collectComponents();
  const hasR3 = Boolean(c.hooksBundle);
  if (!c.update) throw new Error("build: no update component (src/update/check.mjs missing)");
  if (!c.instructions) throw new Error("build: no instructions text");
  if (!c.structurePack) throw new Error("build: no structure pack");

  const modules = { update: dataUrlModule(c.update) };
  if (!hasR3) {
    if (!c.hooksStub) throw new Error("build: no hooks component (stub missing)");
    modules.hooks = dataUrlModule(c.hooksStub);
  }
  const texts = {
    instructions: c.instructions,
    structurePack: c.structurePack,
    hooksToml: readIfExists("src/cli/logic/hooks.toml") ?? DEFAULT_HOOKS_TOML,
  };

  return RUNTIME
    .replaceAll("__NAME__", PKG_NAME)
    .replaceAll("__VERSION__", PKG_VERSION)
    .replaceAll("__HAS_R3_HOOKS__", hasR3 ? "true" : "false")
    .replaceAll("__NODE_IMPORTS__", nodeImportLines(hasR3 ? c.hooksBundle.nodeBindings : new Set()))
    .replaceAll("__MODULES__", JSON.stringify(modules))
    .replaceAll("__TEXTS__", JSON.stringify(texts))
    .replace("__HOOKS_BUNDLE__", () => (hasR3 ? c.hooksBundle.code : "// (R3 hooks not present; stub used)"))
    .replaceAll("__ENTRY_ID__", JSON.stringify(hasR3 ? c.hooksBundle.entryId : ""));
}

export function runBuild(outFile = DIST_TOOL) {
  const src = buildToolSource();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, src);
  fs.chmodSync(outFile, 0o755);
  return { outFile, bytes: src.length };
}

// allow `node src/cli/build.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = runBuild();
  console.log(`built ${r.outFile} (${r.bytes} bytes)`);
}
