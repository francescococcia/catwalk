"""Tiny stdlib Mistral client: JSON-mode chat with retries, validation hook and full debug logging.

The API key is read from vibedidactics/.env (VOXTRAL_API_KEY) or the environment; it is never logged.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # vibedidactics/
API = "https://api.mistral.ai/v1/chat/completions"
MODELS = {
    "large": os.environ.get("DEVTOK_MODEL_LARGE", "mistral-large-4"),  # Le Chonk: system map, storyboard, approval summary
    "medium": os.environ.get("DEVTOK_MODEL_MEDIUM", "mistral-medium-latest"),
    "small": os.environ.get("DEVTOK_MODEL_SMALL", "mistral-small-latest"),
}


def _key():
    for name in ("MISTRAL_API_KEY", "VOXTRAL_API_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith(("VOXTRAL_API_KEY=", "MISTRAL_API_KEY=")):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("No Mistral key: set MISTRAL_API_KEY or VOXTRAL_API_KEY in vibedidactics/.env")


def _text(content):
    """Mistral reasoning models return a list of parts (thinking + text); keep only the text."""
    if isinstance(content, str):
        return content
    out = []
    for part in content or []:
        if isinstance(part, dict) and part.get("type") == "text":
            out.append(part.get("text", ""))
    return "".join(out)


def _parse_json(s):
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", s, re.S)
        if m:
            return json.loads(m.group(0))
        raise


class LLM:
    def __init__(self, debug_dir: Path):
        self.debug_dir = Path(debug_dir)
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        self.key = _key()
        self.calls = []

    def chat_json(self, name, system, user, tier="medium", validate=None, max_tokens=6000, temperature=0.3, soft=True):
        """Returns parsed JSON. `validate(obj)` may raise ValueError -> one repair retry with the error."""
        model = MODELS[tier]
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        last_err, last_obj = None, None
        for attempt in range(3):
            t0 = time.time()
            raw = self._post(model, messages, max_tokens, temperature)
            dt = time.time() - t0
            txt = _text(raw["choices"][0]["message"].get("content"))
            usage = raw.get("usage", {})
            log = self.debug_dir / f"{name}.attempt{attempt}.txt"
            log.write_text(f"MODEL: {model}  ({dt:.1f}s)  usage={json.dumps(usage)}\n\n=== SYSTEM ===\n{system}\n\n=== USER ===\n{user}\n\n=== RESPONSE ===\n{txt}\n")
            self.calls.append({"name": name, "model": model, "seconds": round(dt, 1), "usage": usage, "attempt": attempt})
            if not txt.strip():  # reasoning models can spend the whole budget thinking: retry with more room, never echo an empty assistant turn (API 400)
                max_tokens = min(max_tokens * 2, 32000)
                last_err = ValueError("empty response")
                continue
            try:
                obj = _parse_json(txt)
                last_obj = obj
                if validate:
                    validate(obj)
                (self.debug_dir / f"{name}.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False))
                return obj
            except (ValueError, KeyError, TypeError) as e:
                last_err = e
                messages = messages[:2] + [
                    {"role": "assistant", "content": txt[:12000]},
                    {"role": "user", "content": f"Your JSON was invalid: {e}. Return the full corrected JSON only."},
                ]
        if soft and last_obj is not None and not isinstance(last_err, (KeyError, TypeError)):
            (self.debug_dir / f"{name}.json").write_text(json.dumps(last_obj, indent=2, ensure_ascii=False))
            self.calls.append({"name": name, "warning": f"accepted after failed validation: {last_err}"})
            return last_obj
        raise RuntimeError(f"{name}: invalid JSON after retries: {last_err}")

    def _post(self, model, messages, max_tokens, temperature):
        body = json.dumps({
            "model": model, "messages": messages, "temperature": temperature,
            "max_tokens": max_tokens, "response_format": {"type": "json_object"},
        }).encode()
        for attempt in range(5):
            req = urllib.request.Request(API, data=body, headers={
                "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
            try:
                return json.load(urllib.request.urlopen(req, timeout=240))
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                    time.sleep(2 + attempt * 4)
                    continue
                raise RuntimeError(f"Mistral HTTP {e.code}: {e.read()[:300]!r}")
            except (urllib.error.URLError, TimeoutError):
                if attempt < 4:
                    time.sleep(3)
                    continue
                raise
