"""Vigil engine: run the Detective against an app and serve the live page.

    uv run --project engine engine/run.py <app_path> [--target http://localhost:3001]
        [--mode offline|mistral] [--port 8765] [--no-narrate]

See engine/CONTRACT.md. Binds 127.0.0.1 only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import planner  # noqa: E402
from tools import Tools  # noqa: E402

LIVE_HTML = HERE.parent / "harness" / "viewer" / "live.html"
NARRATE_TYPES = {"scan_done", "proof", "fix_proposed", "verdict"}
APPROVAL_TIMEOUT = 600
SCOUT_WAIT = float(os.environ.get("VIGIL_SCOUT_WAIT", "90"))  # seconds the Detective waits for Ministral before attacking


class EventLog:
    """Ordered event list + JSONL file + wake-up for SSE readers. emit(type, character, text, **fields) -> event."""

    def __init__(self, path: Path | None = None, narrate=None, scout=None):
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.path = path
        self.narrate = narrate
        self.scout = scout  # scout(finding) -> {"agrees","confidence","explanation","fix"}: Ministral, local
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, type, character, text, **fields):
        with self.cond:
            ev = {"seq": len(self.events) + 1, "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                  "type": type, "character": character, "text": text, **fields}
            self.events.append(ev)
            if self.path:
                with self.path.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(ev) + "\n")
            self.cond.notify_all()
        if self.scout and type == "scan_done" and fields.get("findings"):
            # synchronous on purpose: the planner that emitted scan_done waits here, so the Scout
            # explains BEFORE the Detective attacks (both planners). Capped so a slow model can't stall the demo.
            self.emit("thinking", "scout", "Ministral Scout is reading the suspect code...")
            t = threading.Thread(target=self._explain, args=(ev,), daemon=True)
            t.start()
            t.join(SCOUT_WAIT)
        if self.narrate and type in NARRATE_TYPES:  # after the Scout, so they don't queue on the same local GPU
            threading.Thread(target=self._narrate, args=(ev,), daemon=True).start()
        return ev

    def _explain(self, ev):
        """Ministral Scout explains each suspect. Advice only: never changes the verdict (rules + attack decide)."""
        for f in ev["findings"]:
            try:
                m = self.scout(f)
                if not m or not m.get("explanation"):
                    continue
                self.emit("explanation", "scout", f"Ministral Scout: {m['explanation']}",
                          for_seq=ev["seq"], file=f.get("file"), rule=f.get("rule"),
                          agrees=m.get("agrees"), confidence=m.get("confidence"), fix=m.get("fix"))
            except Exception:
                pass  # explanation is advice; the rules and the attack decide

    def _narrate(self, ev):
        try:
            safe = {k: v for k, v in ev.items() if k != "evidence_local"}  # full leaked body never leaves this machine
            out = self.narrate(safe)
            if out and out.get("line"):
                self.emit("narration", out.get("character") or ev["character"], out["line"],
                          for_seq=ev["seq"], line=out["line"])
        except Exception:
            pass  # narration is decoration; never break the run


class Gate:
    """Human approval. Patches stay server-side, keyed by approval_id; the browser only answers allow/deny."""

    def __init__(self, emit, timeout=APPROVAL_TIMEOUT):
        self.emit = emit
        self.timeout = timeout
        self.pending: dict[str, dict] = {}
        self.ok: set[tuple[str, str]] = set()  # (file, sha256(content)) approved
        self.lock = threading.Lock()

    @staticmethod
    def _key(file, content):
        return (str(file).replace("\\", "/"), hashlib.sha256(content.encode("utf-8")).hexdigest())

    def request(self, kind="apply_fix", file="", new_content="", diff="", reason="") -> bool:
        aid = uuid.uuid4().hex[:12]
        item = {"kind": kind, "file": file, "new_content": new_content, "done": threading.Event(), "decision": "deny"}
        with self.lock:
            self.pending[aid] = item
        self.emit("fix_proposed", "mechanic", f"Proposed fix for {file}: {reason}",
                  approval_id=aid, file=file, diff=diff, reason=reason)
        if not item["done"].wait(self.timeout):
            self.answer(aid, "deny")
        return item["decision"] == "allow"

    def answer(self, aid, decision) -> bool:
        if decision not in ("allow", "deny"):
            return False
        with self.lock:
            item = self.pending.pop(aid, None)
        if item is None:
            return False
        item["decision"] = decision
        if decision == "allow":
            self.ok.add(self._key(item["file"], item["new_content"]))
        self.emit("approval", "gatekeeper", f"Fix {'approved' if decision == 'allow' else 'denied'} by a human.",
                  approval_id=aid, decision=decision)
        item["done"].set()
        return True

    def approved(self, file, new_content) -> bool:
        return self._key(file, new_content) in self.ok


def _optional(name):
    try:
        return __import__(name)
    except Exception:
        return None


def run(app_path, target, mode, log: EventLog, gate: Gate | None = None) -> str:
    """One full run. Returns the verdict and emits verdict + run_finished."""
    emit = log.emit
    gate = gate or Gate(emit)
    tools = Tools(app_path, target=target, emit=emit, approved=gate.approved)
    emit("run_started", "scout", f"Checking {Path(app_path).name} against {target} ({mode} mode).",
         app=str(app_path), target=target, mode=mode)
    impl = planner
    if mode == "mistral":
        m = _optional("mistral_agent")
        if m is None or not hasattr(m, "plan"):
            emit("error", "gatekeeper", "Mistral agent unavailable; falling back to the offline Detective.",
                 message="import mistral_agent failed")
        else:
            impl = m
    try:
        verdict = impl.plan(str(app_path), tools, gate, emit)
    except Exception as e:
        emit("error", "gatekeeper", f"The planner crashed: {type(e).__name__}.", message=f"{type(e).__name__}: {e}"[:300])
        verdict = "ERROR"
    if verdict not in ("PASS", "FIXED", "PROVEN", "BLOCK", "ERROR"):
        verdict = "ERROR"
    emit("verdict", "gatekeeper", {
        "PASS": "Verdict PASS: nothing exploitable found.",
        "FIXED": "Verdict FIXED: the attack was proven, the fix was approved, and the same attack is now blocked.",
        "PROVEN": "Verdict PROVEN: the vulnerability is real and still open.",
        "BLOCK": "Verdict BLOCK: high-risk findings block this change.",
        "ERROR": "Verdict ERROR: the check could not complete, so nothing is proven safe.",
    }[verdict], result=verdict)
    emit("run_finished", "gatekeeper", "Run finished.")
    return verdict


def make_handler(log: EventLog, gate: Gate):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body: bytes, ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlsplit(self.path)
            if u.path == "/":
                body = LIVE_HTML.read_bytes() if LIVE_HTML.exists() else (
                    b"<!doctype html><meta charset=utf-8><title>Vigil</title><pre id=o></pre><script>"
                    b"new EventSource('/events').onmessage=e=>{o.textContent+=JSON.parse(e.data).text+'\\n'}</script>")
                return self._send(200, body, "text/html; charset=utf-8")
            if u.path == "/run.jsonl":
                with log.cond:
                    body = "".join(json.dumps(e) + "\n" for e in log.events).encode()
                return self._send(200, body, "application/x-ndjson")
            if u.path == "/events":
                return self._sse()
            if u.path == "/tts":
                q = parse_qs(u.query)
                vox = _optional("voxtral") if os.environ.get("MISTRAL_API_KEY") else None
                try:
                    audio = vox.synthesize(q.get("text", [""])[0][:500], q.get("character", ["scout"])[0])
                    return self._send(200, audio, "audio/mpeg")
                except Exception:
                    return self._send(503, b'{"error":"tts unavailable"}')
            self._send(404, b'{"error":"not found"}')

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            i = 0
            try:
                while True:
                    with log.cond:
                        if i >= len(log.events):
                            log.cond.wait(15)
                        new = log.events[i:]
                    i += len(new)
                    chunk = "".join(f"data: {json.dumps(e)}\n\n" for e in new) or ": keepalive\n\n"
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()
            except (ConnectionError, OSError):
                pass  # page closed

        def do_POST(self):
            if urlsplit(self.path).path != "/approve":
                return self._send(404, b'{"error":"not found"}')
            try:
                n = int(self.headers.get("Content-Length") or 0)
                d = json.loads(self.rfile.read(min(n, 10_000)) or b"{}")
                aid, dec = str(d["approval_id"]), d["decision"]
            except Exception:
                return self._send(400, b'{"error":"body must be {approval_id, decision}"}')
            if dec not in ("allow", "deny"):
                return self._send(400, b'{"error":"decision must be allow or deny"}')
            if not gate.answer(aid, dec):
                return self._send(404, b'{"error":"unknown approval_id"}')
            self._send(200, b'{"ok": true}')

    return H


def _warm_ollama():
    try:
        import urllib.request
        base = os.environ["VIGIL_BASE_URL"].rstrip("/")
        body = json.dumps({"model": os.environ["VIGIL_MODEL"], "max_tokens": 1,
                           "messages": [{"role": "user", "content": "ok"}]}).encode()
        urllib.request.urlopen(urllib.request.Request(f"{base}/chat/completions", data=body,
                               headers={"Content-Type": "application/json"}), timeout=120).read()
    except Exception:
        pass  # warm-up is best effort


def make_scout(app: Path):
    """Ministral Scout = harness/vigil.py's explainer, pointed at local Ollama unless VIGIL_BASE_URL/VIGIL_MODEL say otherwise."""
    import vigil  # harness/ is on sys.path via tools
    os.environ.setdefault("VIGIL_BASE_URL", "http://localhost:11434/v1")
    os.environ.setdefault("VIGIL_MODEL", "vigil")
    threading.Thread(target=_warm_ollama, daemon=True).start()  # load the 3B while the scan runs (cold start ~30 s)

    def scout(f: dict) -> dict:
        text = (app / f["file"]).read_text(encoding="utf-8")  # stays local: Ollama on this machine
        return vigil.ask_model({**f, "ask": f.get("ask") or f.get("title", "")}, vigil.excerpt(text, int(f.get("line") or 1)))
    return scout


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="vigil-engine")
    ap.add_argument("app_path")
    ap.add_argument("--target", default=os.environ.get("VIGIL_TARGET_URL", "http://localhost:3001"))
    ap.add_argument("--mode", choices=["offline", "mistral"], default="offline")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-narrate", action="store_true")
    a = ap.parse_args(argv)
    app = Path(a.app_path).resolve()
    if not app.is_dir():
        print(f"not a directory: {app}", file=sys.stderr)
        return 2

    narr = None
    if not a.no_narrate:
        n = _optional("narrator")
        narr = getattr(n, "narrate", None)
    scout = None
    if not a.no_narrate:  # --no-narrate turns off all Ministral calls
        scout = make_scout(app)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log = EventLog(HERE / "runs" / f"{stamp}.jsonl", narrate=narr, scout=scout)

    gate = Gate(log.emit)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(log, gate))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Open http://127.0.0.1:{a.port}/", flush=True)
    time.sleep(0.5)  # give the page a moment to connect; events replay anyway
    verdict = run(app, a.target, a.mode, log, gate)
    print(f"VERDICT {verdict}  (log: {log.path})  Ctrl-C to stop serving.", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
