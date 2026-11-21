// src/install/verify.mjs — integrity + authenticity checks for installing
// the recorder logic from the space (SPEC §3.2, §8).
//
//   sha256: content-addressed check of the fetched blob bytes (install
//           --expect-sha256 refuses on mismatch)
//   publisher: the `tool` record's publisher must be in `trusted-publisher`
//
// Integration point: W0's contracts/records.md (not on master yet) fixes the
// exact field notation of `tool` / `trusted-publisher` records as emitted by
// `tonk query <concept> --json` (verified shape against tonk 0.8.0: a JSON
// array of instances, entity refs as "did:key:…" strings, many-valued fields
// as repeated rows sharing `this`). The getters below are deliberately
// tolerant of the plausible spellings until then.
import crypto from 'node:crypto';

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function normalizeSha(s) {
  return String(s ?? '').trim().toLowerCase().replace(/^sha256:/, '');
}

export function shaMatches(buf, expected) {
  const e = normalizeSha(expected);
  return /^[0-9a-f]{64}$/.test(e) && sha256Hex(buf) === e;
}

function pick(row, names) {
  for (const n of names) {
    const v = row?.[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Map one `tonk query tool --json` row to the SPEC §5.4 fields.
export function toolRecordFields(row) {
  return {
    name: pick(row, ['name']),
    version: pick(row, ['version']),
    blob: pick(row, ['blob', 'blobRef', 'blob-ref', 'ref', 'asset']),
    sha256: pick(row, ['sha256', 'sha']),
    publisher: pick(row, ['publisher', 'by', 'author']),
    at: pick(row, ['at', 'publishedAt', 'published_at', 'published']),
  };
}

function cmpVersion(a, b) {
  const pa = String(a ?? '').split(/[.+-]/);
  const pb = String(b ?? '').split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Latest tool record: max by `at`, ties broken by version. Returns
// { row, ...fields } or null.
export function latestToolRecord(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  for (const row of rows) {
    const f = toolRecordFields(row);
    const t = Date.parse(f.at ?? '') || 0;
    if (
      !best ||
      t > best.t ||
      (t === best.t && cmpVersion(f.version, best.version) > 0)
    ) {
      best = { row, ...f, t };
    }
  }
  return best;
}

// Identities from `tonk query trusted-publisher --json` rows.
export function trustedIdentities(rows) {
  const out = new Set();
  for (const r of rows ?? []) {
    const id = pick(r, ['identity', 'did', 'id', 'this', 'entity']);
    if (id) out.add(String(id));
  }
  return out;
}

export function isTrustedPublisher(publisher, identities) {
  return identities.has(String(publisher ?? ''));
}
