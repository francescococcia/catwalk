"""Engine core self-test. Run: uv run --project engine engine/test_engine.py

Unit part needs nothing. Live part needs demo-app on VIGIL_TARGET_URL (default http://localhost:3001),
already running; it is skipped loudly if down. The demo route file is restored byte-for-byte in a finally.
"""
from __future__ import annotations

import http.server
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import attacks  # noqa: E402
import planner  # noqa: E402
import profile as profile_mod  # noqa: E402
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

    # ---- target profile: .vigil/target.json drives address, routes, users, record ids
    with tempfile.TemporaryDirectory() as d:
        app = Path(d) / "app"
        app.mkdir()
        prof = profile_mod.load_profile(app)  # no file -> built-in demo profile
        assert prof["target"] == "http://localhost:3001" and set(prof["users"]) == {"alice", "bob"}
        assert attacks.validate("idor_read", P, prof) is None
        assert attacks.validate("unauth_read", {"record": "ord_b1"}, prof) is None
        (app / ".vigil").mkdir()
        custom = {"target": "http://127.0.0.1:9999",
                  "login": {"path": "/login", "username_field": "u", "password_field": "p", "session_cookie": "sid"},
                  "users": [{"name": "eve", "password": "pw-eve", "records": ["rec_1"]},
                            {"name": "max", "password": "pw-max", "records": ["rec_2"]}],
                  "routes": {"record": "/api/rec/{id}"}, "record_id_pattern": "^rec_[0-9]{1,8}$",
                  "secret_field": "note"}
        (app / ".vigil" / "target.json").write_text(json.dumps(custom), encoding="utf-8")
        prof = profile_mod.load_profile(app)
        assert prof["target"] == "http://127.0.0.1:9999" and prof["routes"]["record"] == "/api/rec/{id}"
        assert profile_mod.sanitized(prof)["users"] == [{"name": "eve", "records": ["rec_1"]},
                                                         {"name": "max", "records": ["rec_2"]}]
        assert "pw-eve" not in json.dumps(profile_mod.sanitized(prof))  # passwords never shown to a model
        # unsafe profiles are refused: non-local target, escaping/missing-placeholder routes, bad users
        for bad in ({**custom, "target": "http://evil.example.com"},
                    {**custom, "target": "http://192.168.1.5:3001"},
                    {**custom, "routes": {"record": "http://evil.com/{id}"}},
                    {**custom, "routes": {"record": "/api/rec/"}},
                    {**custom, "users": [{"name": "eve", "password": "", "records": ["rec_1"]}]},
                    {**custom, "users": [{"name": "eve", "password": "x", "records": ["../etc"]}]}):
            (app / ".vigil" / "target.json").write_text(json.dumps(bad), encoding="utf-8")
            try:
                profile_mod.load_profile(app)
                raise AssertionError(f"unsafe profile accepted: {bad}")
            except ValueError:
                pass
        try:
            profile_mod.load_profile(app, "http://example.com")  # even --target must stay loopback
            raise AssertionError("non-local target override accepted")
        except ValueError:
            pass
        # .vigil/ is never readable or scannable; the scan exposes only the sanitized profile
        (app / ".vigil" / "target.json").write_text(json.dumps(custom), encoding="utf-8")
        (app / "src").mkdir()
        (app / "src" / "ok.ts").write_text("export async function GET() {}\n", encoding="utf-8")
        t3 = Tools(app)
        assert t3.target == "http://127.0.0.1:9999"  # target came from the file
        for bad in (".vigil/target.json", ".vigil", ".vigil/../.vigil/target.json"):
            assert "error" in t3.read_file(bad), bad
        sc = t3.vigil_scan(".")
        assert "error" not in sc and "pw-eve" not in json.dumps(sc) and "password" not in json.dumps(sc["profile"])
        assert sc["profile"]["target"] == "http://127.0.0.1:9999"
        assert not any(x.startswith(".vigil") for x in sc["tree"])
        # attacks read users/routes/ids from THIS profile: ord_b1 is not a known record here
        r = t3.run_proof("unauth_read", {"record": "ord_b1"})
        assert r["status"] == "ERROR" and "record" in r["error"], r
        r = t3.run_proof("unauth_read", {"record": "rec_2"})  # known record, but nothing listens on :9999
        assert r["status"] == "ERROR" and "unreachable" in r["control"]["detail"], r

    # ---- credential-looking params are rejected before any request; ids must come from the profile
    for atk, params in (("unauth_read", {"record": "ord_b1", "password": "x"}),
                        ("unauth_read", {"record": "ord_b1", "session": "x"}),
                        ("idor_read", {**P, "cookie": "x"}),
                        ("unauth_read", {"record": "ord_zzz"}),
                        ("idor_read", {"attacker": "alice", "victim_order": "ord_zzz"}),
                        ("idor_read", {"attacker": "mallory", "victim_order": "ord_b1"}),
                        ("unauth_read", {"record": "../admin"}),
                        ("unauth_read", "ord_b1")):
        r = attacks.run(atk, params, TARGET)
        assert r["status"] == "ERROR" and r.get("error"), (atk, params, r)
    # non-local target refused at the attack level too
    r = attacks.run("unauth_read", {"record": "ord_b1"}, "http://example.com:3001")
    assert r["status"] == "ERROR" and "loopback" in r["error"], r

    # ---- both attacks against a fake local app (loopback http.server, no demo-app needed)
    fake_users = {"alice": {"password": "pw-alice", "records": ["ord_a1"]},
                  "bob": {"password": "pw-bob", "records": ["ord_b1"]}}
    fake_records = {"ord_a1": {"id": "ord_a1", "item": "x", "secret_note": "alice private"},
                    "ord_b1": {"id": "ord_b1", "item": "y", "secret_note": "BOB'S SECRET 4471"}}

    def fake_server(mode):  # "open" = no auth no ownership, "auth_only" = auth but no ownership, "fixed" = both
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, obj, cookie=None):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                if cookie:
                    self.send_header("Set-Cookie", cookie)
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                u = fake_users.get(body.get("username"))
                if u and body.get("password") == u["password"]:
                    self._json(200, {"ok": True}, cookie=f"vigil_session=tok-{body.get('username')}; Path=/")
                else:
                    self._json(401, {"error": "invalid credentials"})

            def do_GET(self):
                if not self.path.startswith("/api/orders/"):
                    return self._json(404, {"error": "no route"})
                rid = urllib.parse.unquote(self.path.rsplit("/", 1)[-1])
                cookie = self.headers.get("Cookie") or ""
                if mode in ("auth_only", "fixed") and "vigil_session=" not in cookie:
                    return self._json(401, {"error": "not authenticated"})
                rec = fake_records.get(rid)
                if not rec:
                    return self._json(404, {"error": "order not found"})
                if mode == "fixed":
                    owner = next(n for n, u in fake_users.items() if rid in u["records"])
                    if f"tok-{owner}" not in cookie:
                        return self._json(404, {"error": "order not found"})
                self._json(200, rec)

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def fake_prof(port):
        return profile_mod.normalize({
            "target": f"http://127.0.0.1:{port}",
            "login": {"path": "/api/login", "username_field": "username", "password_field": "password",
                      "session_cookie": "vigil_session"},
            "users": [{"name": n, "password": u["password"], "records": u["records"]} for n, u in fake_users.items()],
            "routes": {"record": "/api/orders/{id}"}, "record_id_pattern": "^ord_[a-z0-9]{1,16}$",
            "secret_field": "secret_note"})

    srv = fake_server("open")
    pf = fake_prof(srv.server_address[1])
    r = attacks.run("unauth_read", {"record": "ord_b1"}, profile=pf)
    assert r["status"] == "PROVEN" and r["evidence"]["status_code"] == 200 and r["control"]["ok"], r
    assert "BOB'S SECRET 4471" not in r["evidence"]["body_redacted"]
    assert "BOB'S SECRET 4471" in r["evidence_local"]["body"]
    r = attacks.run("idor_read", P, profile=pf)
    assert r["status"] == "PROVEN" and r["control"]["ok"], r
    srv.shutdown()

    srv = fake_server("auth_only")
    pf = fake_prof(srv.server_address[1])
    r = attacks.run("unauth_read", {"record": "ord_b1"}, profile=pf)
    assert r["status"] == "BLOCKED" and r["evidence"]["status_code"] == 401 and r["control"]["ok"], r
    r = attacks.run("idor_read", P, profile=pf)
    assert r["status"] == "PROVEN" and r["control"]["ok"], r
    srv.shutdown()

    srv = fake_server("fixed")
    pf = fake_prof(srv.server_address[1])
    r = attacks.run("unauth_read", {"record": "ord_b1"}, profile=pf)
    assert r["status"] == "BLOCKED" and r["control"]["ok"], r
    r = attacks.run("idor_read", P, profile=pf)
    assert r["status"] == "BLOCKED" and r["control"]["ok"], r
    srv.shutdown()
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

    # the demo route DOES require login: the anonymous read must be BLOCKED (second attack works)
    r2 = attacks.run("unauth_read", {"record": "ord_b1"}, TARGET)
    assert r2["status"] == "BLOCKED" and r2["evidence"]["status_code"] == 401 and r2["control"]["ok"], \
        f"demo-app must refuse anonymous reads: {r2}"

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
