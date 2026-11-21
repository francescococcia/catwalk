"""Allowlisted proof-of-attack runner. The planner may only pick an id from ATTACKS.

run(attack, params, target=None, retry=False) -> dict, never raises.
Status is decided by code: PROVEN | BLOCKED | ERROR. A dead server / failed login is ERROR, never BLOCKED.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_TARGET = "http://localhost:3001"
PASSWORDS = {"alice": "alice123", "bob": "bob123"}  # demo-only seeded logins, never taken from the model
OWN_ORDERS = {"alice": ("ord_a1", "ord_a2"), "bob": ("ord_b1", "ord_b2")}
ORDER_RE = re.compile(r"^ord_[a-z0-9]{1,16}$")
ATTACKS = {"idor_read"}
RETRY_SECONDS = 6.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None  # a redirect must not escape the target guard


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def validate(attack: str, params: dict) -> str | None:
    """Returns an error message, or None when the attack id and params are allowed."""
    if attack not in ATTACKS:
        return f"attack {attack!r} is not in the allowlist {sorted(ATTACKS)}"
    if not isinstance(params, dict) or set(params) != {"attacker", "victim_order"}:
        return "params must be exactly {attacker, victim_order}"
    if params["attacker"] not in PASSWORDS:
        return "attacker must be 'alice' or 'bob'"
    v = params["victim_order"]
    if not isinstance(v, str) or not ORDER_RE.match(v):
        return "victim_order must match ^ord_[a-z0-9]{1,16}$"
    if v in OWN_ORDERS[params["attacker"]]:
        return "victim_order belongs to the attacker; pick someone else's order"
    return None


def _target(target: str | None) -> urllib.parse.SplitResult:
    t = (target or os.environ.get("VIGIL_TARGET_URL") or DEFAULT_TARGET).strip().rstrip("/")
    p = urllib.parse.urlsplit(t)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"target must be an http(s) URL, got {t!r}")
    return p


def _request(tp, method: str, path: str, body: dict | None = None, cookie: str | None = None):
    base = f"{tp.scheme}://{tp.netloc}"
    url = urllib.parse.urljoin(base + "/", path.lstrip("/"))
    u = urllib.parse.urlsplit(url)
    if (u.scheme, u.hostname, u.port) != (tp.scheme, tp.hostname, tp.port):  # same guard as proof/attack.py
        raise RuntimeError(f"REFUSED: {url!r} is outside the target")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with _OPENER.open(req, timeout=15) as r:
            return r.status, r.headers.get_all("Set-Cookie") or [], r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get_all("Set-Cookie") if e.headers else None) or [], e.read().decode("utf-8", "replace")


def redact(raw: str) -> str:
    """Body for the hosted agent / events: secret_note masked, everything truncated."""
    try:
        d = json.loads(raw)
    except ValueError:
        return raw[:200]
    if isinstance(d, dict) and "secret_note" in d:
        d["secret_note"] = str(d["secret_note"])[:4] + "***"
    return json.dumps(d)[:300]


def _json(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _idor_read(tp, attacker: str, victim: str) -> dict:
    out = {"status": "ERROR", "attack": "idor_read", "params": {"attacker": attacker, "victim_order": victim},
           "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}
    status, cookies, raw = _request(tp, "POST", "/api/login", {"username": attacker, "password": PASSWORDS[attacker]})
    cookie = next((c.split(";", 1)[0] for c in cookies if c.startswith("vigil_session=")), None)
    if status != 200 or not cookie:
        out["error"] = f"login as {attacker} failed (HTTP {status}); this is a setup problem, not a proof"
        return out

    own = OWN_ORDERS[attacker][0]
    c_status, _, c_raw = _request(tp, "GET", f"/api/orders/{own}", cookie=cookie)
    c_body = _json(c_raw)
    c_ok = c_status == 200 and isinstance(c_body, dict) and c_body.get("id") == own
    out["control"] = {"ok": c_ok, "detail": f"{attacker} reading own order {own}: HTTP {c_status}"
                      + ("" if c_ok else " (the route no longer serves the owner)")}

    path = f"/api/orders/{urllib.parse.quote(victim)}"
    a_status, _, a_raw = _request(tp, "GET", path, cookie=cookie)
    body = _json(a_raw)
    leaked = a_status == 200 and isinstance(body, dict) and body.get("id") == victim
    if a_status >= 500 or (not leaked and not c_ok and c_status >= 500):
        out["error"] = f"target answered HTTP {a_status}/{c_status} (server error, maybe recompiling)"
        out["status"] = "ERROR"
    else:
        out["status"] = "PROVEN" if leaked else "BLOCKED"
    out["evidence"] = {"request": f"GET {path} (logged in as {attacker})", "status_code": a_status,
                       "body_redacted": redact(a_raw)}
    out["evidence_local"] = {"body": a_raw[:5000]}
    return out


def run(attack: str, params: dict, target: str | None = None, retry: bool = False) -> dict:
    """retry=True: after a fix, keep trying for ~6 s until BLOCKED with a passing control (next dev hot reload)."""
    err = validate(attack, params)
    if err:
        return {"status": "ERROR", "attack": attack, "params": params, "error": err,
                "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}
    deadline = time.monotonic() + (RETRY_SECONDS if retry else 0)
    while True:
        try:
            res = _idor_read(_target(target), params["attacker"], params["victim_order"])
        except Exception as e:  # unreachable / refused / timeout / guard: ERROR, never BLOCKED
            res = {"status": "ERROR", "attack": attack, "params": dict(params), "error": f"{type(e).__name__}: {e}"[:300],
                   "evidence": {}, "control": {"ok": False, "detail": "target unreachable"}, "evidence_local": {}}
        if not retry or (res["status"] == "BLOCKED" and res["control"]["ok"]) or time.monotonic() >= deadline:
            return res
        time.sleep(0.5)


if __name__ == "__main__":
    print(json.dumps(run("idor_read", {"attacker": "alice", "victim_order": "ord_b1"}), indent=2))
