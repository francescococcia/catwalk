"""Target profile: `.vigil/target.json` in the app root.

One profile per repo describes the app's local address, how to log in, the test
users, which records each user owns, and the routes to test. The attacks
(engine/attacks.py) read all of this from the file instead of having it
written into the code, so the same engine works on any repo: drop a profile in
and point the run at the repo.

Safety rules, enforced here and again in attacks.py:
- `target` must be a loopback address (localhost / 127.0.0.0/8 / ::1). Attacks
  only ever go to the profile's local address, whatever flags or the model say.
- Passwords live ONLY in this file. Attack params may never carry credentials
  (attacks.validate rejects credential-looking keys), and read_file refuses the
  `.vigil/` directory, so the model can never read them either.

    prof = load_profile(app_path, target_override=None)   # raises ValueError when unsafe
    prof["target"]            # "http://localhost:3001"
    prof["login"]             # {"path", "username_field", "password_field", "session_cookie"}
    prof["users"]             # {"alice": {"password": ..., "records": ["ord_a1", ...]}}
    prof["routes"]["record"]  # "/api/orders/{id}"
    prof["record_id_pattern"] # "^ord_[a-z0-9]{1,16}$"
    prof["secret_field"]      # "secret_note" (masked in evidence sent off-machine)
    sanitized(prof)           # the same profile WITHOUT passwords: the only shape a model may see
"""
from __future__ import annotations

import copy
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

PROFILE_REL = ".vigil/target.json"

# Fallback when a repo has no .vigil/target.json yet: the seeded demo-app values.
DEFAULT_PROFILE = {
    "target": "http://localhost:3001",
    "login": {"path": "/api/login", "username_field": "username", "password_field": "password",
              "session_cookie": "vigil_session"},
    "users": [
        {"name": "alice", "password": "alice123", "records": ["ord_a1", "ord_a2"]},
        {"name": "bob", "password": "bob123", "records": ["ord_b1", "ord_b2"]},
    ],
    "routes": {"record": "/api/orders/{id}"},
    "record_id_pattern": "^ord_[a-z0-9]{1,16}$",
    "secret_field": "secret_note",
}

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
COOKIE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def is_loopback(url: str) -> bool:
    """True for http(s) URLs whose host is localhost / 127.0.0.0/8 / ::1."""
    try:
        p = urlsplit(url)
    except ValueError:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    h = p.hostname.strip("[]").lower()
    if h == "localhost" or h.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def _check_route(path, what: str, need_id: bool = False) -> str:
    """A route template on the target host: absolute path, no scheme, no escape."""
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or "://" in path or ".." in path.split("/")):
        raise ValueError(f"{what} must be an absolute path on the target host (no scheme, no '..'), got {path!r}")
    if need_id and "{id}" not in path:
        raise ValueError(f"{what} must contain the {{id}} placeholder, got {path!r}")
    return path


def normalize(data, target_override=None, source="profile") -> dict:
    """Validate a raw profile dict and return the canonical form. Raises ValueError when unsafe.

    Accepts `users` as a list of {"name","password","records"} (file form) or as the
    canonical dict {"name": {"password","records"}} (already-normalized form).
    """
    if not isinstance(data, dict):
        raise ValueError(f"{source}: profile must be a JSON object")
    data = copy.deepcopy(data)

    target = target_override if target_override is not None else data.get("target")
    if not isinstance(target, str) or not is_loopback(target):
        raise ValueError(f"{source}: target must be a local http(s) URL (loopback only, attacks never leave "
                         f"this machine), got {target!r}")
    data["target"] = target.strip().rstrip("/")

    login = data.get("login")
    if not isinstance(login, dict):
        raise ValueError(f"{source}: 'login' must be an object")
    lg = {"path": _check_route(login.get("path"), "login.path")}
    for k in ("username_field", "password_field"):
        v = login.get(k)
        if not isinstance(v, str) or not NAME_RE.match(v):
            raise ValueError(f"{source}: login.{k} must be a short field name, got {v!r}")
        lg[k] = v
    if not isinstance(login.get("session_cookie"), str) or not COOKIE_RE.match(login["session_cookie"]):
        raise ValueError(f"{source}: login.session_cookie must be a cookie name, got {login.get('session_cookie')!r}")
    lg["session_cookie"] = login["session_cookie"]
    data["login"] = lg

    pat = data.get("record_id_pattern") or DEFAULT_PROFILE["record_id_pattern"]
    if not isinstance(pat, str):
        raise ValueError(f"{source}: record_id_pattern must be a string")
    try:
        re.compile(pat)
    except re.error as e:
        raise ValueError(f"{source}: record_id_pattern does not compile: {e}")
    data["record_id_pattern"] = pat
    id_re = re.compile(pat)

    users_raw = data.get("users")
    if isinstance(users_raw, dict):
        items = [(n, u) for n, u in users_raw.items()]
    elif isinstance(users_raw, list):
        items = [(u.get("name"), u) for u in users_raw if isinstance(u, dict)]
    else:
        items = []
    if not items:
        raise ValueError(f"{source}: 'users' must list at least one test user with a password and records")
    users: dict[str, dict] = {}
    for name, u in items:
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise ValueError(f"{source}: user name must match {NAME_RE.pattern}, got {name!r}")
        if name in users:
            raise ValueError(f"{source}: duplicate user {name!r}")
        pw = u.get("password")
        # passwords exist only in this file: never in code, never from the model, never in params
        if not isinstance(pw, str) or not pw:
            raise ValueError(f"{source}: password for {name!r} must be a non-empty string in {PROFILE_REL}")
        recs = u.get("records") or []
        if not isinstance(recs, list) or not all(isinstance(r, str) for r in recs):
            raise ValueError(f"{source}: records of {name!r} must be a list of strings")
        for r in recs:
            if not id_re.match(r):
                raise ValueError(f"{source}: record {r!r} of {name!r} does not match record_id_pattern {pat!r}")
        users[name] = {"password": pw, "records": list(recs)}
    data["users"] = users

    routes = data.get("routes")
    if not isinstance(routes, dict):
        raise ValueError(f"{source}: 'routes' must be an object")
    data["routes"] = {"record": _check_route(routes.get("record"), "routes.record", need_id=True)}

    data["secret_field"] = str(data.get("secret_field") or "secret_note")
    data["_source"] = source
    return data


def load_profile(app_path, target_override=None) -> dict:
    """Read <app_path>/.vigil/target.json, or fall back to the built-in demo profile.

    Raises ValueError on anything missing, malformed or unsafe (e.g. non-local target).
    """
    p = Path(app_path) / PROFILE_REL
    if p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise ValueError(f"cannot parse {p}: {e}")
        return normalize(data, target_override, source=str(p))
    return normalize(DEFAULT_PROFILE, target_override, source="built-in demo profile")


def sanitized(profile: dict) -> dict:
    """The profile WITHOUT passwords: the only shape shown to a (hosted) model via vigil_scan."""
    return {
        "target": profile["target"],
        "login": {k: profile["login"][k] for k in ("path", "username_field", "session_cookie")},
        "users": [{"name": n, "records": list(u["records"])} for n, u in profile["users"].items()],
        "routes": dict(profile["routes"]),
        "record_id_pattern": profile["record_id_pattern"],
        "secret_field": profile["secret_field"],
    }
