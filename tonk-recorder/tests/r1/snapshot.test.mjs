// R1 tests — pure git fixture repos, fully offline (SPEC §9.2 R1 done-when:
// untracked file appears, gitignored file never appears, user's
// index/stash/HEAD untouched, fake secret redacted, renamed detected).
//
// Run: node --test tests/r1/

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  snapshotTree,
  diffTrees,
  splitDiff,
  scanSecrets,
  scanTextSecrets,
  isGitRepo,
  currentBranch,
  headCommit,
  projectName,
  INLINE_DIFF_LIMIT,
  REDACTED,
} from "../../src/snapshot/tool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env },
  });
}

/** Create a fresh fixture repo in a tmp dir. Returns { dir, data } where
 *  `data` is a PLUGIN_DATA-like dir OUTSIDE the repo (as in production). */
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r1-repo-"));
  const dir = path.join(root, "proj");
  const data = path.join(root, "plugin-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, data, index: path.join(data, "index") };
}

function commitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", msg]);
}

test("snapshot includes untracked files and honours .gitignore", (t) => {
  const { dir, index } = makeRepo(t);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "hello\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n*.log\n.env\n");
  commitAll(dir, "init");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n"); // untracked, not ignored
  fs.writeFileSync(path.join(dir, "ignored.txt"), "nope\n"); // ignored
  fs.writeFileSync(path.join(dir, "debug.log"), "nope\n"); // ignored
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=abc\n"); // ignored

  const tree = snapshotTree(dir, index);
  const files = git(dir, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
  assert.ok(files.includes("untracked.txt"), `untracked file must appear: ${files}`);
  assert.ok(files.includes("tracked.txt"));
  assert.ok(files.includes(".gitignore"));
  assert.ok(!files.includes("ignored.txt"), "gitignored file must never appear");
  assert.ok(!files.includes("debug.log"), "gitignored *.log must never appear");
  assert.ok(!files.includes(".env"), "gitignored .env must never appear");
});

test("snapshot never touches user's index, stash or HEAD", (t) => {
  const { dir, index } = makeRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  commitAll(dir, "init");
  // user stages something and creates a stash
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["stash", "push", "-q", "-m", "wip"]);
  git(dir, ["add", "a.txt"]); // re-stage after stash push reset the worktree copy

  // modify the worktree, then capture the user's git state BEFORE snapshotting
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "new file\n");
  const indexBefore = fs.readFileSync(path.join(dir, ".git", "index"));
  const headBefore = git(dir, ["rev-parse", "HEAD"]).trim();
  const stashListBefore = git(dir, ["stash", "list"]).trim();
  const statusBefore = git(dir, ["status", "--porcelain"]).trim();

  const tree = snapshotTree(dir, index);

  assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), headBefore, "HEAD untouched");
  assert.equal(git(dir, ["stash", "list"]).trim(), stashListBefore, "stash untouched");
  assert.equal(git(dir, ["status", "--porcelain"]).trim(), statusBefore, "user index untouched");
  assert.ok(fs.readFileSync(path.join(dir, ".git", "index")).equals(indexBefore), "index bytes identical");
  assert.ok(tree.match(/^[0-9a-f]{40}$/));
  // the snapshot saw the workdir state (a.txt with three lines + b.txt)
  const aBlob = git(dir, ["ls-tree", tree, "a.txt"]).trim().split(/\s+/)[2];
  assert.equal(git(dir, ["cat-file", "-p", aBlob]).trim(), "one\ntwo\nthree");
  assert.ok(git(dir, ["ls-tree", "-r", "--name-only", tree]).includes("b.txt"));
});

test("diff between snapshots: statuses, numstat, rename detection", (t) => {
  const { dir, index } = makeRepo(t);
  fs.writeFileSync(path.join(dir, "keep.txt"), "k\n");
  fs.writeFileSync(path.join(dir, "mod.txt"), "a\nb\n");
  fs.writeFileSync(path.join(dir, "del.txt"), "gone\n");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "old.txt"), "rename me\n");
  commitAll(dir, "init");
  const t1 = snapshotTree(dir, index);

  fs.writeFileSync(path.join(dir, "mod.txt"), "a\nb\nc\n"); // modified +1
  fs.rmSync(path.join(dir, "del.txt")); // deleted
  fs.renameSync(path.join(dir, "sub", "old.txt"), path.join(dir, "sub", "new.txt")); // renamed
  fs.writeFileSync(path.join(dir, "added.txt"), "brand new\n"); // added
  const t2 = snapshotTree(dir, index);

  const d = diffTrees(dir, t1, t2);
  assert.equal(d.empty, false);
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
  assert.equal(byPath["added.txt"].status, "added");
  assert.equal(byPath["added.txt"].added, 1);
  assert.equal(byPath["mod.txt"].status, "modified");
  assert.equal(byPath["mod.txt"].added, 1);
  assert.equal(byPath["mod.txt"].removed, 0);
  assert.equal(byPath["del.txt"].status, "deleted");
  assert.equal(byPath["sub/new.txt"].status, "renamed");
  assert.equal(byPath["sub/new.txt"].oldPath, "sub/old.txt");
  assert.equal(d.totals.added, 2); // mod.txt +1, added.txt +1 (rename is 0/0)
  assert.equal(d.totals.removed, 1); // del.txt "gone\n"
  assert.match(d.diff, /rename from sub\/old\.txt/);
  assert.match(d.diff, /rename to sub\/new\.txt/);

  // identical trees -> empty diff
  const t3 = snapshotTree(dir, index);
  const d2 = diffTrees(dir, t2, t3);
  assert.equal(d2.empty, true);
  assert.equal(d2.files.length, 0);
  assert.equal(d2.diff, "");
});

