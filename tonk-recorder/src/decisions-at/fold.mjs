// R5 fold core (SPEC §7.3): compute "decisions as they stood at a point"
// from the decision log. Works for ANY point on ANY device (the log syncs
// everywhere; signed heads for `tonk restore` do not — §7.2 limit).
//
// Accepted input shapes (auto-detected):
//  1. REAL dev build (tonk-dev 0.6.16-rc.1, PR #1146, verified):
//     `tonk log decision --json` -> { schemaVersion: "tonk.log-changes.v1",
//       rows: [ { version: "<edition>@<origin>", edition, change, entity,
//                 name: "decision/<anchor>", attribute: "tonk.recorder.decision/<field>",
//                 value, supersedes: [] } ] }   (newest first, one row per attribute)
//     `tonk log decision-status --json` and `tonk log change --json` analogous
//     (names "decision-status/…", "change/…").
//  2. W0 fixtures (fixtures/tonk-log/*.json): { revisions: [ { revision,
//     at, decisions: [...], statuses: [...] } ] } (change fixture: changes: []).
//  3. Flat list: [ { type: "decision"|"decision-status"|"change", ... } ].
//
// Normalised model:
//   decisions: [{ id(entity), name, edition, version, at, title, chosen, why,
//                 rejected, supersedes(entity), by, about }]
//   statuses:  [{ id, decision(entity), status, by, at, edition, version }]
//   changes:   [{ id, commit, edition, version, at, session, turn, agent }]
// Point -> { edition?, iso? } filter; fold keeps records within the point,
// drops superseded decisions, applies latest status per decision.

const stripColon = (v) => String(v ?? "").replace(/:$/, "");
const attrField = (attribute, concept) => {
  const prefix = `tonk.recorder.${concept}/`;
  return attribute && attribute.startsWith(prefix) ? attribute.slice(prefix.length) : attribute;
};

/** Normalise any accepted log shape into { decisions, statuses, changes }. */
export function normalizeLog(raw, kind) {
  // kind: "decision" | "decision-status" | "change" — used for rows shape.
  const out = { decisions: [], statuses: [], changes: [] };
  if (!raw) return out;
  // shape 1: real dev rows (tonk.log-changes.v1, verified on tonk-dev; the
  // W0 fixtures carry no `name` — classify by the attribute URI prefix).
  if (Array.isArray(raw.rows)) {
    const byEntity = new Map();
    let seq = 0;
    for (const r of raw.rows) {
      const attr = r.attribute || "";
      let kind = null;
      if (attr.startsWith("tonk.recorder.decision-status/")) kind = "status";
      else if (attr.startsWith("tonk.recorder.decision/")) kind = "decision";
      else if (attr.startsWith("tonk.recorder.change-file/")) kind = null; // lens rows: skip
      else if (attr.startsWith("tonk.recorder.change/")) kind = "change";
      if (!kind) continue;
      if (r.change && r.change !== "assert") continue; // retract rows handled as absence (add-only model)
      const key = `${kind}|${r.entity}`;
      if (!byEntity.has(key)) {
        byEntity.set(key, { kind, name: r.name, entity: r.entity, version: r.version, edition: r.edition, fields: {} });
      }
      const rec = byEntity.get(key);
      rec.fields[attr.slice(attr.lastIndexOf("/") + 1)] = r.value;
      rec.seq = seq++;
    }
    for (const rec of byEntity.values()) {
      const base = { id: rec.entity, name: rec.name, edition: rec.edition, version: rec.version, seq: rec.seq, ...rec.fields };
      if (rec.kind === "status") out.statuses.push({ ...base, status: stripColon(base.status) });
      else if (rec.kind === "decision") out.decisions.push(base);
      else out.changes.push(base);
    }
    return out;
  }
  // shape 2: W0 fixture revisions[]
  if (Array.isArray(raw.revisions)) {
    let seq = 0;
    for (const rev of raw.revisions) {
      const base = { edition: rev.edition ?? parseInt(String(rev.revision).split("@")[0], 10), version: rev.revision, at: rev.at };
      for (const d of rev.decisions || []) out.decisions.push({ ...base, ...d, id: d.this || d.id, seq: seq++ });
      for (const s of rev.statuses || []) out.statuses.push({ ...base, ...s, status: stripColon(s.status), seq: seq++ });
      for (const c of rev.changes || []) out.changes.push({ ...base, ...c, id: c.this || c.id, seq: seq++ });
    }
    return out;
  }
  // shape 3: flat typed list
  if (Array.isArray(raw)) {
    let seq = 0;
    for (const e of raw) {
      const base = { edition: e.edition ?? parseInt(String(e.revision || "0").split("@")[0], 10), version: e.revision, seq: seq++ };
      if (e.type === "decision") out.decisions.push({ ...base, ...e, id: e.id || e.this });
      else if (e.type === "decision-status") out.statuses.push({ ...base, ...e, status: stripColon(e.status) });
      else if (e.type === "change") out.changes.push({ ...base, ...e, id: e.id || e.this });
    }
  }
  return out;
}

