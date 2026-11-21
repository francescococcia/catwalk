"""Mistral layer tests. Offline-safe; the live narrator test runs only when Ollama answers.

uv run --project engine python engine/test_mistral_layer.py      (or: pytest engine/test_mistral_layer.py)
"""
import base64
import json
import os
import sys
import types
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mistral_agent  # noqa: E402
import narrator  # noqa: E402
import voxtral  # noqa: E402

PROOF_EVENT = {"type": "proof", "character": "detective", "status": "PROVEN", "text": "PROVEN: alice read ord_b1.",
               "evidence_local": {"body": "door code 4471"}, "evidence": {"body_redacted": "door code ***"},
               "params": {"attacker": "alice", "victim_order": "ord_b1", "secret_note": "4471"}}


def _stub_post(reply, sent=None):
    def post(body):
        if sent is not None:
            sent.append(json.dumps(body))
        if isinstance(reply, Exception):
            raise reply
        return {"choices": [{"message": {"content": reply}}]}
    return post


# ---------------------------------------------------------------- narrator
def test_narrator_validates_and_strips_secrets():
    sent, orig = [], narrator._post
    try:
        narrator._post = _stub_post('{"character": "detective", "line": "Alice read Bob\'s order."}', sent)
        assert narrator.narrate(PROOF_EVENT) == {"character": "detective", "line": "Alice read Bob's order."}
        assert "4471" not in sent[0] and "evidence" not in sent[0]
        narrator._post = _stub_post(json.dumps({"character": "villain", "line": " ".join(["word"] * 40)}))
        out = narrator.narrate(PROOF_EVENT)
        assert out["character"] == "detective" and len(out["line"].split()) == 20
        for bad in ("not json", '{"character": "scout"}', '{"line": ""}', OSError("down")):
            narrator._post = _stub_post(bad)
            assert narrator.narrate(PROOF_EVENT) is None
    finally:
        narrator._post = orig


def test_narrator_live_when_ollama_answers():
    base = os.environ.get("VIGIL_NARRATOR_BASE_URL", "http://localhost:11434/v1")
    try:
        urllib.request.urlopen(base.rstrip("/") + "/models", timeout=2).read()
    except Exception:
        print("  (skipped: no narrator server)")
        return
    out = narrator.narrate(PROOF_EVENT)
    assert out and out["character"] in narrator.CHARACTERS and len(out["line"].split()) <= 20, out
    assert "4471" not in out["line"]
    print("  live:", out)


# ---------------------------------------------------------------- voxtral
def test_voxtral_needs_key_and_decodes():
    key = os.environ.pop("MISTRAL_API_KEY", None)
    orig = urllib.request.urlopen
    try:
        try:
            voxtral.synthesize("hi", "scout")
            raise AssertionError("expected RuntimeError without a key")
        except RuntimeError as e:
            assert "MISTRAL_API_KEY" in str(e)
        os.environ["MISTRAL_API_KEY"] = "test"
        seen = {}

        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps({"audio_data": base64.b64encode(b"ID3fake").decode()}).encode()

        def fake(req, timeout=None):
            seen.update(url=req.full_url, body=json.loads(req.data))
            return R()
        urllib.request.urlopen = fake
        assert voxtral.synthesize("Scan done.", "detective") == b"ID3fake"
        assert seen["url"].endswith("/v1/audio/speech") and seen["body"]["voice_id"] == voxtral.VOICES["detective"][0]
        assert seen["body"]["model"] == "voxtral-mini-tts-3-0" and seen["body"]["response_format"] == "mp3"
    finally:
        urllib.request.urlopen = orig
        os.environ.pop("MISTRAL_API_KEY", None)
        if key:
            os.environ["MISTRAL_API_KEY"] = key


