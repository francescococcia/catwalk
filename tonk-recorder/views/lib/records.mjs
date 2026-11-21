// views/lib/records.mjs — load + normalise fixture `change` records
// (SPEC §5.1). The record shape below is the JSON mirror of the `change`
// concept; it is the integration point with W0's fixtures/ and
// contracts/records.md (not landed yet — built against SPEC §5.1 text).
//
// Expected JSON per file in the input directory:
// {
//   id?, session?, turn?, parentSession?, agent, harness?,
//   prompt, response?, project?, branch?, base?, head?, commit?,
//   files: [{ path, status?, added?, removed? }],   // status: added|modified|deleted|renamed
//   linesAdded?, linesRemoved?,                      // default: summed from files
//   diff?, diffBlob?,                                // inline ≤64KB else blob:<hash>
//   redacted?, at                                    // ISO timestamp
// }

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'];

export class RecordError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.name = 'RecordError';
    this.file = file;
  }
}

/** First line of a (possibly multi-line) prompt. */
export function promptFirstLine(prompt) {
  const first = String(prompt ?? '').split('\n', 1)[0] ?? '';
  return first.trim();
}

/** Normalise one raw record; throws RecordError on missing required fields. */
export function normalizeChange(raw, file = '<record>') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RecordError(file, 'record is not a JSON object');
  }
  const rec = { ...raw };
  rec.id = rec.id ?? (rec.session && rec.turn ? `${rec.session}:${rec.turn}` : undefined);
  for (const key of ['id', 'agent', 'prompt', 'files', 'at']) {
    if (rec[key] === undefined || rec[key] === null || rec[key] === '') {
      throw new RecordError(file, `missing required field "${key}"`);
    }
  }
  if (!Array.isArray(rec.files)) throw new RecordError(file, '"files" must be an array');
  rec.files = rec.files.map((f, i) => {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string' || f.path === '') {
      throw new RecordError(file, `files[${i}] missing "path"`);
    }
    return {
      path: f.path,
      status: FILE_STATUSES.includes(f.status) ? f.status : 'modified',
      added: Number.isFinite(f.added) ? f.added : 0,
      removed: Number.isFinite(f.removed) ? f.removed : 0,
    };
  });
  rec.linesAdded = Number.isFinite(rec.linesAdded) ? rec.linesAdded : rec.files.reduce((s, f) => s + f.added, 0);
  rec.linesRemoved = Number.isFinite(rec.linesRemoved) ? rec.linesRemoved : rec.files.reduce((s, f) => s + f.removed, 0);
  rec.redacted = rec.redacted === true;
  rec.harness = rec.harness ?? '';
  rec.diff = typeof rec.diff === 'string' ? rec.diff : null;
  rec.diffBlob = typeof rec.diffBlob === 'string' ? rec.diffBlob : null;
  return rec;
}

function timeOf(rec) {
  const t = Date.parse(rec.at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Load every *.json file in `dir` as a change record, newest first
 * (by `at`; ties broken by id). Throws RecordError naming the bad file.
 */
export function loadChanges(dir) {
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const records = names.map((n) => normalizeChange(JSON.parse(readFileSync(join(dir, n), 'utf8')), n));
  records.sort((a, b) => timeOf(b) - timeOf(a) || String(a.id).localeCompare(String(b.id)));
  return records;
}

/** Filesystem-safe filename for a change id (keeps the mapping readable). */
export function slugFor(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}
