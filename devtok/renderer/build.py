"""Render every reel of a pipeline run into a narrated 9:16 mp4 and point the manifests at them.

    python3 build.py --out ../out/pydantic-ai-3942 --media ../media --prefix pyd3942 [--roles a,b] [--only r01] [--workers 3]

Per reel: clean narration -> Kokoro TTS (vo.wav) -> Parakeet word timings -> shots retimed to the real audio
-> spec.json -> three.js frames (render.mjs) -> mux with voice -> <media>/<prefix>_<role>_<reel>.mp4.
manifest_<role>.json in --out is updated in place (video, video_is_mock=false, duration_s, retimed shots).
"""
import argparse
import os
import hashlib
import json
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = Path(os.environ.get("DEVTOK_KIT", HERE.parent / "kit"))  # claude-animation-skills/kit (voice models, node_modules)
PY = KIT / ".venv" / "bin" / "python"
ROLES = ["technical_engineer", "team_lead", "paying_manager"]
SKILLS = KIT.parent / "skills"


def speakable(s):
    """Narration as it should be spoken (and subtitled): no backticks, snake_case and file names read out."""
    s = s.replace("`", "")
    s = re.sub(r"\b([\w/]+)\.py\b", lambda m: m.group(1).split("/")[-1] + " dot py", s)
    s = re.sub(r"(?<=\w)_(?=\w)", " ", s)
    s = re.sub(r"\bL(\d+)", r"line \1", s)
    return re.sub(r"\s+", " ", s).strip()


def wc(s):
    return len(re.findall(r"[\w$%]+", s or ""))


