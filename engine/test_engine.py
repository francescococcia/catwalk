"""Engine core self-test. Run: uv run --project engine engine/test_engine.py

Unit part needs nothing. Live part needs demo-app on VIGIL_TARGET_URL (default http://localhost:3001),
already running; it is skipped loudly if down. The demo route file is restored byte-for-byte in a finally.
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import attacks  # noqa: E402
import planner  # noqa: E402
import run as engine_run  # noqa: E402
from tools import Tools, mask  # noqa: E402

DEMO = HERE.parent / "demo-app"
ROUTE = DEMO / "app" / "api" / "orders" / "[id]" / "route.ts"
TARGET = os.environ.get("VIGIL_TARGET_URL", "http://localhost:3001")
P = {"attacker": "alice", "victim_order": "ord_b1"}


def unit():
    # ---- secret masking
    s = 'const apiKey = "sk_live_abcdefghijklmnop";\nconst x = "short";\n'
    m = mask(s)
    assert "abcdefghijklmnop" not in m and 'apiKey = "***"' in m and '"short"' in m, m

    with tempfile.TemporaryDirectory() as d:
        root = Path(d) / "app"
        (root / "data").mkdir(parents=True)
        (root / "src").mkdir()
        (root / ".gitignore").write_text("data/\n*.log\n", encoding="utf-8")
        (root / ".env").write_text("A=1", encoding="utf-8")
        (root / ".env.local").write_text("A=1", encoding="utf-8")
        (root / "data" / "x.txt").write_text("x", encoding="utf-8")
        (root / "debug.log").write_text("x", encoding="utf-8")
        (root / "big.txt").write_text("x" * 210_000, encoding="utf-8")
        (root / "src" / "secret.ts").write_text(s, encoding="utf-8")
        (root / "src" / "ok.ts").write_bytes(b"line1\r\nline2\r\n")
        (Path(d) / "outside.txt").write_text("x", encoding="utf-8")

        t = Tools(root)
        for bad in ["../outside.txt", str(Path(d) / "outside.txt"), ".env", ".ENV.local", "data/x.txt",
                    "DATA/x.txt", "src/../data/x.txt", "debug.log", "big.txt", "node_modules/x.js", "missing.ts"]:
            r = t.read_file(bad)
            assert "error" in r, (bad, r)
        r = t.read_file("src/secret.ts")
        assert "abcdefghijklmnop" not in r["content"] and "***" in r["content"], r
        assert t.read_file("src/ok.ts")["content"] == "line1\r\nline2\r\n"  # CRLF kept

        # apply_fix: refused without gate approval, refused on masked-secret file, rollback is byte-exact
        assert "error" in t.apply_fix("src/ok.ts", "new")
        t2 = Tools(root, approved=lambda f, c: True)
        assert "error" in t2.apply_fix("src/secret.ts", "x")
        assert "error" in t2.apply_fix("../outside.txt", "x")
        assert "error" in t2.apply_fix(".env", "x")
        res = t2.apply_fix("src/ok.ts", "patched\r\n")
        assert res.get("applied") and (root / "src" / "ok.ts").read_bytes() == b"patched\r\n", res
        assert t2.rollback(res["backup_id"]).get("rolled_back")
        assert (root / "src" / "ok.ts").read_bytes() == b"line1\r\nline2\r\n"
        assert "error" in t2.rollback("nope")

        # scan tree hides denied files
        sc = t.vigil_scan(".")
        assert "error" not in sc, sc
        assert not any(x.startswith(("data/", ".env")) or x.endswith(".log") for x in sc["tree"]), sc["tree"]
        assert any("secret.ts" in f["file"] and "abcdefghijklmnop" not in f["match"] for f in sc["findings"]), sc
        assert sc["result"] == "BLOCK"
        assert "error" in t.vigil_scan("..")

    # ---- attack allowlist + params
    for attack, params in [("rce", P), ("idor_read", {"attacker": "eve", "victim_order": "ord_b1"}),
                           ("idor_read", {"attacker": "alice", "victim_order": "../admin"}),
                           ("idor_read", {"attacker": "alice", "victim_order": "ord_B1"}),
                           ("idor_read", {"attacker": "alice", "victim_order": "ord_a1"}),
                           ("idor_read", {**P, "password": "x"}), ("idor_read", "ord_b1")]:
        r = attacks.run(attack, params, TARGET)
        assert r["status"] == "ERROR" and r.get("error"), (attack, params, r)

    # ---- unreachable target is ERROR, never BLOCKED (also with retry)
    for retry in (False, True):
        r = Tools(DEMO, target="http://127.0.0.1:1").run_proof("idor_read", P, retry=retry)
        assert r["status"] == "ERROR", r
    print("unit: OK")


def wait_for(status, secs=20):
    end = time.monotonic() + secs
    while True:
        r = attacks.run("idor_read", P, TARGET)
        if r["status"] == status or time.monotonic() > end:
            return r
        time.sleep(0.5)


def one_run(auto="allow"):
    log = engine_run.EventLog(None)
    gate = engine_run.Gate(log.emit)

    def approver():  # answers through the real gate from another thread, like the browser's POST /approve
        seen = 0
        while True:
            with log.cond:
                log.cond.wait(1)
                new = log.events[seen:]
            seen += len(new)
            for e in new:
                if e["type"] == "fix_proposed":
                    assert gate.answer(e["approval_id"], auto)
                if e["type"] == "run_finished":
                    return

    threading.Thread(target=approver, daemon=True).start()
    verdict = engine_run.run(DEMO, TARGET, "offline", log, gate)
    return verdict, log.events


def live(original: bytes):
    r = attacks.run("idor_read", P, TARGET)
    if r["status"] == "ERROR":
        print(f"\n!!!!!! LIVE PART SKIPPED: demo-app not reachable at {TARGET} ({r.get('error')}) !!!!!!\n")
        return False
    assert r["status"] == "PROVEN" and r["control"]["ok"], f"untouched demo-app must be PROVEN first: {r}"
    assert "BOB'S SECRET" not in r["evidence"]["body_redacted"] and "BOB'S SECRET" in r["evidence_local"]["body"]

    # (a) PROVEN -> approve -> FIXED
    verdict, evs = one_run("allow")
    types = [e["type"] for e in evs]
    assert verdict == "FIXED", (verdict, [(e["type"], e["text"]) for e in evs])
    proofs = [e for e in evs if e["type"] == "proof"]
    assert proofs[0]["status"] == "PROVEN" and proofs[-1]["status"] == "BLOCKED" and proofs[-1]["control"]["ok"]
    assert ROUTE.read_bytes() != original and b"order.user_id !== userId" in ROUTE.read_bytes()
    assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))
    assert all({"seq", "ts", "type", "character", "text"} <= set(e) for e in evs)
    assert not any("BOB'S SECRET" in e["text"] for e in evs)
    assert types[-2:] == ["verdict", "run_finished"] and "approval" in types and "fix_applied" in types
    print("live (a) PROVEN -> approve -> FIXED: OK")
    ROUTE.write_bytes(original)
    assert wait_for("PROVEN")["status"] == "PROVEN"

    # (b) a bad fix (no-op comment) -> still PROVEN -> rollback
    good = planner.make_fix
    planner.make_fix = lambda text: ("// vigil: looks fine to me\r\n" + text, "a fix that changes nothing")
    try:
        verdict, evs = one_run("allow")
    finally:
        planner.make_fix = good
    assert verdict == "PROVEN", (verdict, [(e["type"], e["text"]) for e in evs])
    assert any(e["type"] == "rollback" for e in evs)
    assert ROUTE.read_bytes() == original, "rollback must restore the original bytes"
    print("live (b) bad fix -> PROVEN -> rollback: OK")

    # (b2) denied at the gate -> PROVEN, file untouched
    verdict, evs = one_run("deny")
    assert verdict == "PROVEN" and ROUTE.read_bytes() == original and "fix_applied" not in [e["type"] for e in evs]
    print("live (b2) denied fix -> PROVEN, untouched: OK")
    return True


if __name__ == "__main__":
    unit()
    original = ROUTE.read_bytes()
    ran = True
    try:
        ran = live(original)
    finally:
        ROUTE.write_bytes(original)
        assert ROUTE.read_bytes() == original
        r = wait_for("PROVEN")
        assert r["status"] == "PROVEN" or not ran, f"after restore the attack must be PROVEN again: {r}"
        print(f"live (c) route restored byte-for-byte; attack {r['status']} again")
    print("ALL OK")
