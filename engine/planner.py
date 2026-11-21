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

# Known demo order ids per user (attacker alice attacks bob's order).
VICTIM = {"alice": "ord_b1", "bob": "ord_a1"}


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

    verdicts = [_investigate(f, tools, gate, think) for f in provable]
    if scan["result"] == "BLOCK":
        verdicts.append("BLOCK")  # a block-level rule elsewhere still blocks after the proofs
    return next((v for v in ("PROVEN", "ERROR", "BLOCK", "FIXED") if v in verdicts), "PASS")


def _investigate(f, tools, gate, think) -> str:
    think(f"The scanner suspects '{f['title']}' in {f['file']} line {f['line']}. "
          "A suspicion is not a proof, so I will read the code and then try the attack for real.")
    src = tools.read_file(f["file"])
    if "error" in src:
        think(f"I cannot read {f['file']} ({src['error']}), so I stop here.")
        return "ERROR"
    if f["attack"] != "idor_read":
        think(f"I have no scripted plan for attack '{f['attack']}'.")
        return "ERROR"
    params = {"attacker": "alice", "victim_order": VICTIM["alice"]}
    think("The handler checks that you are logged in but loads the order by id alone. "
          f"I will log in as alice and ask for {params['victim_order']}, an order that belongs to bob.")
    proof = tools.run_proof("idor_read", params)
    if proof.get("status") == "ERROR":
        think("The proof could not run (app down or login failed). That is an error, not a pass.")
        return "ERROR"
    if proof["status"] == "BLOCKED":
        think("The attack was blocked, so this suspicion is a false alarm.")
        return "PASS"

    think("Proven: alice read bob's private order. Now I write the smallest fix: an ownership check.")
    fix = make_fix(src["content"])
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
        again = tools.run_proof("idor_read", params, retry=True)
        if again.get("status") == "BLOCKED" and again["control"]["ok"]:
            think("Blocked now, and alice can still read her own order. The fix holds.")
            return "FIXED"
        why = ("the attack still works" if again.get("status") == "PROVEN"
               else "the owner can no longer read their own order" if again.get("status") == "BLOCKED"
               else "the app did not answer after the fix")
    except Exception as e:  # any crash after writing must still roll back
        why = f"re-proof crashed ({type(e).__name__})"
    think(f"The fix did not hold: {why}. Rolling back to the original file.")
    tools.rollback(applied["backup_id"], reason=why)
    return "PROVEN"
