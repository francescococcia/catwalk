// B1 — `<wrapper> publish` (SPEC §3.1 step 3, §3.4, §9.2 B1).
//
// Flow: verify publisher trust (unless marking the creator at `new`) →
// `tonk blob add` the logic file → assert the `tool` record (name, version,
// blob ref, sha256, publisher, published at, changelog — SPEC §5.4) → optionally
// assert `trusted-publisher` for the creator (§5.5) → write the bootstrap block
// + decision instructions into the space AGENTS.md via `tonk space agents
// get/set`, preserving any other content (§3.1).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tonkOk, extractDid } from "../cli/tonk.mjs";
import { PKG_NAME } from "../cli/paths.mjs";
import {
  buildToolRecordDoc,
  buildTrustedPublisherDoc,
  queryTrustedPublishers,
  isTrustedPublisher,
  currentIdentity,
} from "./records.mjs";
import { bootstrapBlock, mergeAgentsMd } from "./bootstrap.mjs";

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * @param {object} o
 * @param {string} o.file        logic file to publish (the self-contained tool.mjs)
 * @param {string} [o.version]   defaults to the wrapper package version
 * @param {string} [o.changelog] one-line changelog for the tool record
 * @param {string} [o.name]      tool record name (default tonk-recorder)
 * @param {boolean} [o.markCreatorTrusted]  `new` passes true: assert the current
 *   identity as trusted-publisher as part of this publish (SPEC §3.1 step 3).
 *   `publish` passes false and instead REQUIRES existing trust (SPEC §8:
 *   write access ≠ publish access).
 * @param {string} [o.instructionsText]  decision-instructions text for AGENTS.md
 *   (R4 contract; integration point instructions/decisions.md).
 */
export async function publishLogic({
  file,
  version,
  changelog,
  name = PKG_NAME,
  markCreatorTrusted = false,
  instructionsText = "",
  env = process.env,
  cwd,
} = {}) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`publish: logic file not found: ${file} (run the build first)`);
  }
  const opts = { env, cwd };
  const ver = version ?? JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const log = changelog ?? `v${ver}: published recorder logic`;
  const publishedAt = new Date().toISOString();

  // 1. identity of the writer (attached by tonk to the records themselves; we
  //    only need the DID for the tool record's publisher field + trust gate).
  const publisher = await currentIdentity(opts);

  // 2. trust gate (SPEC §8): only trusted publishers may change the recorder.
  if (!markCreatorTrusted) {
    const trusted = await queryTrustedPublishers(opts);
    if (!isTrustedPublisher(publisher, trusted)) {
      const err = new Error(
        `publish refused: ${publisher} is not in this space's trusted-publisher records (SPEC §8). ` +
          "Ask the space owner to add you, then retry.",
      );
      err.exitCode = 1;
      throw err;
    }
  }

  // 3+4. read the logic bytes ONCE (a concurrent rebuild of dist/ must not
  // split the blob from its sha256), stage a stable copy, blob-add that, and
  // hash the same bytes (install verifies against this, SPEC §8).
  const bytes = fs.readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const tmp = path.join(os.tmpdir(), `tonk-recorder-publish-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, bytes);
  let blobRef;
  try {
    const blobRes = await tonkOk(["blob", "add", tmp], opts);
    // 0.8.0 prints `asset:<hash>`; the SPEC spelling is `blob:` (blob cat reads both)
    const m = blobRes.stdout.match(/(?:blob|asset):[A-Za-z0-9._-]+/);
    if (!m) {
      const err = new Error(`publish: could not parse blob ref from \`tonk blob add\` output: ${blobRes.stdout.trim()}`);
      err.exitCode = 1;
      throw err;
    }
    blobRef = "blob:" + m[0].split(":")[1];
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }

  // 5. mark the creator as trusted publisher (at `new` only, SPEC §3.1 step 3).
  if (markCreatorTrusted) {
    await tonkOk(["eval", "--no-sync", "-c", buildTrustedPublisherDoc({ identity: publisher, addedAt: publishedAt })], opts);
  }

  // 6. assert the `tool` record (SPEC §5.4). --no-sync: records go to the local
  //    copy; the next checkpoint (`sync`) pushes (SPEC §6.4/§6.5).
  const toolDoc = buildToolRecordDoc({ name, version: ver, blob: blobRef, sha256, publisher, publishedAt, changelog: log });
  await tonkOk(["eval", "--no-sync", "-c", toolDoc], opts);

  // 7. write the bootstrap block + decision instructions into the space
  //    AGENTS.md, preserving any other content (SPEC §3.1 step 3).
  let existing = "";
  const got = await tonkOk(["space", "agents", "get"], opts).catch(() => null);
  if (got) existing = got.stdout;
  const merged = mergeAgentsMd(existing, {
    bootstrap: bootstrapBlock({ version: ver, blobRef, sha256 }),
    instructions: instructionsText,
  });
  await tonkOk(["space", "agents", "set", "-"], { ...opts, input: merged });

  return { name, version: ver, blobRef, sha256, publisher, publishedAt, changelog: log };
}
