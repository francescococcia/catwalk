"""Allowlisted proof-of-attack runner. The planner may only pick an id from ATTACKS.

Everything about the target — address, login route, test users, their passwords,
their records, the record route, the id pattern — comes from the repo's target
profile `.vigil/target.json` (engine/profile.py), never from the model and never
hardcoded per attack. Passwords exist only in that file.

run(attack, params, target=None, retry=False, profile=None) -> dict, never raises.
Status is decided by code: PROVEN | BLOCKED | ERROR. A dead server / failed login is ERROR, never BLOCKED.

Attacks:
- idor_read:    log in as `attacker`, GET another user's `victim_order`. PROVEN if the record is served.
                Positive control: the attacker can still read one of their own records.
- unauth_read:  GET `record` with NO login at all. PROVEN if the record is served anonymously
                (missing authentication). Control: a logged-in owner can still read their own record.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import profile as profile_mod

ATTACKS = {"idor_read", "unauth_read"}
RETRY_SECONDS = 6.0
# Params are names/ids only; anything credential-looking is rejected outright.
CREDENTIAL_PARAM = re.compile(r"pass|secret|token|cookie|session|key", re.I)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None  # a redirect must not escape the target guard


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _prof(profile, target) -> dict:
    """Canonical profile: caller's profile (or the built-in demo one), with optional target override.
    The override must still be loopback: attacks only go to the profile's local address."""
    return profile_mod.normalize(profile if profile is not None else profile_mod.DEFAULT_PROFILE,
                                 target_override=target, source="attacks")


def validate(attack: str, params: dict, prof: dict | None = None) -> str | None:
    """Returns an error message, or None when the attack id and params are allowed.
    Params may only reference users/records that the profile file declares."""
    prof = prof or _prof(None, None)
    if attack not in ATTACKS:
        return f"attack {attack!r} is not in the allowlist {sorted(ATTACKS)}"
    if not isinstance(params, dict):
        return "params must be an object of names/ids only — never credentials"
    for k in params:
        if CREDENTIAL_PARAM.search(str(k)):
            return f"param {k!r} looks like a credential; passwords come only from .vigil/target.json, never from params"
    id_re = re.compile(prof["record_id_pattern"])
    known = {r for u in prof["users"].values() for r in u["records"]}

    if attack == "idor_read":
        if set(params) != {"attacker", "victim_order"}:
            return "idor_read params must be exactly {attacker, victim_order}"
        if params["attacker"] not in prof["users"]:
            return f"attacker must be one of the profile users {sorted(prof['users'])}"
        v = params["victim_order"]
        if not isinstance(v, str) or not id_re.match(v):
            return f"victim_order must match the profile's record_id_pattern {prof['record_id_pattern']!r}"
        if v in prof["users"][params["attacker"]]["records"]:
            return "victim_order belongs to the attacker; pick another user's record"
        if v not in known:
            return "victim_order must be another profile user's record (ids come from .vigil/target.json)"
        if not prof["users"][params["attacker"]]["records"]:
            return "attacker needs at least one own record in the profile for the positive control"
    elif attack == "unauth_read":
        if set(params) != {"record"}:
            return "unauth_read params must be exactly {record}"
        v = params["record"]
        if not isinstance(v, str) or not id_re.match(v):
            return f"record must match the profile's record_id_pattern {prof['record_id_pattern']!r}"
        if v not in known:
            return "record must be one of the profile users' records (ids come from .vigil/target.json)"
    return None


def _target(prof: dict) -> urllib.parse.SplitResult:
    t = prof["target"]
    p = urllib.parse.urlsplit(t)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"target must be an http(s) URL, got {t!r}")
    if not profile_mod.is_loopback(t):
        raise ValueError(f"REFUSED: {t!r} is not a loopback address; attacks only go to the profile's local address")
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


def redact(raw: str, secret_field: str = "secret_note") -> str:
    """Body for the hosted agent / events: the profile's secret field masked, everything truncated."""
    try:
        d = json.loads(raw)
    except ValueError:
        return raw[:200]
    if isinstance(d, dict) and secret_field in d:
        d[secret_field] = str(d[secret_field])[:4] + "***"
    return json.dumps(d)[:300]


