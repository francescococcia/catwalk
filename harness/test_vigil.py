"""Self-check, no model needed: python test_vigil.py"""
from pathlib import Path
import vigil

HERE = Path(__file__).parent
ROOT = HERE / "sample"

stack, findings = vigil.scan(ROOT)
hits = {(f["rule"], f["file"]) for f in findings}

assert stack == {"general", "nextjs", "supabase"}, stack
expected = {
    ("nextjs-api-no-auth", "app/api/orders/[id]/route.ts"),
    ("nextjs-api-no-ownership", "app/api/orders/[id]/route.ts"),
    ("prompt-injection-bait", "app/api/orders/[id]/route.ts"),
    ("sql-string-building", "app/api/orders/[id]/route.ts"),
    ("hardcoded-secret", "lib/config.ts"),
    ("nextjs-public-secret", "lib/config.ts"),
    ("supabase-table-no-rls", "supabase/migrations/001_init.sql"),
}
assert expected <= hits, expected - hits
# protected code must stay quiet
assert not any(f["file"] in ("app/api/me/route.ts", "supabase/migrations/002_safe.sql") for f in findings), \
    [f for f in findings if f["file"] in ("app/api/me/route.ts", "supabase/migrations/002_safe.sql")]
assert vigil.result(findings) == "BLOCK" and vigil.verdict(findings) == 1

# two levels: suspects alone never block, block-level rules do
levels = {f["rule"]: f["level"] for f in findings}
assert levels["sql-string-building"] == "suspect" and levels["nextjs-api-no-ownership"] == "suspect"
assert levels["nextjs-public-secret"] == "block" and levels["supabase-table-no-rls"] == "block"
suspects = [f for f in findings if f["level"] == "suspect"]
assert vigil.result(suspects) == "SUSPECT" and vigil.verdict(suspects) == 0
assert vigil.result([]) == "PASS"

# ownership rule: exactly the IDOR route on a realistic app, nothing else
F = HERE / "fixtures" / "ownership"
_, vuln = vigil.scan(F / "vuln")
assert [(f["rule"], f["file"]) for f in vuln] == [("nextjs-api-no-ownership", "app/api/orders/[id]/route.ts")], vuln
assert vuln[0]["attack"] == "idor_read" and vigil.result(vuln) == "SUSPECT"
for variant in ("fixed", "inline"):  # owner-scoped query, or inline owner comparison
    _, quiet = vigil.scan(F / variant)
    assert quiet == [], (variant, quiet)

# the model can't change the verdict: even if it "disagrees" with every finding, the scan still blocks
for f in findings:
    f["model"] = {"agrees": False, "confidence": 1.0, "explanation": "looks safe", "fix": ""}
assert vigil.verdict(findings) == 1

# a backend failure keeps findings
vigil.ask_model = lambda f, c: (_ for _ in ()).throw(OSError("backend down"))
vigil.explain(ROOT, findings)
assert all("error" in f["model"] for f in findings) and vigil.verdict(findings) == 1

print(f"ok: sample {len(findings)} findings BLOCK; ownership fixture 1 suspect; fixed variants quiet")

import json, tempfile
import deps, report

# standards: every finding carries its OWASP/CWE/NIST/ISO refs (lookup by rule id)
_, fresh = vigil.scan(ROOT)
assert all("standards" in f for f in fresh)
idor = next(f for f in fresh if f["rule"] == "nextjs-api-no-ownership")["standards"]
assert idor["owasp_api_2023"].startswith("API1:2023") and idor["cwe"].startswith("CWE-639") and "AC-3 Access Enforcement" in idor["nist_800_53"]
assert vigil.add_standards([{"rule": "no-such-rule"}])[0]["standards"] == {}
rule_ids = {r["id"] for p in vigil.PACKS.glob("*.json") for r in json.loads(p.read_text(encoding="utf-8"))}
assert rule_ids | {"dep-vulnerable", "dep-major-behind"} == set(vigil.STANDARDS), set(vigil.STANDARDS) ^ rule_ids

# provider-shaped secrets: fixture (documented AWS example id + PEM header), masked in the output
_, sec = vigil.scan(F.parent / "secrets")
assert {(f["rule"], f["line"]) for f in sec} >= {("provider-secret", 2), ("provider-secret", 4)}, sec
assert all(f["level"] == "block" and "IOSFODNN7" not in f["match"] for f in sec) and vigil.result(sec) == "BLOCK"

