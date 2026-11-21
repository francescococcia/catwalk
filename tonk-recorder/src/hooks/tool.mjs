#!/usr/bin/env node
// Recorder hook entry point (SPEC §6.3):
//   node tool.mjs hook session-start|pre-agent|post-agent|session-end [--space NAME] [--harness vibe|claude]
//   node tool.mjs instructions            # print the §6.7 decision text
//   node tool.mjs sync [--space NAME]      # run a checkpoint now (SPEC §6.5)
// Reads the harness payload JSON on stdin, writes the hook's stdout JSON.
// Fails open: exit 0 on any internal error (SPEC §4.1).

import fs from "node:fs";
import { parsePayload, formatOutput, normalizeEvent } from "./adapters.mjs";
import { handleEvent, syncNow } from "./core.mjs";
import { resolveSpace } from "./binding.mjs";
import { DECISION_INSTRUCTIONS } from "./instructions.mjs";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i !== -1 ? rest[i + 1] : undefined;
  };

  if (cmd === "instructions") {
    process.stdout.write(DECISION_INSTRUCTIONS);
    return 0;
  }

  if (cmd === "sync") {
    const spaceArg = flag("--space");
    const binding = resolveSpace(process.cwd(), { env, spaceArg });
    if (!binding) return 0; // unbound: nothing to sync
    syncNow(binding.space, env);
    return 0;
  }

  if (cmd === "hook") {
    const eventArg = rest.find((a) => !a.startsWith("--"));
    const raw = readStdin();
    let payload;
    try {
      payload = parsePayload(raw, { cwdFallback: process.cwd() });
    } catch {
      payload = { event: normalizeEvent(eventArg || ""), cwd: process.cwd() };
    }
    if (eventArg) payload.event = normalizeEvent(eventArg);
    if (flag("--harness")) payload.harness = flag("--harness");
    const { code, stdout } = await handleEvent(payload, { env, spaceArg: flag("--space") });
    if (stdout) process.stdout.write(stdout);
    return code;
  }

  process.stderr.write(
    "usage: tool.mjs hook <session-start|pre-agent|post-agent|session-end> [--space NAME] [--harness H]\n" +
      "       tool.mjs instructions | sync [--space NAME]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      // fail open
      process.stderr.write(`tonk-recorder: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 0;
    });
}
