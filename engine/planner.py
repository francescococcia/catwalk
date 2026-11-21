"""Offline scripted Detective: no network to Mistral, no model.

Planner interface (engine/mistral_agent.py implements the same one):

    plan(app_path: str, tools, gate, emit) -> str   # verdict: "PASS" | "FIXED" | "PROVEN" | "BLOCK" | "ERROR"

    tools : tools.Tools (vigil_scan, read_file, run_proof(attack, params, retry=False), apply_fix, rollback).
            Tools already emit tool_call / tool_result / proof / fix_applied / rollback events.
            A proof result's "evidence_local" holds the full leaked body: never forward it to a hosted model,
            use "evidence" (redacted) instead.
    gate  : gate.request(kind="apply_fix", file=..., new_content=..., diff=..., reason=...) -> bool.
            Blocks until a human answers on the live page. apply_fix refuses any patch the gate did not approve.
    emit  : emit(type, character, text, **fields). The planner emits "thinking" (character "detective") and
            "scan_done"; run.py emits run_started / verdict / run_finished around plan().
"""
from __future__ import annotations

import difflib
import re

import profile as profile_mod

AUTH_PRESENT = re.compile(r"(getServerSession|getSession\w*\(|auth\(|currentUser|getUser\(|requireUser|verifyToken|clerk|withAuth)", re.I)


def pick_attack_params(prof: dict) -> tuple[str, str | None]:
    """(attacker, victim_record) from the target profile: first user vs another user's first record."""
    names = list(prof["users"])
    attacker = names[0]
    for other in names[1:]:
        if prof["users"][other]["records"]:
            return attacker, prof["users"][other]["records"][0]
    return attacker, None


def make_auth_fix(text: str) -> tuple[str, str] | None:
    """Insert a 401 session guard at the top of the exported handler. Returns (new_text, reason) or None."""
    if AUTH_PRESENT.search(text):
        return None  # an auth check is already present; the attack should have been BLOCKED
    m = re.search(r"export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b[^{]*\{", text)
    if not m:
        return None
    guard = ("\n  const userId = await getSessionUserId();"
             "\n  if (!userId) {"
             '\n    return NextResponse.json({ error: "not authenticated" }, { status: 401 });'
             "\n  }")
    new = text[:m.end()] + guard + text[m.end():]
    return new, ("Add a session check at the top of the handler: `const userId = await getSessionUserId(); "
                 "if (!userId) return 401`. Anonymous requests must never reach the record lookup.")


def make_fix(text: str) -> tuple[str, str] | None:
    """Insert an inline ownership check into the record's not-found guard. Returns (new_text, reason) or None."""
    uid = re.search(r"const\s+(\w+)\s*=\s*await\s+get\w*User\w*\(", text)
    rec = re.search(r"if\s*\(\s*!(\w+)\s*\)(\s*\{?\s*[^\n]*\b404\b)", text)  # the not-found guard
    if not uid or not rec:
        return None
    r, u = rec.group(1), uid.group(1)
    new = text[:rec.start()] + f"if (!{r} || {r}.user_id !== {u}){rec.group(2)}" + text[rec.end():]
    return new, (f"Return 404 unless the logged-in user owns the {r}: `if (!{r} || {r}.user_id !== {u})`. "
                 "Same answer as 'not found', so the id of someone else's record leaks nothing.")


def plan(app_path, tools, gate, emit) -> str:
    think = lambda text: emit("thinking", "detective", text)  # noqa: E731
    scan = tools.vigil_scan(".")
    if "error" in scan:
        return "ERROR"
    n = len(scan["findings"])
    emit("scan_done", "scout", f"Scan {scan['result']}: {n} finding(s)" +
         (": " + "; ".join(f"{f['title']} in {f['file']}" for f in scan["findings"]) if n else "."),
         result=scan["result"], findings=scan["findings"])
    provable = [f for f in scan["findings"] if f.get("attack")]
    if not provable:
        think("No finding comes with an attack I am allowed to run, so I go with the scanner's verdict.")
        return "BLOCK" if scan["result"] == "BLOCK" else "PASS"

    prof = getattr(tools, "profile", None) or profile_mod.load_profile(app_path)
    verdicts = [_investigate(f, tools, gate, think, prof) for f in provable]
    if scan["result"] == "BLOCK":
        verdicts.append("BLOCK")  # a block-level rule elsewhere still blocks after the proofs
    return next((v for v in ("PROVEN", "ERROR", "BLOCK", "FIXED") if v in verdicts), "PASS")


