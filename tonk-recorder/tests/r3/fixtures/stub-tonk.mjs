#!/usr/bin/env node
// Stub `tonk` CLI for offline hook tests. Selected via TONK_BIN.
// Logs every invocation as one JSON line {argv, stdin} to $STUB_LOG.
//   eval ...            -> appends stdin doc to $STUB_EVALS; exits $STUB_EVAL_CODE
//                          (default 0; set STUB_EVAL_FAIL_TIMES=N to fail the
//                          first N evals with exit 4 = revision.lock collision)
//   query <c> --json    -> prints $STUB_QUERY_DIR/<c>.json (or [])
//   blob add <f>        -> prints blob:stub<sha1>
//   pull / push         -> exit $STUB_SYNC_CODE (default 0)
//   log ... --json      -> prints $STUB_LOG_JSON file
//   restore ...         -> exit 1 'unavailable' unless revision in $STUB_RESTORE_OK
//   anything else       -> exit 0
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, stdin }) + "\n");

const cmd = argv.filter((a) => !a.startsWith("--")).filter((a, i, arr) => true);
const joined = argv.join(" ");

if (joined.includes(" eval ")) {
  if (process.env.STUB_EVALS) appendFileSync(process.env.STUB_EVALS, stdin + "\n---\n");
  const fails = Number(process.env.STUB_EVAL_FAIL_TIMES || 0);
  const countFile = process.env.STUB_EVALS + ".count";
  let n = 0;
  try { n = Number(readFileSync(countFile, "utf8").trim() || 0); } catch {}
  appendFileSync(countFile, String(n + 1) + "\n");
  if (n < fails) {
    process.stderr.write("error: revision.lock is held by another process\n");
    process.exit(4);
  }
  process.stdout.write("committed (stub)\n");
  process.exit(0);
}
if (joined.includes(" query ")) {
  const c = argv[argv.indexOf("query") + 1];
  const f = process.env.STUB_QUERY_DIR ? `${process.env.STUB_QUERY_DIR}/${c}.json` : null;
  let rows = f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  // honour --where field=value (AND equality on string fields)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--where" && argv[i + 1]) {
      const [k, v] = argv[i + 1].split("=");
      rows = rows.filter((r) => String(r[k]) === v);
    }
  }
  process.stdout.write(JSON.stringify(rows) + "\n");
  process.exit(0);
}
if (joined.includes(" blob add ")) {
  const f = argv[argv.length - 1];
  const h = createHash("sha1").update(readFileSync(f)).digest("hex").slice(0, 16);
  process.stdout.write(`blob:stub${h}\n`);
  process.exit(0);
}
if (joined.includes(" pull") || joined.includes(" push")) {
  process.exit(Number(process.env.STUB_SYNC_CODE || 0));
}
if (joined.includes(" log ") && joined.includes("--json")) {
  if (process.env.STUB_LOG_JSON && existsSync(process.env.STUB_LOG_JSON)) {
    process.stdout.write(readFileSync(process.env.STUB_LOG_JSON, "utf8"));
  } else {
    process.stdout.write("[]\n");
  }
  process.exit(0);
}
if (joined.includes(" restore ")) {
  const rev = argv[argv.indexOf("--revision") + 1] || "";
  if ((process.env.STUB_RESTORE_OK || "").split(",").includes(rev)) {
    process.stdout.write("available\n");
    process.exit(0);
  }
  process.stderr.write(`unavailable: signed head for ${rev} is not local\n`);
  process.exit(1);
}
process.exit(0);
