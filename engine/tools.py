"""The Detective's four tools (+ rollback), scoped to one app root. Plain stdlib; every method returns a dict and never raises.

    t = Tools(app_path, target=None, emit=None, approved=None)
    t.vigil_scan(path=".")              -> {"result", "tree", "findings"}
    t.read_file(path)                   -> {"path", "content"}   (secrets masked as ***)
    t.run_proof(attack, params, retry=False) -> see attacks.run
    t.apply_fix(file, new_content)      -> {"applied": True, "file", "backup_id"}
    t.rollback(backup_id)               -> {"rolled_back": True, "file"}

emit(type, character, text, **fields) receives tool_call / tool_result / proof / fix_applied / rollback events,
so every planner (offline or Mistral) produces the same event stream. approved(file, new_content) -> bool is the
gate's check that this exact patch was approved; apply_fix refuses otherwise.
"""
from __future__ import annotations

import fnmatch
import re
import sys
import uuid
from pathlib import Path

import attacks
import profile as profile_mod

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "harness"))
import vigil  # noqa: E402

MAX_BYTES = 200_000
# .vigil/ holds target.json with the test passwords: never readable, scannable or writable.
DENY_DIRS = {"data", "node_modules", ".next", ".git", ".vigil"}
# Same trigger as harness/packs/general.json "hardcoded-secret", with the quoted value captured so it can be masked.
SECRET_RE = re.compile(r"""((?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\w*\s*[:=]\s*)(["'])[^"'\s]{12,}\2""", re.I)
CHARACTER = {"vigil_scan": "scout", "read_file": "detective", "run_proof": "detective",
             "apply_fix": "mechanic", "rollback": "mechanic"}


def mask(text: str) -> str:
    return SECRET_RE.sub(r"\1\2***\2", text)


def _noop_emit(*a, **k):
    return None