def retime(shots, words, duration):
    total = sum(max(1, wc(speakable(s.get("narration", "")))) for s in shots) or 1
    n = len(words)
    out, acc = [], 0
    for i, s in enumerate(shots):
        idx = min(n - 1, round(acc / total * n)) if n else 0
        start = 0.0 if i == 0 or not n else words[idx]["s"] - 0.1
        out.append(dict(s, t_start=round(max(0.0, start), 2)))
        acc += max(1, wc(speakable(s.get("narration", ""))))
    for i, s in enumerate(out):
        s["t_end"] = out[i + 1]["t_start"] if i + 1 < len(out) else round(duration, 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--media", default=str(HERE.parent / "media"))
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--roles", default=",".join(ROLES))
    ap.add_argument("--only", default="")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--fps", type=int, default=30)
    a = ap.parse_args()
    out, media = Path(a.out), Path(a.media)
    media.mkdir(parents=True, exist_ok=True)
    work = HERE / "work" / a.prefix
    T0 = time.time()
    todo = []
    manifests = {}
    for role in a.roles.split(","):
        mp = out / f"manifest_{role}.json"
        if not mp.exists():
            continue
        m = json.loads(mp.read_text())
        manifests[role] = m
        vids = [i for i in m["items"] if i["type"] == "video"]
        for v in vids:
            if a.only and v["id"] not in a.only.split(","):
                continue
            d = work / role / v["id"]
            d.mkdir(parents=True, exist_ok=True)
            text = speakable(v["narration"])
            (d / "narration.txt").write_text(text)
            todo.append((role, v, d, text, len(vids)))
    # 1) voice for everything in one Kokoro process
    tts_jobs = [{"text": t, "out": str(d / "vo.wav")} for _, _, d, t, _ in todo if not (d / "vo.wav").exists()]
    if tts_jobs:
        (work / "tts_jobs.json").write_text(json.dumps(tts_jobs))
        subprocess.run([str(PY), str(HERE / "tools" / "tts.py"), str(work / "tts_jobs.json")], check=True)
    # 2) word timings
    for _, _, d, _, _ in todo:
        if not (d / "vo.words.json").exists():
            subprocess.run([str(PY), str(KIT / "words.py"), str(d / "vo.wav"), str(d / "narration.txt")], check=True,
                           stdout=subprocess.DEVNULL)
    print(f"voice + timings ready for {len(todo)} reels ({time.time() - T0:.0f}s)", flush=True)

    # 3) render + mux in parallel Chrome workers
    def render(job):
        role, v, d, text, count = job
        words = json.loads((d / "vo.words.json").read_text())
        dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(d / "vo.wav")]).decode().strip())
        duration = round(dur + 0.7, 2)
        shots = retime(v["shots"], words, duration)
        spec = {"role": role, "reel": dict(v, shots=shots), "graph": manifests[role]["graph"], "words": words,
                "duration": duration, "reel_count": count}
        ins = v.get("insert")
        if ins:  # render the skill clip, then convert to VP9 (Playwright's Chromium has no H.264)
            sh = shots[min(ins["shot_index"], len(shots) - 1)]
            t0i, t1i = sh["t_start"] + 0.25, max(sh["t_start"] + 3.0, sh["t_end"] - 0.1)
            sp = dict(ins["spec"], hold=round(max(0.0, (t1i - t0i) - 4.0), 2), out=str(d / "insert.mp4"))
            (d / f"insert.{ins['style']}.json").write_text(json.dumps(sp))
            subprocess.run(["python3", str(SKILLS / ins["style"] / "build.py"), str(d / f"insert.{ins['style']}.json")], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(d / "insert.mp4"), "-vf", "scale=720:1280", "-an", "-c:v", "libvpx-vp9",
                            "-b:v", "0", "-crf", "34", "-deadline", "realtime", "-cpu-used", "8", str(d / "insert.webm")], check=True)
            spec["insert"] = {"file": str(d / "insert.webm"), "t0": round(t0i, 2), "t1": round(t1i, 2), "style": ins["style"]}
        sty = (v.get("style") or {})
        if sty.get("spec"):  # whole reel in a skill style: render the clip, convert to VP9, play it full screen
            sp = dict(sty["spec"], hold=0.3, out=str(d / "style.mp4"))
            (d / f"style.{sty['name']}.json").write_text(json.dumps(sp))
            if not (d / "style.webm").exists() or json.loads((d / "style.spec.json").read_text() if (d / "style.spec.json").exists() else "null") != sp:
                subprocess.run(["python3", str(SKILLS / sty["name"] / "build.py"), str(d / f"style.{sty['name']}.json")], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(d / "style.mp4"), "-vf", "scale=720:1280", "-an", "-c:v", "libvpx-vp9",
                                "-b:v", "0", "-crf", "32", "-deadline", "realtime", "-cpu-used", "8", str(d / "style.webm")], check=True)
                (d / "style.spec.json").write_text(json.dumps(sp))
            spec["style_clip"] = {"file": str(d / "style.webm"), "t0": 0.35, "t1": round(duration - 1.0, 2), "style": sty["name"]}
        name = f"{a.prefix}_{role}_{v['id']}.mp4"
        key = hashlib.sha1((json.dumps(spec, sort_keys=True) + (HERE / "src" / "main.js").read_text() + (HERE / "index.html").read_text()).encode()).hexdigest()
        if (media / name).exists() and (d / "spec.sha").exists() and (d / "spec.sha").read_text() == key:
            print(f"  {name}: cached", flush=True)
            return role, v["id"], name, duration, shots
        (d / "spec.json").write_text(json.dumps(spec))
        t0 = time.time()
        subprocess.run(["node", str(HERE / "render.mjs"), str(d / "spec.json"), "video", str(d / "silent.mp4"), str(a.fps)],
                       check=True, cwd=HERE, stdout=subprocess.DEVNULL)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(d / "silent.mp4"), "-i", str(d / "vo.wav"), "-map", "0:v", "-map", "1:a",
                        "-c:v", "copy", "-af", "apad,loudnorm=I=-14:TP=-1.5", "-c:a", "aac", "-b:a", "160k", "-shortest",
                        "-movflags", "+faststart", str(media / name)], check=True)
        (d / "spec.sha").write_text(key)
        print(f"  {name}: {duration:.1f}s video in {time.time() - t0:.0f}s" + (f" + {ins['style']} insert" if ins else "") + (f" [{sty['name']} style]" if sty.get("spec") else ""), flush=True)
        return role, v["id"], name, duration, shots

    with ThreadPoolExecutor(a.workers) as ex:
        results = list(ex.map(render, todo))
    # 4) point manifests at the rendered videos
    for role, rid, name, duration, shots in results:
        for it in manifests[role]["items"]:
            if it["type"] == "video" and it["id"] == rid:
                it.update(video=name, video_is_mock=False, duration_s=duration, shots=shots)
    for role, m in manifests.items():
        (out / f"manifest_{role}.json").write_text(json.dumps(m, indent=2, ensure_ascii=False))
    print(f"done: {len(results)} reels in {time.time() - T0:.0f}s -> {media}")


if __name__ == "__main__":
    main()
