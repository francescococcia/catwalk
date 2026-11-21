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