class Tools:
    def __init__(self, app_path, target=None, emit=None, approved=None):
        self.root = Path(app_path).resolve()
        self.emit = emit or _noop_emit
        self.approved = approved
        try:  # the repo's .vigil/target.json decides address/routes/users; target only overrides the address
            self.profile = profile_mod.load_profile(self.root, target)
            self.profile_error = None
        except ValueError as e:
            self.profile = profile_mod.normalize(profile_mod.DEFAULT_PROFILE, target, source="fallback")
            self.profile_error = str(e)
        self.target = self.profile["target"]
        self.backups: dict[str, tuple[Path, bytes]] = {}
        try:
            lines = (self.root / ".gitignore").read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        self.ignore = [ln.strip().strip("/").lower() for ln in lines if ln.strip() and not ln.startswith(("#", "!"))]

    # ------------------------------------------------------------ guard
    def _resolve(self, path: str) -> tuple[Path | None, str]:
        """(absolute path, "") if allowed, else (None, reason). Checks the RESOLVED path, case-insensitively."""
        try:
            p = (self.root / str(path)).resolve()
            rel = p.relative_to(self.root).as_posix()
        except (ValueError, OSError):
            return None, "path is outside the app root"
        parts = rel.lower().split("/")
        if rel == ".":
            return p, ""
        if any(x.startswith(".env") for x in parts):
            return None, "secret env files are never readable"
        if DENY_DIRS & set(parts[:-1]) or parts[-1] in DENY_DIRS:
            return None, "path is in a denied directory (data/, node_modules/, .next/, .git/)"
        low = rel.lower()
        # shortcut: fnmatch on the whole path and on each part, not full gitignore semantics; good enough for app .gitignores
        for pat in self.ignore:
            if fnmatch.fnmatch(low, pat) or any(fnmatch.fnmatch(x, pat) for x in parts):
                return None, f"path is gitignored ({pat})"
        return p, ""

    def _file(self, path: str):
        p, why = self._resolve(path)
        if p is None:
            return None, why
        if not p.is_file():
            return None, "not a file"
        if p.stat().st_size > MAX_BYTES:
            return None, "file is larger than 200 KB"
        return p, ""

    def _call(self, tool, args, fn, summarize):
        self.emit("tool_call", CHARACTER[tool], f"{tool}({', '.join(f'{k}={v!r}' for k, v in args.items() if k != 'new_content')})",
                  tool=tool, args={k: v for k, v in args.items() if k != "new_content"})
        try:
            res = fn()
        except Exception as e:  # tools never raise
            res = {"error": f"{type(e).__name__}: {e}"[:300]}
        summary = res["error"] if "error" in res else summarize(res)
        self.emit("tool_result", CHARACTER[tool], summary, tool=tool, summary=summary)
        return res

    # ------------------------------------------------------------ tools
    def vigil_scan(self, path: str = ".") -> dict:
        def go():
            p, why = self._resolve(path)
            if p is None:
                return {"error": why}
            _, findings = vigil.scan(p)
            tree = sorted(r for r in (f.relative_to(self.root).as_posix() for f in vigil.iter_files(p))
                          if self._resolve(r)[0] is not None)
            keep = ("rule", "title", "severity", "level", "attack", "file", "line", "match", "fix")
            out = []
            for f in findings:
                f = {k: f.get(k) for k in keep}
                f["file"] = (p / f["file"]).relative_to(self.root).as_posix()
                f["match"] = mask(f["match"] or "")
                out.append(f)
            # the profile WITHOUT passwords: lets a hosted model pick valid users/records/routes
            prof = profile_mod.sanitized(self.profile)
            if self.profile_error:
                prof["error"] = self.profile_error
            return {"result": vigil.result(findings), "tree": tree, "findings": out, "profile": prof}
        return self._call("vigil_scan", {"path": path}, go,
                          lambda r: f"scan {r['result']}: {len(r['findings'])} finding(s) in {len(r['tree'])} files")

    def read_file(self, path: str) -> dict:
        def go():
            p, why = self._file(path)
            if p is None:
                return {"error": why}
            text = p.read_bytes().decode("utf-8", "replace")  # bytes: keep CRLF exactly
            return {"path": p.relative_to(self.root).as_posix(), "content": mask(text)}
        return self._call("read_file", {"path": path}, go,
                          lambda r: f"read {r['path']} ({r['content'].count(chr(10)) + 1} lines)")

    def run_proof(self, attack: str, params: dict, retry: bool = False) -> dict:
        if self.profile_error:
            res = {"status": "ERROR", "attack": attack, "params": params,
                   "error": f"invalid target profile: {self.profile_error}",
                   "evidence": {}, "control": {"ok": False, "detail": "not run"}, "evidence_local": {}}
            self._call("run_proof", {"attack": attack, "params": params}, lambda: res,
                       lambda r: f"proof {r['status']}: {r['error']}")
            return res
        res = self._call("run_proof", {"attack": attack, "params": params},
                         lambda: attacks.run(attack, params, profile=self.profile, retry=retry),
                         lambda r: f"proof {r['status']}" + (f": {r['error']}" if r.get("error") else ""))
        if "status" in res:
            p = res["params"]
            atk = res.get("attack")
            if atk == "idor_read":
                who, vic = p.get("attacker"), p.get("victim_order")
                text = {"PROVEN": f"PROVEN: {who} read someone else's record {vic} just by changing the id in the URL.",
                        "BLOCKED": f"BLOCKED: {who} could not read record {vic}.",
                        }.get(res["status"], f"ERROR: the proof could not run ({res.get('error', 'unknown')}).")
            elif atk == "unauth_read":
                rec = p.get("record")
                code = res["evidence"].get("status_code")
                text = {"PROVEN": f"PROVEN: record {rec} was served to an anonymous request — no login at all.",
                        "BLOCKED": f"BLOCKED: the anonymous request for {rec} was refused (HTTP {code}).",
                        }.get(res["status"], f"ERROR: the proof could not run ({res.get('error', 'unknown')}).")
            else:
                text = f"{res['status']}: {atk} {p}"
            if res["status"] != "ERROR":
                text += " Control: " + ("the owner can still read their own record." if res["control"]["ok"]
                                        else "the owner can NOT read their own record any more.")
            self.emit("proof", "detective", text, status=res["status"], attack=atk, params=p,
                      evidence=res["evidence"], evidence_local=res["evidence_local"], control=res["control"])
        return res

    def apply_fix(self, file: str, new_content: str) -> dict:
        def go():
            p, why = self._file(file)
            if p is None:
                return {"error": why}
            if not isinstance(new_content, str) or len(new_content.encode()) > MAX_BYTES:
                return {"error": "new_content must be a string under 200 KB"}
            if self.approved is None or not self.approved(file, new_content):
                return {"error": "this exact patch was not approved at the gate"}
            old = p.read_bytes()
            text = old.decode("utf-8", "replace")
            if mask(text) != text:  # read_file showed *** here; writing a whole file back would destroy the real secret
                return {"error": "file contains masked secrets; refusing a whole-file rewrite"}
            bid = uuid.uuid4().hex[:12]
            self.backups[bid] = (p, old)
            p.write_bytes(new_content.encode("utf-8"))
            return {"applied": True, "file": p.relative_to(self.root).as_posix(), "backup_id": bid}
        res = self._call("apply_fix", {"file": file, "new_content": new_content}, go,
                         lambda r: f"patched {r['file']} (backup {r['backup_id']})")
        if res.get("applied"):
            self.emit("fix_applied", "mechanic", f"Fix applied to {res['file']}.", file=res["file"])
        return res

    def rollback(self, backup_id: str, reason: str = "") -> dict:
        def go():
            if backup_id not in self.backups:
                return {"error": "unknown backup_id"}
            p, old = self.backups[backup_id]
            if self._resolve(p.relative_to(self.root).as_posix())[0] is None:
                return {"error": "backup path is no longer allowed"}
            p.write_bytes(old)
            return {"rolled_back": True, "file": p.relative_to(self.root).as_posix()}
        res = self._call("rollback", {"backup_id": backup_id}, go, lambda r: f"restored {r['file']}")
        if res.get("rolled_back"):
            self.emit("rollback", "mechanic", f"Rolled back {res['file']}: {reason or 'fix did not hold'}.",
                      file=res["file"], reason=reason)
        return res
