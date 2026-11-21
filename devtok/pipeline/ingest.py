"""S0/S1: parse a unified diff (or free text) into files, hunks, post-image lines and symbols. No LLM."""
import fnmatch
import re

NOISE = ["*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock", "poetry.lock", "*.min.js", "*.min.css",
         "*.svg", "*.png", "*.jpg", "*.gif", "*.pbxproj", "dist/*", "build/*", "vendor/*", "*_pb2.py", "*.pb.go",
         "*/__snapshots__/*", "*.snap", "*/cassettes/*", "*.yaml.gz"]
SECRET = re.compile(r"(?i)(api[_-]?key|secret|token|password)(\s*[:=]\s*)(['\"]?)[A-Za-z0-9_\-./+]{12,}\3")
SYM = re.compile(r"^\s*(async\s+def|def|class)\s+([A-Za-z_]\w*)")
LANG = {".py": "python", ".md": "markdown", ".ts": "typescript", ".js": "javascript", ".swift": "swift",
        ".go": "go", ".rs": "rust", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml", ".json": "json"}


def redact(text):
    n = 0

    def sub(m):
        nonlocal n
        n += 1
        return f"{m.group(1)}{m.group(2)}{m.group(3)}<redacted>{m.group(3)}"
    return SECRET.sub(sub, text), n


def is_noise(path):
    return any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(path.split("/")[-1], g) for g in NOISE)


def parse_diff(text):
    files, cur, hunk, new_no = [], None, None, 0
    for raw in text.splitlines():
        if raw.startswith("diff --git "):
            m = re.match(r"diff --git a/(.+?) b/(.+)$", raw)
            cur = {"path": m.group(2) if m else raw[11:], "status": "modified", "hunks": [], "added": 0, "deleted": 0, "lines": {}}
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if raw.startswith("new file mode"):
            cur["status"] = "added"
        elif raw.startswith("deleted file mode"):
            cur["status"] = "deleted"
        elif raw.startswith("rename to "):
            cur["path"] = raw[10:]
        elif raw.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)", raw)
            new_no = int(m.group(3)) if m else 1
            hunk = {"new_start": new_no, "new_end": new_no, "header": (m.group(5) or "").strip() if m else "", "text": []}
            cur["hunks"].append(hunk)
        elif hunk is not None:
            if raw.startswith("\\"):
                continue
            tag, body = (raw[:1] or " "), raw[1:]
            if tag == "-":
                cur["deleted"] += 1
                hunk["text"].append(("-", None, body))
                continue
            if tag == "+":
                cur["added"] += 1
            cur["lines"][new_no] = (tag, body)
            hunk["text"].append((tag, new_no, body))
            hunk["new_end"] = new_no
            new_no += 1
    return files


def symbols_for(f):
    """Python-ish symbol scan over the visible post-image lines (context + added)."""
    lines = f["lines"]
    nums = sorted(lines)
    syms = []
    for n in nums:
        m = SYM.match(lines[n][1])
        if m:
            indent = len(lines[n][1]) - len(lines[n][1].lstrip())
            syms.append({"name": m.group(2), "kind": "class" if m.group(1) == "class" else "function",
                         "start_line": n, "indent": indent, "added": lines[n][0] == "+"})
    for i, s in enumerate(syms):
        end = s["start_line"]
        for n in nums:
            if n <= s["start_line"]:
                continue
            body = lines[n][1]
            if body.strip() and (len(body) - len(body.lstrip())) <= s["indent"] and not body.lstrip().startswith((")", "]", "@", "#")):
                break
            if n - end > 3 and n not in lines:
                break
            end = n
        s["end_line"] = end
    return syms


def ingest(text):
    text, redactions = redact(text)
    files = parse_diff(text)
    out = []
    for i, f in enumerate(files):
        fid = f"f{i + 1:02d}"
        ext = "." + f["path"].rsplit(".", 1)[-1] if "." in f["path"] else ""
        syms = symbols_for(f) if f["path"].endswith(".py") else []
        for k, s in enumerate(syms):
            s["symbol_id"] = f"{fid}.s{k + 1}"
        hunks = [{"hunk_id": f"{fid}.h{k + 1}", "new_start": h["new_start"], "new_end": h["new_end"], "header": h["header"],
                  "text": h["text"]} for k, h in enumerate(f["hunks"])]
        kind = "test" if "/test" in f["path"] or f["path"].split("/")[-1].startswith("test_") else (
            "docs" if f["path"].startswith("docs/") or ext == ".md" else "source")
        out.append({"file_id": fid, "path": f["path"], "status": f["status"], "lang": LANG.get(ext, ext.strip(".") or "text"),
                    "kind": kind, "added": f["added"], "deleted": f["deleted"], "noise": is_noise(f["path"]),
                    "symbols": syms, "hunks": hunks, "lines": f["lines"]})
    return {"files": out, "redactions": redactions,
            "stats": {"files": len(out), "added": sum(f["added"] for f in out), "deleted": sum(f["deleted"] for f in out)}}


def fact_sheet(f, max_lines=14):
    """Compact per-file summary for prompts (no line-level code except a few added signature lines)."""
    added_sig = []
    for h in f["hunks"]:
        for tag, n, body in h["text"]:
            if tag == "+" and body.strip() and not body.strip().startswith("#") and len(added_sig) < max_lines:
                if SYM.match(body) or re.match(r"\s*(@|[A-Z_]{3,}\s*=|\w+\s*:\s*\w)", body) or "upload" in body.lower():
                    added_sig.append(f"{n}: {body.strip()[:110]}")
    return {"file_id": f["file_id"], "path": f["path"], "status": f["status"], "kind": f["kind"], "added": f["added"],
            "deleted": f["deleted"],
            "symbols": [{"symbol_id": s["symbol_id"], "name": s["name"], "kind": s["kind"], "lines": f"{s['start_line']}-{s['end_line']}",
                         "new": s["added"]} for s in f["symbols"]][:25],
            "hunk_headers": sorted({h["header"][:80] for h in f["hunks"] if h["header"]})[:10],
            "key_added_lines": added_sig}


def code_excerpt(f, start, end, mark=None):
    """Numbered post-image lines [start,end] that are visible in the diff; '+' marks added lines."""
    rows = []
    for n in range(start, end + 1):
        if n in f["lines"]:
            tag, body = f["lines"][n]
            rows.append({"line": n, "code": body, "added": tag == "+"})
    return rows


def file_excerpt_for_prompt(f, budget=90):
    """Added/changed regions with line numbers, trimmed to a line budget."""
    out, used = [], 0
    for h in f["hunks"]:
        seg = [f"@@ {f['path']} {h['hunk_id']} lines {h['new_start']}-{h['new_end']} {h['header'][:60]}"]
        for tag, n, body in h["text"]:
            if tag == "-":
                seg.append(f"   -  {body[:120]}")
            elif tag == "+":
                seg.append(f"{n:5d}+ {body[:120]}")
            else:
                seg.append(f"{n:5d}  {body[:120]}")
        if used + len(seg) > budget:
            seg = seg[: max(0, budget - used)]
        out += seg
        used += len(seg)
        if used >= budget:
            out.append("   ... (truncated)")
            break
    return "\n".join(out)
