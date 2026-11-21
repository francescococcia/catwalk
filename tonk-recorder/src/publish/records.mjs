// B1 record layer — `tool` + `trusted-publisher` records (SPEC §5.4, §5.5).
//
// INTEGRATION POINT: contracts/records.md + packs/recorder.notation (W0/S1, not
// on master yet). Field names below follow SPEC §5.4/§5.5 verbatim; when W0
// lands, align the notation keys and the JSON key reading here.
import { queryJson, field, extractDid, tonkOk } from "../cli/tonk.mjs";

/** Quote a value for the asserted-notation DSL (strings are load-bearing there). */
function q(v) {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Notation document asserting one `tool` record (SPEC §5.4). */
export function buildToolRecordDoc({ name, version, blob, sha256, publisher, publishedAt, changelog }) {
  return [
    "tool!:",
    `  name: ${q(name)}`,
    `  version: ${q(version)}`,
    `  blob: ${blob}`,
    `  sha256: ${q(sha256)}`,
    `  publisher: ${publisher}`,
    `  published-at: ${q(publishedAt)}`,
    `  changelog: ${q(changelog)}`,
    "",
  ].join("\n");
}

/** Notation document asserting one `trusted-publisher` record (SPEC §5.5). */
export function buildTrustedPublisherDoc({ identity, addedAt }) {
  return ["trusted-publisher!:", `  identity: ${identity}`, `  at: ${q(addedAt)}`, ""].join("\n");
}

export async function queryToolRecords(opts = {}) {
  return queryJson(tonkOk, "tool", opts);
}

export async function queryTrustedPublishers(opts = {}) {
  return queryJson(tonkOk, "trusted-publisher", opts);
}

export function isTrustedPublisher(publisher, trustedRecords) {
  if (!publisher) return false;
  return trustedRecords.some((r) => {
    const identity = field(r, "identity") ?? field(r, "id") ?? field(r, "did") ?? field(r, "publisher");
    return identity === publisher;
  });
}

/** Latest tool record by published-at, tie-broken by version. */
export function latestToolRecord(records) {
  if (!records.length) return null;
  const ver = (r) => String(field(r, "version") ?? "");
  const cmp = (a, b) => {
    const ta = String(field(a, "published-at") ?? "");
    const tb = String(field(b, "published-at") ?? "");
    if (ta !== tb) return ta < tb ? -1 : 1;
    const [va, vb] = [ver(a), ver(b)];
    const pa = va.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    const pb = vb.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0;
      const y = pb[i] ?? 0;
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
      return String(x) < String(y) ? -1 : 1;
    }
    return 0;
  };
  return [...records].sort(cmp)[records.length - 1];
}

/** Current writer identity: `tonk identity` → DID. */
export async function currentIdentity(opts = {}) {
  const r = await tonkOk(["identity"], opts);
  return extractDid(r.stdout);
}
