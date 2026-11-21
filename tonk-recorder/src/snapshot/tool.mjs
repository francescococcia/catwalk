// R1 — Snapshot + diff + secret scan. PURE: no tonk, no network, no imports
// outside node builtins. Self-contained so it can ship inside the single
// dist/tool.mjs (SPEC §2, AGENTS.md rule 5).
//
// Snapshot model (SPEC §6.2): a snapshot is a git *tree* built with a
// temporary index, so it includes untracked files, honours .gitignore, and
// never touches the user's index, stash or branches:
//
//   GIT_INDEX_FILE="$PLUGIN_DATA/index" git add -A
//   GIT_INDEX_FILE="$PLUGIN_DATA/index" git write-tree
//
// Diff/numstat/statuses are computed between two such trees with
// `git diff -M` (rename detection). Diffs ≤ 64 KB go inline into the change
// record; larger ones become a blob reference (SPEC §5.1, §11.2).
//
// Secret scan (SPEC §6.6): private-key blocks, sk-…/AKIA…-style tokens,
// password= assignments and high-entropy strings in .env-like files are
// replaced with [redacted] and redacted=true is set on the record.
//
// CLI (used by tests and by src/hooks):
//   node tool.mjs snapshot <dir> <indexPath>           -> prints tree hash
//   node tool.mjs diff <dir> <prevTree> <nextTree> [--json] [--no-diff]
//   node tool.mjs scan [--file <path>] [--json|--text]  (reads stdin)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Inline-vs-blob split for diffs (SPEC §5.1 / open decision §11.2, default 64 KB). */
export const INLINE_DIFF_LIMIT = 64 * 1024;

const MAX_BUFFER = 256 * 1024 * 1024;

function git(dir, args, extraEnv = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"], // never leak git's stderr into the hook
    env: { ...process.env, ...extraEnv },
  });
}

/**
 * Build a snapshot tree of `dir` using the temporary index at `indexPath`.
 * Exactly SPEC §6.2. `indexPath` must live OUTSIDE the worktree (it is
 * PLUGIN_DATA/index in production); if it is inside, git will happily
 * snapshot it too — caller's responsibility, same as SPEC.
 * Returns the tree hash (40-hex).
 */
export function snapshotTree(dir, indexPath) {
  fs.mkdirSync(path.dirname(path.resolve(indexPath)), { recursive: true });
  const env = { GIT_INDEX_FILE: path.resolve(indexPath) };
  git(dir, ["add", "-A"], env);
  return git(dir, ["write-tree"], env).trim();
}

