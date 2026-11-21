"""Voxtral TTS: synthesize(text, character) -> mp3 bytes. UNTESTED (no MISTRAL_API_KEY on the build machine).

API (docs read 2026-11-21):
  https://docs.mistral.ai/api/endpoint/audio/speech            POST /v1/audio/speech, body {model, input, voice_id, response_format}
  https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech   non-streaming reply is JSON {"audio_data": "<base64>"}
  https://docs.mistral.ai/studio/audio/text-to-speech/voices   preset voice ids (Voxtral 3)
  https://docs.mistral.ai/studio/audio/text-to-speech/emotion-tags   inline tags like "[emotion=calm]" in `input`

Env: MISTRAL_API_KEY (required), VIGIL_TTS_MODEL (default voxtral-mini-tts-3-0),
     VIGIL_VOICE_<CHARACTER> to override a voice id, e.g. VIGIL_VOICE_SCOUT=voice_478.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.request

# One preset per character (Voxtral 3 English voices from the voices page) plus an emotion tag.
VOICES = {
    "scout": ("voice_485", "curious"),       # Rob, en-US
    "detective": ("voice_1788", "confident"),  # David, en-UK
    "mechanic": ("voice_478", "determined"),  # Sheila, en-US
    "gatekeeper": ("voice_590", "calm"),      # Harriet, en-UK
}


def synthesize(text: str, character: str) -> bytes:
    key = os.environ.get("MISTRAL_API_KEY")
    if not key:
        raise RuntimeError("MISTRAL_API_KEY is not set: Voxtral TTS is unavailable (the page falls back to browser speech)")
    voice, emotion = VOICES.get(character, VOICES["gatekeeper"])
    voice = os.environ.get(f"VIGIL_VOICE_{character.upper()}", voice)
    body = {
        "model": os.environ.get("VIGIL_TTS_MODEL", "voxtral-mini-tts-3-0"),
        "input": f"[emotion={emotion}]{text[:500]}",
        "voice_id": voice,
        "response_format": "mp3",
    }
    req = urllib.request.Request("https://api.mistral.ai/v1/audio/speech", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return base64.b64decode(json.loads(r.read())["audio_data"])
