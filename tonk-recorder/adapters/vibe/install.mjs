#!/usr/bin/env node
// adapters/vibe/install.mjs — repo-side CLI for the Vibe adapter (H1).
//
//   node adapters/vibe/install.mjs install   --harness vibe [--home DIR] [--source PATH] [--expect-sha256 SHA] [--version V]
//   node adapters/vibe/install.mjs uninstall --harness vibe [--home DIR]
//   node adapters/vibe/install.mjs status    --harness vibe [--home DIR]
//
// Thin wrapper around tool-side.mjs (the logic that gets packed into the
// single-file tool.mjs stored in the space). The wrapper's
// `install --harness vibe` delegates here (integration point: B0's src/cli
// dispatches per-harness, like adapters/claude/install.mjs for H2).

import { main } from './tool-side.mjs';

main(process.argv.slice(2), process.env).then((code) => process.exit(code));