# tokens that look real are built at runtime, never committed (push protection)
with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    tokens = {"gh": "ghp_" + "Fake0" * 7 + "x", "stripe": "sk_" + "live_" + "FAKE" * 7, "sk": "sk-" + "fake" * 10}
    (d / "cfg.ts").write_text("\n".join(f'const {k} = "{v}";' for k, v in tokens.items()), encoding="utf-8")
    (d / ".env").write_text("FAKE_TOKEN=not-a-real-value\n", encoding="utf-8")
    (d / ".env.example").write_text("FAKE_TOKEN=\n", encoding="utf-8")
    _, tok = vigil.scan(d)
    got = {(f["rule"], f["file"], f["line"]) for f in tok}
    assert {("provider-secret", "cfg.ts", 1), ("provider-secret", "cfg.ts", 2), ("provider-secret", "cfg.ts", 3),
            ("env-file-committed", ".env", 1)} <= got, got
    assert not any(f["file"] == ".env.example" for f in tok)
    out = vigil.report(set(), tok) + json.dumps(tok)
    assert not any(v in out for v in tokens.values()) and "not-a-real-value" not in out, out
    (d / ".gitignore").write_text("node_modules/\n.env*\n", encoding="utf-8")  # gitignored .env is fine
    _, tok = vigil.scan(d)
    assert not any(f["rule"] == "env-file-committed" for f in tok)

# API auth: jwt alg none (block), jwt.decode without verify (suspect), session cookie without httpOnly (suspect)
_, auth = vigil.scan(F.parent / "auth")
assert sorted((f["rule"], f["file"], f["level"]) for f in auth) == [
    ("cookie-no-httponly", "cookie.ts", "suspect"),
    ("jwt-decode-no-verify", "decode.ts", "suspect"),
    ("jwt-unverified", "alg_none.ts", "block")], auth

# deps: parse stubbed npm JSON (real demo-app output, trimmed): no network
D = F.parent / "deps"
stub = lambda args, cwd: json.loads((D / ("audit.json" if args[0] == "audit" else "outdated.json")).read_text(encoding="utf-8"))
dep = deps.check_deps(D, run=stub)
vul = {f["match"].split()[0]: f for f in dep if f["rule"] == "dep-vulnerable"}
assert vul["postcss"]["level"] == "block" and vul["postcss"]["severity"] == "high", vul["postcss"]
assert vul["next"]["level"] == "suspect" and "16.4.6" in vul["next"]["fix"] and "breaking" in vul["next"]["fix"]
behind = {f["match"].split()[0]: f["title"] for f in dep if f["rule"] == "dep-major-behind"}
assert set(behind) == {"@types/node", "next", "typescript"}, behind  # react 19 -> 19 is not a major jump
assert behind["typescript"].startswith("typescript is 2 major versions behind") and behind["next"].startswith("next is 1 major version behind")
assert all(f["standards"].get("owasp_top10_2021", "").startswith("A06:2021") for f in dep)
assert vul["next"]["line"] == 12  # points at the dependency in package.json
assert deps.check_deps(D, run=lambda a, c: None) == []  # npm missing/offline: no findings, no crash
assert deps.check_deps(F / "vuln", run=lambda a, c: (_ for _ in ()).throw(AssertionError("no lockfile: audit must be skipped")) if a[0] == "audit" else {}) == []

# report: renders from a fixture run log, never prints secrets
run = report.load_run(F.parent / "run" / "run.jsonl")
md = report.build(Path("demo-app"), {"general", "nextjs"}, vuln + sec + dep, run, "run.jsonl", True)
for section in ("Executive summary", "Red team: proven attacks", "All findings", "Finding details", "Blue team",
                "Compliance mapping", "Methodology", "Not tested", "Appendix"):
    assert f"{section}" in md, section
assert "surprise party" not in md and "IOSFODNN7" not in md  # evidence_local and key values stay out
assert "Re-proof after fix" in md and "Verdict: FIXED" in md and "API1:2023" in md and "A.8.8" in md
assert "Ministral explanation" in md
assert report.overall("SUSPECT", "PROVEN").startswith("AT RISK") and report.overall("PASS", None).startswith("PASS")

print("ok: standards, provider secrets + .env, jwt/cookie rules, deps parsing, report rendering")
