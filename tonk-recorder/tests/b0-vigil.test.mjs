// `vigil install` — offline: a local git repository stands in for Vigil's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cmdVigil, rewriteSkill, vigilDir } from "../src/cli/commands/vigil.mjs";
import { roleHarnessText, agentToml } from "../src/hooks/roles.mjs";

const tmp = (t, p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const SKILL = "# Vigil\nFrom the repository root:\n```bash\npython harness/vigil.py scan <path> --no-llm\nuv run --project engine engine/run.py <path>\n```\nreplay in `harness/viewer/`\n";

function fakeVigilRepo(t) {
  const d = tmp(t, "vigil-src-");
  const g = (...a) => execFileSync("git", ["-C", d, ...a], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  fs.mkdirSync(path.join(d, "harness")); fs.mkdirSync(path.join(d, "engine")); fs.mkdirSync(path.join(d, ".vibe", "skills", "vigil"), { recursive: true });
  fs.writeFileSync(path.join(d, "harness", "vigil.py"), "print('PASS')\n");
  fs.writeFileSync(path.join(d, "engine", "run.py"), "print('ok')\n");
  fs.writeFileSync(path.join(d, ".vibe", "skills", "vigil", "SKILL.md"), SKILL);
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "init");
  return d;
}

test("rewriteSkill makes Vigil's repo-relative commands absolute", () => {
  const out = rewriteSkill(SKILL, "/opt/vigil");
  assert.match(out, /python3 "\/opt\/vigil\/harness\/vigil\.py" scan <path> --no-llm/);
  assert.match(out, /uv run --project "\/opt\/vigil\/engine" "\/opt\/vigil\/engine\/run\.py" <path>/);
  assert.match(out, /these commands work from any folder/);
  assert.ok(!out.includes("From the repository root"));
});

test("vigil install: pinned checkout in the recorder's folder, skill in the project, security role gets exact commands", async (t) => {
  const repo = fakeVigilRepo(t);
  const home = tmp(t, "home-");
  const proj = tmp(t, "proj-");
  const env = { ...process.env, HOME: home };
  const lines = [];
  const orig = console.log; console.log = (l) => lines.push(String(l));
  try {
    assert.match(roleHarnessText({ role: "security", wrapper: "tonk-recorder", env }), /not installed.*FIRST run: tonk-recorder vigil install/s);
    assert.equal(await cmdVigil(["install", "--repo", repo, "--ref", "HEAD"], { env, cwd: proj }), 0);
    assert.equal(await cmdVigil(["install", "--repo", repo, "--ref", "HEAD"], { env, cwd: proj }), 0, "running it again is fine");
  } finally { console.log = orig; }
  const dir = vigilDir(env);
  assert.ok(fs.existsSync(path.join(dir, "harness", "vigil.py")));
  const skill = fs.readFileSync(path.join(proj, ".vibe", "skills", "vigil", "SKILL.md"), "utf8");
  assert.ok(skill.includes(`python3 "${dir}/harness/vigil.py" scan`));
  assert.match(lines.join("\n"), /skill installed in this project/);
  assert.match(lines.join("\n"), /never snapshots \.vigil\//);

  const txt = roleHarnessText({ role: "security", wrapper: "tonk-recorder", env });
  assert.match(txt, /MUST use the Vigil harness/);
  assert.ok(txt.includes(`python3 "${dir}/harness/vigil.py" scan <folder> --no-llm`));
  assert.ok(txt.includes(`uv run --project "${dir}/engine" "${dir}/engine/run.py" <folder>`));
  assert.equal(roleHarnessText({ role: "builder", wrapper: "x", env }), "", "only the security role");
  const toml = agentToml({ space: "s", role: "security", instructions: "You prove.", recording: "manual", wrapper: "tonk-recorder", env });
  assert.ok(toml.includes("MUST use the Vigil harness") && toml.includes("run add --tool"));
});