def _investigate(f, tools, gate, think, prof) -> str:
    think(f"The scanner suspects '{f['title']}' in {f['file']} line {f['line']}. "
          "A suspicion is not a proof, so I will read the code and then try the attack for real.")
    src = tools.read_file(f["file"])
    if "error" in src:
        think(f"I cannot read {f['file']} ({src['error']}), so I stop here.")
        return "ERROR"

    attacker, victim = pick_attack_params(prof)  # users and records come from .vigil/target.json
    atk = f.get("attack")
    if atk == "idor_read":
        if not victim or not prof["users"][attacker]["records"]:
            think("The profile has no second user with records, so idor_read cannot run.")
            return "ERROR"
        params = {"attacker": attacker, "victim_order": victim}
        fix_fn, fix_kind = make_fix, "an ownership check"
        think("The handler checks that you are logged in but loads the record by id alone. "
              f"I will log in as {attacker} and ask for {victim}, a record that belongs to someone else.")
    elif atk == "unauth_read":
        record = victim or (prof["users"][attacker]["records"] or [None])[0]
        if not record:
            think("The profile lists no record to test anonymously.")
            return "ERROR"
        params = {"record": record}
        fix_fn, fix_kind = make_auth_fix, "a login check"
        think(f"This route may answer without any login. I will ask for {record} with no credentials at all.")
    else:
        think(f"I have no scripted plan for attack '{atk}'.")
        return "ERROR"

    proof = tools.run_proof(atk, params)
    if proof.get("status") == "ERROR":
        think("The proof could not run (app down or login failed). That is an error, not a pass.")
        return "ERROR"
    if proof["status"] == "BLOCKED":
        think("The attack was blocked, so this suspicion is a false alarm.")
        return "PASS"

    think(f"Proven. Now I write the smallest fix: {fix_kind}.")
    fix = fix_fn(src["content"])
    if not fix:
        think("I could not find a safe place to insert the check automatically. Leaving it for a human.")
        return "PROVEN"
    new, reason = fix
    diff = "".join(difflib.unified_diff(src["content"].splitlines(True), new.splitlines(True),
                                        f"a/{src['path']}", f"b/{src['path']}"))
    think("The fix goes to the gatekeeper first. Nothing is written until a human approves it.")
    if not gate.request(kind="apply_fix", file=src["path"], new_content=new, diff=diff, reason=reason):
        think("The fix was denied, so the vulnerability stays proven and the file is untouched.")
        return "PROVEN"

    applied = tools.apply_fix(src["path"], new)
    if not applied.get("applied"):
        think(f"The fix could not be applied ({applied.get('error')}).")
        return "PROVEN"
    try:
        think("Fix applied. I run the same attack again, giving the dev server a few seconds to reload.")
        again = tools.run_proof(atk, params, retry=True)
        if again.get("status") == "BLOCKED" and again["control"]["ok"]:
            think("Blocked now, and the owner can still read their own record. The fix holds.")
            return "FIXED"
        why = ("the attack still works" if again.get("status") == "PROVEN"
               else "the owner can no longer read their own record" if again.get("status") == "BLOCKED"
               else "the app did not answer after the fix")
    except Exception as e:  # any crash after writing must still roll back
        why = f"re-proof crashed ({type(e).__name__})"
    think(f"The fix did not hold: {why}. Rolling back to the original file.")
    tools.rollback(applied["backup_id"], reason=why)
    return "PROVEN"
