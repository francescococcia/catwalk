"""Narrator TTS for a batch of reels: Mistral Voxtral or Kokoro (one model load for all).

    tts.py <jobs.json> [voice] [speed]
jobs.json: [{"text": "...", "out": "/abs/path/vo.wav"}, ...]

DEVTOK_TTS=voxtral|kokoro picks the engine. Unset: voxtral when MISTRAL_API_KEY is set and kokoro_onnx
is not installed, else kokoro. [voice] [speed] apply to Kokoro; Voxtral uses DEVTOK_VOXTRAL_VOICE.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile


def engine():
    e = os.environ.get("DEVTOK_TTS", "").lower()
    if e:
        return e
    if os.environ.get("MISTRAL_API_KEY") and importlib.util.find_spec("kokoro_onnx") is None:
        return "voxtral"
    return "kokoro"


def kokoro(jobs):
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import EspeakConfig, Kokoro
    import espeakng_loader

    KIT = os.environ.get("DEVTOK_KIT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "kit"))
    data = espeakng_loader.get_data_path()
    if len(data) > 100:  # espeak-ng fails on long data paths
        short = os.path.join(tempfile.gettempdir(), "kokoro-espeak-ng-data")
        if not os.path.exists(os.path.join(short, "phontab")):
            shutil.rmtree(short, ignore_errors=True)
            shutil.copytree(data, short)
        data = short
    k = Kokoro(os.path.join(KIT, "models/kokoro-v1.0.onnx"), os.path.join(KIT, "models/voices-v1.0.bin"),
               espeak_config=EspeakConfig(lib_path=espeakng_loader.get_library_path(), data_path=data))
    voice = sys.argv[2] if len(sys.argv) > 2 else "am_michael"
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.08
    for j in jobs:
        samples, sr = k.create(j["text"], voice=voice, speed=speed, lang="en-us")
        a = np.abs(samples)
        idx = np.where(a > 0.01)[0]
        samples = samples[max(0, idx[0] - int(0.02 * sr)): idx[-1] + int(0.08 * sr)]
        lead = np.zeros(int(0.35 * sr), dtype=samples.dtype)  # a beat for the hook card
        sf.write(j["out"], np.concatenate([lead, samples]), sr)
        print(f"{os.path.basename(os.path.dirname(j['out']))}: {len(samples) / sr + 0.35:.1f}s", flush=True)


if __name__ == "__main__":
    jobs = json.load(open(sys.argv[1]))
    if engine() == "voxtral":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import tts_voxtral
        tts_voxtral.run(jobs)
    else:
        kokoro(jobs)
