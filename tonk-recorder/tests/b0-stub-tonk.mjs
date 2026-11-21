#!/usr/bin/env node
// Stub `tonk` for offline tests (AGENTS.md rule 4: fixture-driven, fake HOME,
// TONK_BIN stub — never a real space, no network).
//
// State dir comes from TONK_STUB_STATE and holds:
//   scenario.json            { identity, invite, responses: [{match:[...], stdout?, stderr?, exit?}] }
//   calls.jsonl              every invocation: { argv, cwd, TONK_NO_SYNC }
//   blobs/<sha256>           blob bytes (blob add/cat round-trip, real sha256)
//   tool-records.json        tool records parsed from `eval -c` docs (camelCase JSON)
//   trusted-publishers.json  trusted-publisher records parsed from `eval -c` docs
//   agents.md                the space AGENTS.md claim (space agents get/set)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const state = process.env.TONK_STUB_STATE;
if (!state) { console.error("stub-tonk: TONK_STUB_STATE not set"); process.exit(2); }
fs.mkdirSync(path.join(state, "blobs"), { recursive: true });
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(state, "calls.jsonl"), JSON.stringify({ argv, cwd: process.cwd(), TONK_NO_SYNC: process.env.TONK_NO_SYNC ?? null }) + "\n");

// strip tonk's global flags (--space <name>, -v/--verbose) so built-ins can
// match on the subcommand (R3 calls e.g. `tonk --space projx query tool --json`)
let pendingExit = false;
const args = [...argv];
while (args[0] === "--space") args.splice(0, 2);
while (args[0] === "-v" || args[0] === "--verbose") args.splice(0, 1);

const scenarioPath = path.join(state, "scenario.json");
const scenario = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, "utf8")) : {};

function readJson(file, fallback) {
  const p = path.join(state, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
}
function writeJson(file, value) {
  fs.writeFileSync(path.join(state, file), JSON.stringify(value, null, 2));
}

// ---- built-in verbs -------------------------------------------------------
if (args[0] === "blob" && args[1] === "add") {
  const file = args[args.length - 1];
  const buf = fs.readFileSync(file);
  const h = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(path.join(state, "blobs", h), buf);
  console.log("blob:" + h);
  process.exit(0);
}
if (args[0] === "blob" && args[1] === "cat") {
  const ref = String(args[2]).replace(/^blob:/, "");
  const f = path.join(state, "blobs", ref);
  if (!fs.existsSync(f)) { console.error("blob not found: " + ref); process.exit(1); }
  process.stdout.write(fs.readFileSync(f), () => process.exit(0));
  pendingExit = true;
}
if (args[0] === "space" && args[1] === "agents" && args[2] === "get") {
  const f = path.join(state, "agents.md");
  process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", () => process.exit(0));
  pendingExit = true;
}
if (args[0] === "space" && args[1] === "agents" && args[2] === "set") {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    fs.writeFileSync(path.join(state, "agents.md"), s);
    console.log("agents.md asserted on the space repository subject");
    process.exit(0);
  });
  process.stdin.resume();
}
if (args[0] === "identity") {
  console.log(scenario.identity ?? "did:key:zStubCreator111");
  process.exit(0);
}
if (args[0] === "invite") {
  console.log(scenario.invite ?? "https://tonk.example.invalid/join#stub-invite-token");
  process.exit(0);
}
if (args[0] === "eval") {
  // find the document: `-c <doc>` or `-` (stdin) or a file path
  let doc = null;
  const ci = args.indexOf("-c");
  if (ci !== -1) doc = args[ci + 1];
  else if (args.includes("-")) {
    doc = fs.readFileSync(0, "utf8");
  } else {
    const p = args[args.length - 1];
    if (fs.existsSync(p)) doc = fs.readFileSync(p, "utf8");
  }
  if (doc) {
    const extract = (head) => {
      const re = new RegExp("^" + head + "!?:\\s*$", "m");
      if (!re.test(doc)) return null;
      const out = {};
      const fieldRe = /^\s{2}([a-z0-9-]+):\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/gm;
      let m;
      while ((m = fieldRe.exec(doc))) out[m[1]] = m[2] ?? m[3];
      return out;
    };
    const camel = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
    const tool = extract("tool");
    if (tool) { const arr = readJson("tool-records.json", []); arr.push(camel(tool)); writeJson("tool-records.json", arr); }
    const tp = extract("trusted-publisher");
    if (tp) { const arr = readJson("trusted-publishers.json", []); arr.push(camel(tp)); writeJson("trusted-publishers.json", arr); }
  }
  console.log("committed (stub)");
  process.exit(0);
}
if (args[0] === "query") {
  const concept = args[1];
  if (concept === "tool") { process.stdout.write(JSON.stringify(readJson("tool-records.json", []))); process.exit(0); }
  if (concept === "trusted-publisher") { process.stdout.write(JSON.stringify(readJson("trusted-publishers.json", []))); process.exit(0); }
  process.stdout.write("[]");
  process.exit(0);
}

// ---- scenario responses (prefix match) ------------------------------------
const agentsSet = args[0] === "space" && args[1] === "agents" && args[2] === "set";
if (pendingExit) { /* stdout flush in flight; the callback exits */ }
else if (!agentsSet) { // agents-set waits on stdin above; everything else exits here
  for (const r of scenario.responses ?? []) {
    const match = r.match ?? [];
    if (match.length <= args.length && match.every((t, i) => args[i] === t)) {
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.stdout) process.stdout.write(r.stdout);
      process.exit(r.exit ?? 0);
    }
  }
  process.exit(0);
}
