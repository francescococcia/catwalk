"""Merge a Vigil security report (harness/vigil.py scan ... --json) into DevTok's threat register.

    python3 security.py <vigil-report.json> [--threats ../security/threats.json]

- A finding with "devtok_threat": "T<n>" is attached to that threat.
- Other findings become new threats (T100+), keyed by rule + file:line so re-runs do not duplicate them.
- Status flow per threat: open -> mitigated (we changed code) -> verified (Vigil's rule/attack no longer fires).
  A threat whose attached findings are all gone from a newer report is marked "verified" automatically.
"""
import argparse
import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEV = {"low": 1, "medium": 2, "high": 3, "critical": 4}


def merge(report, reg):
    threats = {t["id"]: t for t in reg["threats"]}
    seen = set()
    next_id = max([int(t["id"][1:]) for t in reg["threats"] if t["id"][1:].isdigit() and int(t["id"][1:]) >= 100] or [99]) + 1
    for f in report.get("findings", []):
        key = f"{f.get('rule')}@{f.get('file')}:{f.get('line')}"
        seen.add(key)
        tid = f.get("devtok_threat")
        if tid not in threats:
            tid = next((t["id"] for t in threats.values() if key in {x["key"] for x in t.get("findings", [])}), None)
        if tid is None:
            tid = f"T{next_id}"
            next_id += 1
            threats[tid] = {"id": tid, "title": f.get("title", f.get("rule")), "where": f.get("file"), "severity": f.get("severity", "medium"),
                            "status": "open", "source": "vigil", "findings": []}
        t = threats[tid]
        t.setdefault("findings", [])
        t["findings"] = [x for x in t["findings"] if x["key"] != key] + [{
            "key": key, "rule": f.get("rule"), "severity": f.get("severity"), "level": f.get("level"),
            "file": f.get("file"), "line": f.get("line"), "fix": f.get("fix"), "standards": f.get("standards", {}),
            "explanation": (f.get("model") or "")[:800]}]
        if SEV.get(f.get("severity"), 0) > SEV.get(t.get("severity"), 0):
            t["severity"] = f["severity"]
        if t.get("status") == "verified":
            t["status"] = "open"  # it fired again
    for t in threats.values():  # findings that disappeared from the new report
        live = [x for x in t.get("findings", []) if x["key"] in seen]
        if t.get("findings") and not live and t.get("status") == "mitigated":
            t["status"] = "verified"
    reg["threats"] = sorted(threats.values(), key=lambda t: (int(t["id"][1:]) if t["id"][1:].isdigit() else 999))
    reg["last_report"] = {"result": report.get("result"), "stack": report.get("stack"), "merged_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                          "findings": len(report.get("findings", []))}
    return reg


def checklist(reg):
    """Open/mitigated threats as verdict-screen checklist items (what the app shows reviewers)."""
    return [{"text": f"[{t['id']}] {t['title']} ({t['severity']}, {t['status']})", "kind": "verify",
             "blocking": t["severity"] in ("high", "critical") and t["status"] != "verified"}
            for t in reg["threats"] if t["status"] != "verified"]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--threats", default=str(HERE.parent / "security" / "threats.json"))
    a = ap.parse_args()
    reg = json.loads(Path(a.threats).read_text())
    reg = merge(json.loads(Path(a.report).read_text()), reg)
    Path(a.threats).write_text(json.dumps(reg, indent=2, ensure_ascii=False))
    print(f"{len(reg['threats'])} threats, {sum(t['status'] != 'verified' for t in reg['threats'])} not verified")
    for c in checklist(reg):
        print(("BLOCKING " if c["blocking"] else "         ") + c["text"])