def _json(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _login(tp, prof: dict, username: str) -> str | None:
    """Log in via the profile's route/fields. The password is read from the profile file in code."""
    lg = prof["login"]
    body = {lg["username_field"]: username, lg["password_field"]: prof["users"][username]["password"]}
    status, cookies, _ = _request(tp, "POST", lg["path"], body)
    cookie = next((c.split(";", 1)[0] for c in cookies if c.startswith(lg["session_cookie"] + "=")), None)
    if status != 200 or not cookie:
        return None
    return cookie


def _record_path(prof: dict, rid: str) -> str:
    return prof["routes"]["record"].replace("{id}", urllib.parse.quote(rid, safe=""))


def _err(attack, params, msg) -> dict:
    return {"status": "ERROR", "attack": attack, "params": dict(params) if isinstance(params, dict) else params,
            "error": msg[:300], "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}


def _idor_read(tp, prof: dict, attacker: str, victim: str) -> dict:
    out = {"status": "ERROR", "attack": "idor_read", "params": {"attacker": attacker, "victim_order": victim},
           "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}
    cookie = _login(tp, prof, attacker)
    if not cookie:
        out["error"] = f"login as {attacker} failed; this is a setup problem, not a proof"
        return out

    own = prof["users"][attacker]["records"][0]
    c_status, _, c_raw = _request(tp, "GET", _record_path(prof, own), cookie=cookie)
    c_body = _json(c_raw)
    c_ok = c_status == 200 and isinstance(c_body, dict) and c_body.get("id") == own
    out["control"] = {"ok": c_ok, "detail": f"{attacker} reading own record {own}: HTTP {c_status}"
                      + ("" if c_ok else " (the route no longer serves the owner)")}

    path = _record_path(prof, victim)
    a_status, _, a_raw = _request(tp, "GET", path, cookie=cookie)
    body = _json(a_raw)
    leaked = a_status == 200 and isinstance(body, dict) and body.get("id") == victim
    if a_status >= 500 or (not leaked and not c_ok and c_status >= 500):
        out["error"] = f"target answered HTTP {a_status}/{c_status} (server error, maybe recompiling)"
        out["status"] = "ERROR"
    else:
        out["status"] = "PROVEN" if leaked else "BLOCKED"
    out["evidence"] = {"request": f"GET {path} (logged in as {attacker})", "status_code": a_status,
                       "body_redacted": redact(a_raw, prof["secret_field"])}
    out["evidence_local"] = {"body": a_raw[:5000]}
    return out


def _unauth_read(tp, prof: dict, record: str) -> dict:
    """Read a record without logging in at all: proves missing authentication."""
    out = {"status": "ERROR", "attack": "unauth_read", "params": {"record": record},
           "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}

    # control: a logged-in owner must still be able to read their own record (server up, login works)
    u0 = next(iter(prof["users"]))
    own_recs = prof["users"][u0]["records"]
    c_status = None
    if own_recs:
        cookie = _login(tp, prof, u0)
        if not cookie:
            out["control"] = {"ok": False, "detail": f"login as {u0} failed; setup problem"}
        else:
            own = own_recs[0]
            c_status, _, c_raw = _request(tp, "GET", _record_path(prof, own), cookie=cookie)
            c_body = _json(c_raw)
            c_ok = c_status == 200 and isinstance(c_body, dict) and c_body.get("id") == own
            out["control"] = {"ok": c_ok, "detail": f"logged in as {u0}, reading own record {own}: HTTP {c_status}"}
    else:
        out["control"] = {"ok": True, "detail": "profile lists no own record; control skipped"}

    path = _record_path(prof, record)
    a_status, _, a_raw = _request(tp, "GET", path)  # anonymous: no cookie, no credentials
    body = _json(a_raw)
    leaked = a_status == 200 and isinstance(body, dict) and body.get("id") == record
    if a_status >= 500 or (c_status is not None and c_status >= 500):
        out["error"] = f"target answered HTTP {a_status}/{c_status} (server error, maybe recompiling)"
        out["status"] = "ERROR"
    else:
        out["status"] = "PROVEN" if leaked else "BLOCKED"
    out["evidence"] = {"request": f"GET {path} (no login, no cookie)", "status_code": a_status,
                       "body_redacted": redact(a_raw, prof["secret_field"])}
    out["evidence_local"] = {"body": a_raw[:5000]}
    return out


def run(attack: str, params: dict, target: str | None = None, retry: bool = False, profile=None) -> dict:
    """retry=True: after a fix, keep trying for ~6 s until BLOCKED with a passing control (next dev hot reload)."""
    try:
        prof = _prof(profile, target)
    except ValueError as e:
        return _err(attack, params, f"{type(e).__name__}: {e}")
    err = validate(attack, params, prof)
    if err:
        return _err(attack, params, err)
    deadline = time.monotonic() + (RETRY_SECONDS if retry else 0)
    while True:
        try:
            tp = _target(prof)
            if attack == "idor_read":
                res = _idor_read(tp, prof, params["attacker"], params["victim_order"])
            else:
                res = _unauth_read(tp, prof, params["record"])
        except Exception as e:  # unreachable / refused / non-local / timeout / guard: ERROR, never BLOCKED
            res = _err(attack, params, f"{type(e).__name__}: {e}")
            res["control"] = {"ok": False, "detail": "target unreachable"}
        if not retry or (res["status"] == "BLOCKED" and res["control"]["ok"]) or time.monotonic() >= deadline:
            return res
        time.sleep(0.5)


if __name__ == "__main__":
    import os
    print(json.dumps(run("idor_read", {"attacker": "alice", "victim_order": "ord_b1"},
                         os.environ.get("VIGIL_TARGET_URL")), indent=2))
    print(json.dumps(run("unauth_read", {"record": "ord_b1"}), indent=2))