test("64 KB inline-vs-blob split", () => {
  const small = "x".repeat(INLINE_DIFF_LIMIT);
  assert.equal(splitDiff(small).inline, true);
  assert.equal(splitDiff(small).size, INLINE_DIFF_LIMIT);
  const big = "x".repeat(INLINE_DIFF_LIMIT + 1);
  const r = splitDiff(big);
  assert.equal(r.inline, false);
  assert.equal(r.size, INLINE_DIFF_LIMIT + 1);
});

test("secret scan redacts private keys, sk-/AKIA tokens, password=, .env entropy", (t) => {
  const { dir } = makeRepo(t);
  const privKey = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA7fakefakefakefakefakefakefake",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const diff = [
    "diff --git a/key.pem b/key.pem",
    "+++ b/key.pem",
    "+" + privKey.split("\n")[0],
    "+" + privKey.split("\n")[1],
    "+" + privKey.split("\n")[2],
    "diff --git a/app.js b/app.js",
    "+++ b/app.js",
    "+const key = \"sk-abc123def456ghi789\";",
    "+const aws = 'AKIAIOSFODNN7EXAMPLE';",
    "+const cfg = { password: \"hunter2secret\" };",
    "diff --git a/.env b/.env",
    "+++ b/.env",
    "+API_TOKEN=Zx9Qw8Er7Ty6Ui5Op3As1Df4Gh6Jk2L",
    "+PLAIN=hello",
    "",
  ].join("\n");

  const r = scanSecrets(diff);
  assert.equal(r.redacted, true);
  assert.ok(!r.text.includes("MIIEpAIBAAKCAQEA7fake"), "private key body gone");
  assert.ok(!r.text.includes("sk-abc123def456ghi789"), "sk- token gone");
  assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"), "AKIA gone");
  assert.ok(!r.text.includes("hunter2secret"), "password value gone");
  assert.ok(!r.text.includes("Zx9Qw8Er7Ty6Ui5Op3As1Df4Gh6Jk2L"), "high-entropy .env value gone");
  assert.ok(r.text.includes(REDACTED), "redaction marker present");
  assert.ok(r.text.includes("+PLAIN=hello"), "low-entropy .env value kept");
  assert.ok(r.text.includes("password:"), "password key kept");
  const kinds = r.matches.map((m) => m.kind);
  for (const k of ["private-key-block", "sk-token", "aws-access-key", "password-assignment", "high-entropy-env"]) {
    assert.ok(kinds.includes(k), `match kind ${k}`);
  }
  const envMatch = r.matches.find((m) => m.kind === "high-entropy-env");
  assert.equal(envMatch.file, ".env");

  // clean diff -> redacted false, text unchanged
  const clean = scanSecrets("diff --git a/a b/a\n+++ b/a\n+hello world\n");
  assert.equal(clean.redacted, false);
  assert.equal(clean.text, "diff --git a/a b/a\n+++ b/a\n+hello world\n");

  // scanTextSecrets on a .env file body
  const envScan = scanTextSecrets("TOKEN=Zx9Qw8Er7Ty6Ui5Op3As1Df4Gh6Jk2L\nPLAIN=hello\n");
  assert.equal(envScan.redacted, true);
  assert.ok(envScan.text.includes("TOKEN=" + REDACTED));
  assert.ok(envScan.text.includes("PLAIN=hello"));
});

test("git helpers: isGitRepo / currentBranch / headCommit / projectName", (t) => {
  const { dir } = makeRepo(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  commitAll(dir, "init");
  assert.equal(isGitRepo(dir), true);
  assert.equal(currentBranch(dir), "main");
  assert.match(headCommit(dir), /^[0-9a-f]{40}$/);
  assert.equal(projectName(dir), "proj"); // no origin -> dir name
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "r1-notrepo-"));
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  assert.equal(isGitRepo(notRepo), false);
  assert.equal(currentBranch(notRepo), null);
});

test("end-to-end via CLI: snapshot + diff --json on a fixture repo", (t) => {
  const { dir, index } = makeRepo(t);
  const tool = path.join(HERE, "..", "..", "src", "snapshot", "tool.mjs");
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
  commitAll(dir, "init");
  const t1 = execFileSync("node", [tool, "snapshot", dir, index], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(dir, "a.txt"), "1\n2\n");
  const t2 = execFileSync("node", [tool, "snapshot", dir, index], { encoding: "utf8" }).trim();
  assert.notEqual(t1, t2);
  const out = JSON.parse(
    execFileSync("node", [tool, "diff", dir, t1, t2, "--json", "--no-diff"], { encoding: "utf8" }),
  );
  assert.equal(out.empty, false);
  assert.equal(out.files[0].path, "a.txt");
  assert.equal(out.files[0].status, "modified");
  assert.equal(out.totals.added, 1);
});
