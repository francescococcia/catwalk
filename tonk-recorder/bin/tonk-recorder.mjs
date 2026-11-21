#!/usr/bin/env node
// tonk-recorder bin shim — all logic lives in src/cli/main.mjs.
// The wrapper ALWAYS calls its own pinned @tonk/cli as a child process
// (TONK_BIN overrides for dev/branch builds) — never whatever is on PATH
// (SPEC §2). Resolution happens in src/cli/tonk.mjs.
import { main } from "../src/cli/main.mjs";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(`tonk-recorder: ${err && err.message ? err.message : err}`);
    process.exitCode = err && err.exitCode ? err.exitCode : 1;
  });
