"""DevTok job server (stdlib): the phone sends a PR link (+ its GitHub token), we fetch the PR, run the pipeline,
and serve progress + role manifests.

    python3 server.py                 # http://127.0.0.1:8765  (iOS Simulator reaches it as localhost)
    python3 server.py --host 0.0.0.0  # a real phone on the same Wi-Fi: set the Mac's IP in the app settings

API
  GET  /api/health
  POST /api/jobs                 {"pr_url": "...", "roles": [...]?}   header X-GitHub-Token: <token> (optional)
  GET  /api/jobs/<id>            status + per-stage progress + PR summary
  GET  /api/jobs/<id>/manifest/<role>
  GET  /api/jobs/<id>/explain/<role>
  GET  /media/<file>             mp4 with HTTP Range (AVPlayer needs it)
"""
import argparse
import subprocess
import json
import mimetypes
import re
import shutil
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import github
import inserts
import run as pipeline

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JOBS = ROOT / "storage" / "jobs"
MEDIA = ROOT / "media"
DEMO = {"url_key": "pydantic/pydantic-ai/pull/3942", "out": ROOT / "out" / "pydantic-ai-3942", "pr": ROOT / "mock" / "pr"}
STAGES = ["fetch", "ingest", "graph", *pipeline.ROLES, "render"]
RENDER = ROOT / "renderer" / "build.py"
LOCK = threading.Lock()
RUNNING = {}


def job_id_for(owner, repo, num):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", f"{owner}__{repo}__{num}")


def load_status(jid):
    p = JOBS / jid / "status.json"
    return json.loads(p.read_text()) if p.exists() else None


def save_status(st):
    d = JOBS / st["job_id"]
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "status.json.tmp"
    tmp.write_text(json.dumps(st, indent=2, ensure_ascii=False))
    tmp.replace(d / "status.json")


def new_status(jid, url, roles):
    return {"job_id": jid, "pr_url": url, "status": "queued", "created": time.time(), "error": None, "roles": roles,
            "roles_ready": [], "pr": None, "stats": None,
            "stages": [{"id": s, "label": {"fetch": "Fetch PR from GitHub", "ingest": "Parse the diff", "graph": "Build the system map"}
                        .get(s, "Render the videos" if s == "render" else pipeline.ROLES.get(s, {}).get("label", s) + " reels"), "status": "pending", "detail": "", "t": None}
                       for s in STAGES if s in ("fetch", "ingest", "graph", "render") or s in roles], "videos": "pending"}


def pr_summary(pr, diff_stats=None):
    return {"title": pr.get("title"), "repo": pr.get("repo"), "number": pr.get("number"), "url": pr.get("url"),
            "author": pr.get("author"), "state": pr.get("state"), "merged_at": pr.get("merged_at"),
            "files": pr.get("changed_files"), "additions": pr.get("additions"), "deletions": pr.get("deletions"),
            "commits": len(pr.get("commits", []))}