/** Is `dir` inside a git work tree? */
export function isGitRepo(dir) {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Current branch name, or "HEAD" when detached. null when not a repo. */
export function currentBranch(dir) {
  try {
    return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || null;
  } catch {
    // a repository with no commits yet (fresh `git init`) has no HEAD to parse
    try {
      return git(dir, ["symbolic-ref", "--short", "HEAD"]).trim() || null;
    } catch {
      return null;
    }
  }
}

/** HEAD commit (the turn sat on this commit — links code point to space revision). */
export function headCommit(dir) {
  try {
    return git(dir, ["rev-parse", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

/** Project label: git remote origin basename (no .git), else dir name (SPEC §5.1). */
export function projectName(dir) {
  try {
    const url = git(dir, ["remote", "get-url", "origin"]).trim();
    if (url) {
      const base = url.split("/").pop() || url;
      return base.replace(/\.git$/, "");
    }
  } catch {
    /* no origin */
  }
  return path.basename(path.resolve(dir));
}

function parseNameStatusZ(raw) {
  // `git diff -M --name-status -z` -> tokens: STATUS \0 path \0 [path2 \0 for R/C]
  const tokens = raw.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (!status) { i++; continue; }
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      entries.push({ status: letter, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      entries.push({ status: letter, path: tokens[i + 1] });
      i += 2;
    }
  }
  return entries;
}

function parseNumstatZ(raw) {
  // `git diff -M --numstat -z` -> records: "added\tdeleted\tpath" \0
  // For renames the path field is empty and is followed by old \0 new \0.
  const tokens = raw.split("\0");
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const rec = tokens[i];
    if (!rec) { i++; continue; }
    const parts = rec.split("\t");
    const added = parts[0];
    const removed = parts[1];
    const p = parts.slice(2).join("\t");
    if (p === "") {
      // rename: next two tokens are old and new path
      out.push({ added, removed, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      out.push({ added, removed, path: p });
      i += 1;
    }
  }
  return out;
}

const STATUS_MAP = { A: "added", M: "modified", D: "deleted", T: "modified", R: "renamed", C: "copied", U: "modified" };

/**
 * Diff two snapshot trees. Returns:
 * {
 *   files: [{ path, oldPath?, status, added, removed }],  // added/removed: int|null ("-" binary -> null)
 *   diff: string,            // full `git diff -M` text
 *   empty: boolean,
 *   totals: { added, removed }
 * }
 */
export function diffTrees(dir, prevTree, nextTree) {
  const ns = parseNameStatusZ(git(dir, ["diff", "-M", "--name-status", "-z", prevTree, nextTree]));
  const num = parseNumstatZ(git(dir, ["diff", "-M", "--numstat", "-z", prevTree, nextTree]));
  const diff = git(dir, ["diff", "-M", prevTree, nextTree]);

  const numByKey = new Map();
  for (const n of num) {
    numByKey.set(n.oldPath !== undefined ? `${n.oldPath}\0${n.path}` : n.path, n);
  }

  const files = ns.map((e) => {
    const status = STATUS_MAP[e.status] || "modified";
    const key = e.status === "R" || e.status === "C" ? `${e.oldPath}\0${e.path}` : e.path;
    const n = numByKey.get(key) || {};
    const toInt = (v) => (v === "-" || v === undefined ? null : parseInt(v, 10));
    return {
      path: e.path,
      ...(e.oldPath !== undefined ? { oldPath: e.oldPath } : {}),
      status,
      added: toInt(n.added),
      removed: toInt(n.removed),
    };
  });

  const totals = files.reduce(
    (acc, f) => ({
      added: acc.added + (f.added || 0),
      removed: acc.removed + (f.removed || 0),
    }),
    { added: 0, removed: 0 },
  );

  return { files, diff, empty: files.length === 0, totals };
}

/**
 * SPEC §5.1 / §11.2: diffs ≤ INLINE_DIFF_LIMIT bytes go inline into the
 * record; larger ones are returned as inline:false so the caller runs
 * `tonk blob add` and stores the blob ref instead.
 */
export function splitDiff(diffText, limit = INLINE_DIFF_LIMIT) {
  const size = Buffer.byteLength(diffText, "utf8");
  return { inline: size <= limit, size, diff: diffText };
}

// ---------------------------------------------------------------------------
// Secret scan (SPEC §6.6)
// ---------------------------------------------------------------------------

export const REDACTED = "[redacted]";

const RE_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[^\n]*\n[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
const RE_SK_TOKEN = /\bsk-(?:ant-)?[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g;
const RE_AWS_KEY = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const RE_GH_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const RE_SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
// password= / password: assignments (SPEC §6.6). Value may be quoted.
const RE_PASSWORD =
  /\b(password|passwd|pwd)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;

/** Shannon entropy in bits/char. */
export function shannonEntropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER_VALUES = new Set([
  "changeme", "change-me", "changeit", "example", "placeholder", "xxx", "xxxx",
  "todo", "none", "null", "true", "false", "redacted", "[redacted]",
]);

/** High-entropy value worth redacting in a .env-like file. */
export function isHighEntropySecret(value) {
  const v = value.replace(/^["']|["']$/g, "");
  if (v.length < 16) return false;
  if (/\s/.test(v)) return false;
  if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return false;
  // require a mix suggesting a real token (letters + digits/symbols), not a plain word
  if (!(/[A-Za-z]/.test(v) && /[0-9+/=_\-.]/.test(v))) return false;
  return shannonEntropy(v) >= 3.5;
}

const ENV_LIKE = /(^|\/)\.env(\.|$)/;

/**
 * Scan a diff for secrets (SPEC §6.6). Returns
 * { text, redacted, matches: [{ kind, file? }] }.
 * `text` has every match replaced with [redacted]; `redacted` is true when
 * anything was replaced (goes on the change record as redacted: true).
 *
 * Per-file .env handling: the diff is split into per-file sections
 * (diff --git …); in sections whose file is .env-like, added KEY=value lines
 * with high-entropy values are redacted.
 */
export function scanSecrets(diffText) {
  const matches = [];

  // 1) per-file .env-like high-entropy scan on added lines
  const sections = diffText.split(/(?=^diff --git )/m);
  let text = sections
    .map((section) => {
      const m = section.match(/^\+\+\+ b\/(.+)$/m);
      const file = m ? m[1] : null;
      if (!file || !ENV_LIKE.test(file)) return section;
      return section
        .split("\n")
        .map((line) => {
          const kv = line.match(/^\+([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/);
          if (!kv) return line;
          if (!isHighEntropySecret(kv[2])) return line;
          matches.push({ kind: "high-entropy-env", file });
          return `+${kv[1]}=${REDACTED}`;
        })
        .join("\n");
    })
    .join("");

  // 2) global token patterns
  const patterns = [
    ["private-key-block", RE_PRIVATE_KEY],
    ["sk-token", RE_SK_TOKEN],
    ["aws-access-key", RE_AWS_KEY],
    ["github-token", RE_GH_TOKEN],
    ["slack-token", RE_SLACK_TOKEN],
  ];
  for (const [kind, re] of patterns) {
    text = text.replace(re, () => {
      matches.push({ kind });
      return REDACTED;
    });
  }

  // 3) password= assignments — keep the key, redact the value
  text = text.replace(RE_PASSWORD, (match, key, sep) => {
    matches.push({ kind: "password-assignment" });
    return `${key}${sep}${REDACTED}`;
  });

  return { text, redacted: matches.length > 0, matches };
}

/** Scan a single file's contents (e.g. a .env file directly). */
export function scanTextSecrets(text) {
  const matches = [];
  let out = text.replace(RE_PRIVATE_KEY, () => (matches.push({ kind: "private-key-block" }), REDACTED));
  out = out.replace(RE_SK_TOKEN, () => (matches.push({ kind: "sk-token" }), REDACTED));
  out = out.replace(RE_AWS_KEY, () => (matches.push({ kind: "aws-access-key" }), REDACTED));
  out = out.replace(RE_PASSWORD, (m, key, sep) => (matches.push({ kind: "password-assignment" }), `${key}${sep}${REDACTED}`));
  out = out
    .split("\n")
    .map((line) => {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/);
      if (!kv || !isHighEntropySecret(kv[2])) return line;
      matches.push({ kind: "high-entropy-env" });
      return `${kv[1]}=${REDACTED}`;
    })
    .join("\n");
  return { text: out, redacted: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "snapshot") {
    const [dir, indexPath] = rest;
    process.stdout.write(snapshotTree(dir, indexPath) + "\n");
    return 0;
  }
  if (cmd === "diff") {
    const [dir, prev, next] = rest;
    const asJson = rest.includes("--json");
    const noDiff = rest.includes("--no-diff");
    const d = diffTrees(dir, prev, next);
    if (asJson) {
      const out = { ...d };
      if (noDiff) delete out.diff;
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    } else {
      process.stdout.write(d.diff);
    }
    return 0;
  }
  if (cmd === "scan") {
    const input = fs.readFileSync(0, "utf8");
    const r = scanSecrets(input);
    if (rest.includes("--text")) process.stdout.write(r.text);
    else process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return 0;
  }
  process.stderr.write(
    "usage: tool.mjs snapshot <dir> <indexPath> | diff <dir> <prev> <next> [--json] [--no-diff] | scan [--text]\n",
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
