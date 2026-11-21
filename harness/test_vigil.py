"""Self-check, no model needed: python test_vigil.py"""
from pathlib import Path
import vigil

ROOT = Path(__file__).parent / "sample"

stack, findings = vigil.scan(ROOT)
hits = {(f["rule"], f["file"]) for f in findings}

assert stack == {"general", "nextjs", "supabase"}, stack
expected = {
    ("nextjs-api-no-auth", "app/api/orders/[id]/route.ts"),
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
assert vigil.verdict(findings) == 1

# the model can't change the verdict: even if it "disagrees" with every finding, the scan still blocks
for f in findings:
    f["model"] = {"agrees": False, "confidence": 1.0, "explanation": "looks safe", "fix": ""}
assert vigil.verdict(findings) == 1

# a backend failure keeps findings
vigil.ask_model = lambda f, c: (_ for _ in ()).throw(OSError("backend down"))
vigil.explain(ROOT, findings)
assert all("error" in f["model"] for f in findings) and vigil.verdict(findings) == 1

print(f"ok: {len(findings)} findings, verdict BLOCK, safe files quiet")