/** Parse a --at point: "<edition>@<origin>" | ISO-8601 time | git commit sha/ref. */
export function parsePoint(str) {
  if (typeof str !== "string" || !str.trim()) throw new Error("empty --at point");
  str = str.trim();
  if (/^\d+@\S+$/.test(str)) {
    const [edition, origin] = str.split("@");
    return { kind: "revision", revision: str, edition: parseInt(edition, 10), origin };
  }
  if (/^[0-9a-fA-F]{7,40}$/.test(str)) return { kind: "commit", commit: str.toLowerCase() };
  const t = Date.parse(str);
  if (!Number.isNaN(t)) return { kind: "time", iso: new Date(t).toISOString() };
  return { kind: "commit", commit: str }; // branch/tag — resolved via git in cwd
}

/** Resolve a point to { edition?, iso?, version? } using the merged logs. */
export function resolvePoint(model, point, { resolveRef } = {}) {
  if (point.kind === "revision") {
    // prefer an exact version match in the log
    const all = [...model.decisions, ...model.statuses, ...model.changes];
    const hit = all.find((r) => r.version === point.revision);
    return { edition: hit ? hit.edition : point.edition, iso: null, version: point.revision };
  }
  if (point.kind === "time") return { edition: null, iso: point.iso, version: null };
  // commit: resolve through the change record that carries it (SPEC §7.3)
  let sha = point.commit;
  if (!/^[0-9a-f]{40}$/.test(sha) && resolveRef) {
    const full = resolveRef(sha);
    if (full) sha = full.toLowerCase();
  }
  let hit = null;
  for (const c of model.changes) {
    if (c.commit && (c.commit === sha || c.commit.startsWith(sha) || sha.startsWith(c.commit))) {
      if (!hit || (c.edition ?? -Infinity) >= (hit.edition ?? -Infinity)) hit = c; // latest revision carrying the commit
    }
  }
  if (!hit) throw new Error(`no change record carries commit ${point.commit}`);
  return { edition: hit.edition, iso: null, version: hit.version };
}

const within = (rec, point) =>
  (point.edition == null || (rec.edition ?? -Infinity) <= point.edition) &&
  (point.iso == null || !rec.at || String(rec.at) <= point.iso);

/**
 * Fold: decisions at-or-before the point, minus those superseded by then,
 * each with its status at that point (latest status within the point;
 * default 'accepted' — SPEC §11.8 hand-added default).
 */
export function foldDecisions(model, point, { defaultStatus = "accepted" } = {}) {
  const decisions = model.decisions.filter((d) => within(d, point));
  const statuses = model.statuses.filter((s) => within(s, point));
  const superseded = new Set(
    decisions.map((d) => d.supersedes).filter(Boolean),
  );
  const statusByDecision = new Map();
  for (const s of statuses) {
    const key = s.decision || s.id;
    const prev = statusByDecision.get(key);
    if (!prev || (s.edition ?? 0) > (prev.edition ?? 0) || ((s.edition ?? 0) === (prev.edition ?? 0) && String(s.at) >= String(prev.at))) {
      statusByDecision.set(key, s);
    }
  }
  return decisions
    .filter((d) => !superseded.has(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      title: d.title,
      chosen: d.chosen,
      why: d.why,
      rejected: d.rejected,
      about: d.about,
      supersedes: d.supersedes || null,
      by: d.by,
      at: d.at,
      version: d.version,
      status: (statusByDecision.get(d.id) || {}).status || defaultStatus,
    }));
}