def render_videos(jid, out, roles, stage, st):
    manifests = [json.loads((out / f"manifest_{r}.json").read_text()) for r in roles if (out / f"manifest_{r}.json").exists()]
    vids = [i for m in manifests for i in m["items"] if i["type"] == "video"]
    if vids and all(not v.get("video_is_mock", True) and (MEDIA / v["video"]).exists() for v in vids):
        stage("render", "done", f"{len(vids)} videos (cached)")
        st["videos"] = "ready"; save_status(st)
        return
    st["videos"] = "rendering"
    stage("render", "running", f"0/{len(vids)} videos: voice + word timings")
    proc = subprocess.Popen(["python3", str(RENDER), "--out", str(out), "--media", str(MEDIA), "--prefix", jid, "--roles", ",".join(roles)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=RENDER.parent)
    done = 0
    for line in proc.stdout:
        if line.startswith("  ") and ".mp4" in line:
            done += 1
            stage("render", "running", f"{done}/{len(vids)} videos · last: {line.strip()}")
    ok = proc.wait() == 0
    st["videos"] = "ready" if ok else "failed"
    stage("render", "done" if ok else "error", f"{done} videos rendered" if ok else "renderer failed (reels keep the mock video)")


def worker(jid, url, token, roles):
    st = load_status(jid)
    t0 = time.time()

    def stage(sid, status, detail=""):
        with LOCK:
            for s in st["stages"]:
                if s["id"] == sid:
                    s["status"], s["detail"], s["t"] = status, detail, round(time.time() - t0, 1)
            if sid in pipeline.ROLES and status == "done":
                st["roles_ready"].append(sid)
            if st["status"] != "done":
                st["status"] = "running"
            save_status(st)

    try:
        d = JOBS / jid
        stage("fetch", "running", "Asking GitHub for the PR, commits and diff")
        if DEMO["url_key"] in url and (DEMO["out"] / "graph.json").exists():
            pr = json.loads((DEMO["pr"] / "pr.json").read_text())
            diff = (DEMO["pr"] / "pr.diff").read_text()
            org = (DEMO["pr"] / "org_context.md").read_text()
            shutil.copytree(DEMO["out"], d / "out", dirs_exist_ok=True)  # cached demo run (+ mock org context)
            stage("fetch", "done", "Demo PR (cached copy + mock org context)")
        else:
            pr, diff, remaining = github.fetch_pr(url, token)
            org = None
            stage("fetch", "done", f"{pr['changed_files']} files, {len(pr['commits'])} commits, {len(diff) // 1024} KB diff"
                                   + (f"; GitHub calls left this hour: {remaining}" if remaining else ""))
        (d / "pr.json").write_text(json.dumps(pr, indent=2, ensure_ascii=False))
        (d / "pr.diff").write_text(diff)
        with LOCK:
            st["pr"] = pr_summary(pr)
            save_status(st)
        if DEMO["url_key"] in url and all((d / "out" / f"manifest_{r}.json").exists() for r in roles):
            for sid in ["ingest", "graph", *roles]:
                stage(sid, "done", "cached")
            calls = json.loads((d / "out" / "debug" / "calls.json").read_text())
            stats = {"total_seconds": calls.get("total_seconds"), "llm_calls": len([c for c in calls["calls"] if "usage" in c]),
                     "tokens": sum(c["usage"].get("total_tokens", 0) for c in calls["calls"] if "usage" in c)}
        else:
            stats = pipeline.run_all(pr, diff, org, d / "out", roles, progress=stage)
        with LOCK:
            st["status"] = "done"  # reels are watchable now (mock video) while the real ones render
            st["stats"] = {k: stats[k] for k in ("total_seconds", "llm_calls", "tokens")}
            save_status(st)
        try:  # styled skill inserts (graph / dan-koe / steps): optional, never blocks the reels
            if not any("insert" in i for r in roles if (d / "out" / f"manifest_{r}.json").exists()
                       for i in json.loads((d / "out" / f"manifest_{r}.json").read_text())["items"]):
                stage("render", "running", "Choosing styled inserts")
                picked = inserts.run(d / "out", org, roles)
                stage("render", "running", "Inserts: " + "; ".join(f"{r}: {len(v)}" for r, v in picked.items()))
        except Exception as e:
            print("inserts failed:", e)
        render_videos(jid, d / "out", roles, stage, st)
    except Exception as e:  # report to the phone, keep the trace on the server
        traceback.print_exc()
        with LOCK:
            st["status"], st["error"] = "error", str(e)
            for s in st["stages"]:
                if s["status"] == "running":
                    s["status"] = "error"
            save_status(st)
    finally:
        RUNNING.pop(jid, None)


class H(BaseHTTPRequestHandler):
    server_version = "devtok/0.1"

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if parts == ["api", "health"]:
            return self._json({"ok": True, "roles": list(pipeline.ROLES)})
        if parts == ["api", "jobs"]:
            jobs = sorted((load_status(p.name) for p in JOBS.glob("*") if (p / "status.json").exists()), key=lambda s: -s["created"])
            return self._json([{k: j[k] for k in ("job_id", "pr_url", "status", "pr")} for j in jobs[:20]])
        if len(parts) >= 3 and parts[:2] == ["api", "jobs"]:
            jid = parts[2]
            st = load_status(jid)
            if not st:
                return self._json({"error": "unknown job"}, 404)
            if len(parts) == 3:
                return self._json(st)
            if len(parts) == 5 and parts[3] in ("manifest", "explain") and parts[4] in pipeline.ROLES:
                f = JOBS / jid / "out" / (f"manifest_{parts[4]}.json" if parts[3] == "manifest" else f"explain_{parts[4]}.md")
                if not f.exists():
                    return self._json({"error": "not ready"}, 409)
                body = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json" if parts[3] == "manifest" else "text/markdown; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
        if len(parts) == 2 and parts[0] == "media":
            return self._media(parts[1])
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/jobs":
            return self._json({"error": "not found"}, 404)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            owner, repo, num = github.parse_pr_url(req.get("pr_url", ""))
        except (ValueError, github.GitHubError) as e:
            return self._json({"error": str(e)}, 400)
        token = self.headers.get("X-GitHub-Token") or None
        roles = [r for r in req.get("roles") or list(pipeline.ROLES) if r in pipeline.ROLES]
        jid = job_id_for(owner, repo, num)
        with LOCK:
            st = load_status(jid)
            reuse = st and st["status"] in ("running", "queued") and jid in RUNNING or \
                st and st["status"] == "done" and not req.get("refresh") and set(roles) <= set(st["roles_ready"])
            if reuse:
                return self._json(st)
            if req.get("refresh") or (st and st["status"] == "error"):
                shutil.rmtree(JOBS / jid, ignore_errors=True)
            st = new_status(jid, f"https://github.com/{owner}/{repo}/pull/{num}", roles)
            save_status(st)
            RUNNING[jid] = threading.Thread(target=worker, args=(jid, st["pr_url"], token, roles), daemon=True)
            RUNNING[jid].start()
        self._json(st, 202)

    def _media(self, name):
        f = MEDIA / name
        if name.startswith(".") or "/" in name or "\\" in name or not f.exists():
            return self._json({"error": "not found"}, 404)
        size = f.stat().st_size
        rng = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        a, b = (int(rng.group(1)), int(rng.group(2) or size - 1)) if rng else (0, size - 1)
        b = min(b, size - 1)
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(b - a + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(a)
            self.wfile.write(fh.read(b - a + 1))

    def log_message(self, fmt, *args):  # request line only (never headers, so the token is never logged)
        print(f"{self.address_string()} {fmt % args}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    JOBS.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "app" / "DevTok" / "Resources").glob("*.mp4"):
        if not (MEDIA / f.name).exists():
            (MEDIA / f.name).symlink_to(f)
    print(f"DevTok server on http://{a.host}:{a.port}")
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
