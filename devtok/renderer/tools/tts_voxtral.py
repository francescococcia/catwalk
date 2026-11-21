"""Mistral Voxtral TTS for DevTok reels (stdlib only; client copied from engine/voxtral.py).

Env: MISTRAL_API_KEY (required), DEVTOK_VOXTRAL_VOICE (default voice_1788 "David", the detective voice),
     DEVTOK_VOXTRAL_MODEL (default voxtral-mini-tts-3-0).
"""
import base64
import json
import os
import subprocess
import tempfile
import urllib.request

SR = 24000  # same as Kokoro's output: 24 kHz mono 16-bit PCM wav


def synthesize(text):
    key = os.environ.get("MISTRAL_API_KEY")
    if not key:
        raise RuntimeError("MISTRAL_API_KEY is not set: Voxtral TTS is unavailable")
    body = {
        "model": os.environ.get("DEVTOK_VOXTRAL_MODEL", "voxtral-mini-tts-3-0"),
        "input": f"[emotion=confident]{text}",
        "voice_id": os.environ.get("DEVTOK_VOXTRAL_VOICE", "voice_1788"),
        "response_format": "mp3",
    }
    req = urllib.request.Request("https://api.mistral.ai/v1/audio/speech", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return base64.b64decode(json.loads(r.read())["audio_data"])


def run(jobs):
    for j in jobs:
        mp3 = synthesize(j["text"])
        fd, tmp = tempfile.mkstemp(suffix=".mp3")
        with os.fdopen(fd, "wb") as f:
            f.write(mp3)
        try:
            # trim leading silence, then a 0.35 s beat for the hook card (as the Kokoro path does)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp, "-af",
                            "silenceremove=start_periods=1:start_threshold=-50dB,adelay=350:all=1",
                            "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", j["out"]], check=True)
        finally:
            os.remove(tmp)
        dur = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                       j["out"]]).decode().strip()
        print(f"{os.path.basename(os.path.dirname(j['out']))}: {float(dur):.1f}s (voxtral)", flush=True)