# ---------------------------------------------------------------- mistral_agent
class FakeTools:
    def __init__(self, gate, fix_holds=True):
        self.gate, self.fixed, self.calls, self.fix_holds = gate, False, [], fix_holds

    def vigil_scan(self, path="."):
        self.calls.append("vigil_scan")
        return {"result": "SUSPECT", "tree": ["route.ts"],
                "findings": [{"title": "IDOR", "file": "route.ts", "line": 7, "attack": "idor_read"}]}

    def read_file(self, path):
        self.calls.append("read_file")
        return {"path": path, "content": "old\n"}

    def run_proof(self, attack, params, retry=False):
        self.calls.append("run_proof")
        st = "BLOCKED" if self.fixed and self.fix_holds else "PROVEN"
        return {"status": st, "attack": attack, "params": params, "control": {"ok": True},
                "evidence": {}, "evidence_local": {"body": "door code 4471"}}

    def apply_fix(self, file, new_content):
        self.calls.append("apply_fix")
        if not self.gate.approved(file, new_content):
            return {"error": "not approved"}
        self.fixed = True
        return {"applied": True, "file": file, "backup_id": "b1"}

    def rollback(self, backup_id, reason=""):
        self.calls.append("rollback")
        self.fixed = False
        return {"rolled_back": True}


class FakeGate:
    def __init__(self, allow):
        self.allow, self.ok, self.requests = allow, set(), []

    def request(self, kind="apply_fix", file="", new_content="", diff="", reason=""):
        self.requests.append((file, diff))
        if self.allow:
            self.ok.add((file, new_content))
        return self.allow

    def approved(self, file, new_content):
        return (file, new_content) in self.ok


def _scripted_run(allow, fix_holds=True):
    from mistralai import agents
    t = agents.testing
    model = t.ScriptedModel([
        t.call("vigil_scan", path="."),
        t.call("read_app_file", path="route.ts"),
        t.call("run_proof", attack="idor_read", attacker="alice", victim_order="ord_b1"),
        t.call("apply_fix", file="route.ts", new_content="new\n"),
        t.reply("Done."),
    ])
    gate, events = FakeGate(allow), []
    tools = FakeTools(gate, fix_holds)
    mistral_agent._TEST_MODEL = model
    try:
        verdict = mistral_agent.plan("demo-app", tools, gate, lambda *a, **k: events.append((a, k)))
    finally:
        mistral_agent._TEST_MODEL = None
    return verdict, tools, gate, events


def test_agent_loop_routes_apply_fix_through_gate():
    verdict, tools, gate, events = _scripted_run(allow=True)
    assert verdict == "FIXED", (verdict, tools.calls, events)
    assert len(gate.requests) == 1 and "+new" in gate.requests[0][1]
    assert "apply_fix" in tools.calls and tools.calls[-1] == "run_proof"  # code re-proves after the fix
    assert any(a[0] == "scan_done" for a, _ in events)
    assert any(a[0] == "thinking" and "Done." in a[2] for a, _ in events), events  # TextDelta -> thinking


def test_agent_fix_that_does_not_hold_is_rolled_back():
    verdict, tools, gate, events = _scripted_run(allow=True, fix_holds=False)
    assert verdict == "PROVEN" and tools.calls[-1] == "rollback", (verdict, tools.calls)


def test_agent_denied_fix_is_not_applied():
    verdict, tools, gate, events = _scripted_run(allow=False)
    assert verdict == "PROVEN", (verdict, tools.calls)
    assert "apply_fix" not in tools.calls and not tools.fixed


def test_agent_falls_back_without_key():
    key = os.environ.pop("MISTRAL_API_KEY", None)
    stub = types.ModuleType("planner")
    stub.plan = lambda app_path, tools, gate, emit: "PASS"
    real = sys.modules.get("planner")
    sys.modules["planner"] = stub
    events = []
    try:
        assert mistral_agent.plan("demo-app", None, None, lambda *a, **k: events.append(a)) == "PASS"
        assert events[0][0] == "error"
    finally:
        if real is not None:
            sys.modules["planner"] = real
        else:
            sys.modules.pop("planner", None)
        if key:
            os.environ["MISTRAL_API_KEY"] = key


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
