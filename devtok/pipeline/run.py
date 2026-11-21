"""DevTok pipeline: PR text + role -> concept graph -> role storyboard -> reel scripts -> grounded code refs
-> quiz every 2 reels -> approval summary -> manifest_<role>.json for the iOS app (+ debug texts).

    python3 run.py --pr ../mock/pr --out ../out/pydantic-ai-3942 [--roles technical_engineer,team_lead,paying_manager]
"""
import argparse
import json
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import ingest
from llm import LLM

ROLES = {
    "technical_engineer": {
        "label": "Technical engineer",
        "reels": 6,
        "rules": ("Audience: the engineer who must review and maintain this code. Name exact classes, functions and files. "
                  "Explain the mechanism, data flow between modules and one invariant. Include one 'remove this line -> what breaks' "
                  "counterfactual (break_it). Code vocabulary is fine. Every reel MUST cite code (code_refs)."),
        "scenes": "diagram_tour, code_zoom, sequence, break_it, before_after",
        "quiz": "core, break_it, edge_case, connect",
        "summary": "invariants, tests to add, edge cases, compatibility risks",
    },
    "team_lead": {
        "label": "Team lead",
        "reels": 4,
        "rules": ("Audience: the team lead who approves the merge. Talk in components, teams and interfaces. For each change say "
                  "which team owns it, who else is affected (blast radius), what could regress, and the 2 checks a reviewer must do. "
                  "Show code only as a one-line pointer (at most one code_ref per reel). Use team names from the org context."),
        "scenes": "diagram_tour, org_chart, before_after, break_it",
        "quiz": "ownership, connect, break_it (as consequence), rollout",
        "summary": "risks, owners, reviewers, rollout and follow-ups",
    },
    "paying_manager": {
        "label": "Paying manager",
        "reels": 4,
        "rules": ("Audience: the manager who pays for the product. NO code and no jargon without a 5-word plain gloss. For each part "
                  "say what it does for the user, what we pay for it and how this PR changes that (ONLY use numbers from the org "
                  "context; never invent prices), and the business risk (money, downtime, trust, compliance). One everyday analogy "
                  "per reel. code_refs must be empty."),
        "scenes": "diagram_tour, cost_meter, before_after",
        "quiz": "cost, user_impact, connect, risk",
        "summary": "cost delta, user impact, go/no-go in 3 bullets",
    },
}
SCENES = ["diagram_tour", "code_zoom", "sequence", "break_it", "before_after", "cost_meter", "org_chart", "title_card"]
MOCK_VIDEO = "cat.mp4"
# whole-reel visual styles from claude-animation-skills (the renderer plays the clip full screen, slowed to the narration)
STYLE_DEFS = {
    "minimalistic-graphics": ("black-and-white steps rising, a dot hops up them; for a sequence (setup steps, the order things happen)",
                              '{"lines":["<=24 chars lowercase","<=24 chars payoff"],"steps":3-7}'),
    "map-route": ("a 3D city map, a route draws itself through 5 named places to a destination pin, with an ETA card; use it as the journey "
                  "of one piece of data through the system (places = the components it passes, destination = where it ends up)",
                  '{"destination":"<=20 chars","minutes":int 1-60,"distance":number,"unit":"km","places":["<=16","<=16","<=16","<=16","<=16"]}'),
    "breakdown": ("a 3D exploded view: a device comes apart into 6 labelled layers; use it for the anatomy of the feature (its layers/modules, top first)",
                  '{"title":"<=16","subtitle":"<=24","labels":[["name <=16","note <=22"] x6],"date":"<=24 chars"}'),
    "studio": ("a dark studio where the PR's services float as matte devices with numbered labels, joined by thin lines with "
               "light pulses; the camera leans to the focused one and a small cat points at it. Use it for how services connect",
               '{"title":"<=20"}'),
    "desk": ("the cat sits at a desk in front of a live observability dashboard: a trace waterfall of spans, 3 metric tiles, "
             "scrolling logs. Use it for runtime behaviour: what gets traced/measured/logged. Use real span/metric names from the code",
             '{"dashboard_title":"<=30","spans":[{"name":"<=24 real span name","component_id":"c_x","ms":int}] (4-7, parent first),'
             '"metrics":[{"name":"<=20","value":number,"unit":"<=4"}] (3),"logs":["<=60 realistic log line"] (3-6)}'),
    "graph": ("a line graph that draws itself with a big number counting up; use REAL numbers from the PR facts (e.g. cumulative lines added "
              "per module, number of spans/metrics/exporters added); values must increase",
              '{"label":"<=32","values":[4-9 increasing numbers],"labels":["<=6"],"final":number,"prefix":"","suffix":"","decimals":0}'),
}


def clean_style(name, spec):
    """Validate/normalise a skill spec; returns None if unusable."""
    def clip(x, n):
        x = str(x).strip()
        return x if len(x) <= n else x[:n].rsplit(" ", 1)[0]
    try:
        if name == "minimalistic-graphics":
            lines = [clip(x, 24).lower() for x in spec.get("lines", []) if str(x).strip()][:2]
            return {"lines": lines, "steps": max(3, min(7, int(spec.get("steps", 4))))} if len(lines) == 2 else None
        if name == "map-route":
            places = [clip(x, 16) for x in spec.get("places", [])][:5]
            places += [""] * (5 - len(places))
            return {"destination": clip(spec.get("destination", "Destination"), 20), "minutes": max(1, min(60, int(spec.get("minutes", 5)))),
                    "distance": round(float(spec.get("distance", 1.0)), 1), "unit": "km", "places": places, "accent": "#ff7a1a", "seed": 11}
        if name == "breakdown":
            labels = [[clip(a, 16), clip(b, 22)] for a, b in (spec.get("labels") or [])][:6]
            labels += [["", ""]] * (6 - len(labels))
            return {"title": clip(spec.get("title", "Anatomy"), 16), "subtitle": clip(spec.get("subtitle", "Exploded view"), 24),
                    "labels": labels, "time": "9:41", "date": clip(spec.get("date", "Pull request"), 24), "accent": "#ff7a1a"}
        if name == "studio":
            return {"title": clip(spec.get("title", ""), 20)}
        if name == "desk":
            spans = [{"name": clip(s.get("name", "span"), 24), "component_id": s.get("component_id"), "ms": max(5, min(900, int(s.get("ms", 50))))}
                     for s in (spec.get("spans") or []) if isinstance(s, dict)][:7]
            mets = [{"name": clip(m.get("name", "metric"), 20), "value": float(m.get("value", 0)), "unit": clip(m.get("unit", ""), 4)}
                    for m in (spec.get("metrics") or []) if isinstance(m, dict)][:3]
            return {"dashboard_title": clip(spec.get("dashboard_title", ""), 30), "spans": spans, "metrics": mets,
                    "logs": [clip(x, 60) for x in (spec.get("logs") or [])][:6]}
        if name == "graph":
            vals = [float(x) for x in spec.get("values", [])]
            if len(vals) < 3 or any(b < a for a, b in zip(vals, vals[1:])):
                return None
            out = {"label": clip(spec.get("label", ""), 32), "values": vals[:9], "prefix": str(spec.get("prefix", ""))[:2],
                   "suffix": str(spec.get("suffix", ""))[:4], "decimals": int(spec.get("decimals", 0) or 0), "dark": True}
            if spec.get("labels") and all(len(str(x)) <= 6 for x in spec["labels"]):
                out["labels"] = [str(x) for x in spec["labels"]][:len(out["values"])]
            if isinstance(spec.get("final"), (int, float)):
                out["final"] = spec["final"]
            return out
    except (TypeError, ValueError):
        return None
    return None


def words(s):
    return len(re.findall(r"\w+", s or ""))


# ---------------------------------------------------------------- repo context (beyond the diff)
def repo_context(pr, data):
    tree = pr.get("repo_tree") or []
    if not tree:
        return None
    changed = [f["path"] for f in data["files"]]
    tops = {p.split("/")[0] for p in changed if "/" in p and not p.startswith(("tests", "test", "docs", "."))}
    mods = [p for p in tree if p.endswith((".py", ".ts", ".go", ".rs", ".js")) and p.split("/")[0] in tops
            and "/test" not in p and p not in changed]
    mods.sort(key=lambda p: (p.count("/"), p))
    return {"readme_excerpt": (pr.get("readme") or "")[:2500], "unchanged_modules": mods[:160]}


# ---------------------------------------------------------------- S2 graph + concepts (role-agnostic)
def stage_graph(llm, pr, data, org):
    src = sorted([f for f in data["files"] if not f["noise"] and f["kind"] != "test"], key=lambda f: -(f["added"] + f["deleted"]))
    facts = [ingest.fact_sheet(f, max_lines=14 if len(src) <= 40 else 6) for f in src[:70]]
    tests = [{"file_id": f["file_id"], "path": f["path"], "added": f["added"]} for f in data["files"] if f["kind"] == "test"][:60]
    commits = [c.get("message", "").split("\n")[0][:100] for c in pr.get("commits", [])][:60]
    repo_ctx = repo_context(pr, data)
    system = (
        "You are a staff software architect. From the fact sheets of a pull request, build the system map a newcomer needs to "
        "understand it, plus the key concepts worth explaining in short videos. Output ONE JSON object:\n"
        '{"summary":"2-3 sentences: what the PR does and why",'
        '"components":[{"id":"c_<snake>","name":"<=4 words","kind":"module|service|store|external|ui|job|config|test",'
        '"responsibility":"one sentence","change":"added|modified|unchanged","file_ids":["f04"],"key_symbol_ids":["f04.s2"],'
        '"owner_team":"team from org context or null","vendor":"e.g. OpenAI or null","monthly_cost_usd":number or null,'
        '"cost_note":"only from org context, else null","user_facing":bool,"risk":"low|medium|high","risk_reason":"..."}],'
        '"edges":[{"id":"e1","from":"c_x","to":"c_y","label":"<=5 words","kind":"call|data|event|depends","change":"added|modified|unchanged"}],'
        '"flows":[{"id":"fl1","name":"...","edge_ids":["e1","e2"]}],'
        '"concepts":[{"id":"k1","title":"<=7 words","kind":"pattern|invariant|data_flow|risk|cost|decision|ux","summary":"1-2 sentences",'
        '"component_ids":["c_x"],"symbol_ids":["f04.s2"],"importance":0..1,'
        '"visual_hint":"diagram_tour|code_zoom|before_after|break_it|cost_meter|sequence|org_chart"}]}\n'
        "Rules: 5-9 components; when many files play the same role (adapters, plugins, handlers), group them into one hub component plus "
        "the 2-3 most important members. Add external systems (third-party APIs, databases, the user-facing app) as kind=external even "
        "without files. 6-10 concepts covering mechanism, data flow, cost, risk and tests. Use ONLY file_id/symbol_id values given. "
        "monthly_cost_usd only if stated in the org context. "
        "If repo_context is given, ALSO add 2-5 components with change=unchanged for the parts of the repository the changed code plugs into "
        "(callers, the agent loop, the CLI entrypoint, the LLM backend, external collectors/backends), named after real modules in repo_context, "
        "so the data flow is shown end to end even beyond the diff. Edges must describe how data flows (e.g. 'span', 'metrics', 'tool call').")
    user = json.dumps({
        "pr_title": pr.get("title"), "pr_body": (pr.get("body") or "")[:3000], "commit_messages": commits,
        "org_context": org, "source_and_docs_files": facts, "test_files": tests, "repo_context": repo_ctx}, ensure_ascii=False)
    fids = {f["file_id"] for f in data["files"]}

    def validate(g):
        comps = g["components"]
        if not 4 <= len(comps) <= 13:
            raise ValueError("need 5-9 components")
        cids = {c["id"] for c in comps}
        for e in g["edges"]:
            if e["from"] not in cids or e["to"] not in cids:
                raise ValueError(f"edge {e['id']} references unknown component")
        for c in comps:
            c["file_ids"] = [x for x in c.get("file_ids", []) if x in fids]
        for k in g["concepts"]:
            k["component_ids"] = [x for x in k.get("component_ids", []) if x in cids]
        if len(g["concepts"]) < 4:
            raise ValueError("need >= 6 concepts")
    return llm.chat_json("S2_graph", system, user, tier="large", validate=validate, max_tokens=9000)


# ---------------------------------------------------------------- S3 storyboard per role
def stage_storyboard(llm, role, graph, org, styles=None):
    R = ROLES[role]
    n = 1 + len(styles) if styles else R["reels"]
    style_rule = ""
    if styles:
        style_rule = ("\nEach reel has a fixed visual style. Reel 1: diagram_tour (the full data-flow map, including unchanged parts of the repo). "
                      + " ".join(f"Reel {k + 2}: {st} — {STYLE_DEFS[st][0]}." for k, st in enumerate(styles))
                      + " Pick each reel's concept so it suits its style. Set scene_type to the style name for reels 2+.")
    system = (
        f"You are the showrunner of short vertical (9:16) explainer reels, 20-35 seconds each, for a {R['label']}. {R['rules']}\n"
        f"Plan exactly {n} reels that tell ONE coherent story through the system map (a guided tour, not disconnected chunks). "
        "Reel 1 is a map tour: travel along the main flow and say what each part does. The last reel is 'what to check / what it means for "
        "you'. Each reel = one concept, one focus component, a hook in the first 2 seconds. A quiz follows every 2 reels, so mark 1-2 "
        f"facts per reel the viewer must retain. Prefer scene types: {R['scenes']}.{style_rule}\nOutput JSON: "
        '{"arc":"one sentence story","reels":[{"reel_id":"r01","order":1,"concept_id":"k1","title":"<=7 words","hook":"<=12 words",'
        '"focus_component_id":"c_x","path_component_ids":["c_a","c_b"],"scene_type":"' + "|".join(SCENES + list(STYLE_DEFS)) + '",'
        '"takeaways":["..."],"target_seconds":25}]}\nUse only component and concept ids from the input.')
    user = json.dumps({"role": role, "graph": graph, "org_context": org if role != "technical_engineer" else None}, ensure_ascii=False)
    cids = {c["id"] for c in graph["components"]}

    def validate(sb):
        if len(sb["reels"]) != n:
            raise ValueError(f"need exactly {n} reels, got {len(sb['reels'])}")
        for i, r in enumerate(sb["reels"]):
            r["reel_id"] = f"r{i + 1:02d}"
            r["order"] = i + 1
            if r["focus_component_id"] not in cids:
                raise ValueError(f"{r['reel_id']}: unknown focus_component_id {r['focus_component_id']}")
            r["path_component_ids"] = [x for x in r.get("path_component_ids", []) if x in cids]
            if styles:
                r["style"] = None if i == 0 else styles[i - 1]
                r["scene_type"] = "diagram_tour" if i == 0 else styles[i - 1]
            elif r.get("scene_type") not in SCENES:
                r["scene_type"] = "diagram_tour"
    return llm.chat_json(f"S3_storyboard_{role}", system, user, tier="large", validate=validate)


# ---------------------------------------------------------------- S4 script per reel
def stage_script(llm, role, reel, graph, data, org, arc):
    R = ROLES[role]
    comp_by = {c["id"]: c for c in graph["components"]}
    focus = comp_by[reel["focus_component_id"]]
    fids = list(dict.fromkeys(focus.get("file_ids", []) + [fid for cid in reel.get("path_component_ids", [])
                                                            for fid in comp_by[cid].get("file_ids", [])][:2]))
    files = {f["file_id"]: f for f in data["files"]}
    code = "\n\n".join(ingest.file_excerpt_for_prompt(files[fid], budget=110 // max(1, len(fids[:3]))) for fid in fids[:3] if fid in files)
    syms = [{"symbol_id": s["symbol_id"], "file_id": fid, "name": s["name"], "lines": f"{s['start_line']}-{s['end_line']}"}
            for fid in fids[:3] if fid in files for s in files[fid]["symbols"]][:30]
    target = reel.get("target_seconds", 25)
    style = reel.get("style")
    style_rule = (f"\nThis reel is rendered in the '{style}' style: {STYLE_DEFS[style][0]}. Narrate so it matches that picture, and add "
                  f'"style_spec": {STYLE_DEFS[style][1]} to the JSON.') if style else ""
    system = (
        f"You write the script of ONE vertical explainer reel for a {R['label']}. {R['rules']}\n"
        f"Story arc of the series: {arc}\nTarget {target} s of voice at ~2.5 words/s (about {int(target * 2.5)} words). Friendly, "
        f"concrete, no filler. The narration MUST be {int(target * 2.3)}-{int(target * 2.8)} words: full sentences, not notes. The visuals are an animated architecture diagram: boxes for components, glowing packets moving along edges, "
        "a highlighted box, an optional code card, and a cartoon cat narrator pointing at things. Split into 3-6 shots.\n"
        "Output JSON: {\"title\":\"<=7 words\",\"narration\":\"full spoken text\",\"on_screen_text\":\"<=18 chars\","
        '"shots":[{"t_start":0,"t_end":4,"narration":"sentence(s) spoken in this shot","caption":"1-4 words",'
        '"visual":"what the camera/diagram does","highlight_component_id":"c_x or null","flow_edge_ids":["e1"],"code_ref_id":"cr1 or null"}],'
        '"code_refs":[{"id":"cr1","file_id":"f04","symbol_id":"f04.s2 or null","start_line":10,"end_line":24,"highlight_lines":[12],'
        '"why":"what to look at"}],'
        '"break_it":{"code_ref_id":"cr1","line":12,"what_breaks":"..."} or null,'
        '"retain_facts":["fact the quiz can ask, stated in the narration"]}\n'
        "Line numbers must be real post-change line numbers from the CODE section (the number before '+' or space). Use only the given "
        "component/edge/file/symbol ids." + style_rule)
    user = json.dumps({"reel": reel, "focus_component": focus, "pr_file_stats": [{"path": f["path"], "added": f["added"]} for f in data["files"]][:30] if style == "graph" else None,
                       "neighbours": [comp_by[c] for c in reel.get("path_component_ids", []) if c in comp_by][:4],
                       "edges": [e for e in graph["edges"] if focus["id"] in (e["from"], e["to"])],
                       "symbols": syms if role != "paying_manager" else [],
                       "org_context": org if role != "technical_engineer" else None}, ensure_ascii=False)
    if role != "paying_manager":
        user += "\n\nCODE:\n" + code

    def validate(s):
        if not s.get("shots"):
            raise ValueError("no shots")
        joined = " ".join(x.get("narration", "") for x in s["shots"])
        if words(joined) > words(s.get("narration", "")):
            s["narration"] = joined
        if words(s["narration"]) < int(target * 1.6):
            raise ValueError(f"narration has {words(s['narration'])} words; write {int(target * 2.3)}-{int(target * 2.8)} words in total, "
                             "with each shot's narration being full spoken sentences")
    return llm.chat_json(f"S4_script_{role}_{reel['reel_id']}", system, user, tier="medium", validate=validate, max_tokens=5000)


# ---------------------------------------------------------------- S5 grounding (code, no LLM)
def ground(role, script, reel, graph, data):
    files = {f["file_id"]: f for f in data["files"]}
    by_path = {f["path"]: f for f in data["files"]}
    sym_index = {s["symbol_id"]: (f, s) for f in data["files"] for s in f["symbols"]}
    refs = []
    for r in script.get("code_refs") or []:
        f = files.get(r.get("file_id")) or by_path.get(r.get("file", ""))
        sym = sym_index.get(r.get("symbol_id") or "")
        if not f and sym:
            f = sym[0]
        if not f:
            continue
        try:
            a, b = int(r.get("start_line", 0)), int(r.get("end_line", 0))
        except (TypeError, ValueError):
            a = b = 0
        rows = ingest.code_excerpt(f, a, b) if a and b and b >= a else []
        if len(rows) < 2 and sym and sym[0] is f:
            a, b = sym[1]["start_line"], sym[1]["end_line"]
            rows = ingest.code_excerpt(f, a, b)
        if len(rows) < 2:  # fall back to the biggest added hunk of the file
            h = max(f["hunks"], key=lambda h: sum(1 for t in h["text"] if t[0] == "+"), default=None)
            if not h:
                continue
            a, b = h["new_start"], h["new_end"]
            rows = ingest.code_excerpt(f, a, b)
        rows = rows[:18]
        hl = [n for n in (r.get("highlight_lines") or []) if isinstance(n, int) and any(x["line"] == n for x in rows)]
        if not hl:
            hl = [x["line"] for x in rows if x["added"]][:3]
        refs.append({"id": r.get("id") or f"cr{len(refs) + 1}", "file": f["path"], "file_id": f["file_id"],
                     "start_line": rows[0]["line"], "end_line": rows[-1]["line"], "highlight_lines": hl,
                     "why": r.get("why", ""), "language": f["lang"], "lines": rows,
                     "github_url": None})
    if role == "paying_manager":
        refs = []
    if role == "team_lead":
        refs = refs[:1]
    if role == "technical_engineer" and not refs:  # engineers always get code
        comp = next(c for c in graph["components"] if c["id"] == reel["focus_component_id"])
        for fid in comp.get("file_ids", []):
            f = files.get(fid)
            if f and f["symbols"]:
                s = max(f["symbols"], key=lambda s: s["end_line"] - s["start_line"])
                rows = ingest.code_excerpt(f, s["start_line"], s["end_line"])[:18]
                refs.append({"id": "cr1", "file": f["path"], "file_id": fid, "start_line": rows[0]["line"], "end_line": rows[-1]["line"],
                             "highlight_lines": [x["line"] for x in rows if x["added"]][:3], "why": f"Where {s['name']} lives",
                             "language": f["lang"], "lines": rows, "github_url": None})
                break
    ref_ids = {r["id"] for r in refs}
    bi = script.get("break_it")
    if bi and (bi.get("code_ref_id") not in ref_ids):
        bi = None
    if bi:
        ref = next(r for r in refs if r["id"] == bi["code_ref_id"])
        line = bi.get("line") if any(x["line"] == bi.get("line") for x in ref["lines"]) else (ref["highlight_lines"] or [ref["start_line"]])[0]
        bi = {"code_ref_id": ref["id"], "line": line, "removed_code": next((x["code"] for x in ref["lines"] if x["line"] == line), ""),
              "what_breaks": bi.get("what_breaks", "")}
    cids = {c["id"] for c in graph["components"]}
    eids = {e["id"] for e in graph["edges"]}
    dur = round(max(8.0, words(script["narration"]) / 2.5), 1)
    shots = script.get("shots") or []
    total_w = sum(max(1, words(s.get("narration", ""))) for s in shots) or 1
    t = 0.0
    for s in shots:  # retime shots from narration length, drop unknown ids
        d = dur * max(1, words(s.get("narration", ""))) / total_w
        s["t_start"], s["t_end"] = round(t, 2), round(t + d, 2)
        t += d
        if s.get("highlight_component_id") not in cids:
            s["highlight_component_id"] = reel["focus_component_id"]
        s["flow_edge_ids"] = [e for e in s.get("flow_edge_ids") or [] if e in eids]
        if s.get("code_ref_id") not in ref_ids:
            s["code_ref_id"] = None
    return {
        "type": "video", "id": reel["reel_id"], "order": reel["order"], "title": script.get("title") or reel["title"],
        "hook": reel.get("hook", ""), "concept_id": reel.get("concept_id"), "scene_type": reel.get("scene_type"),
        "focus_component_id": reel["focus_component_id"], "path_component_ids": reel.get("path_component_ids", []),
        "narration": script["narration"], "on_screen_text": script.get("on_screen_text", ""), "duration_s": dur,
        "shots": shots, "code_refs": refs, "break_it": bi, "retain_facts": script.get("retain_facts", reel.get("takeaways", [])),
        "video": MOCK_VIDEO, "video_is_mock": True,
        "style": ({"name": reel["style"], "spec": clean_style(reel["style"], script.get("style_spec") or {})}
                  if reel.get("style") else None),
    }


# ---------------------------------------------------------------- S6 quiz after every 2 reels
def stage_quiz(llm, role, idx, reels):
    R = ROLES[role]
    system = (
        f"You write a quick comprehension check for a {R['label']} who just watched {len(reels)} short reels. 3 multiple-choice "
        f"questions: one per reel plus one connecting them (or a what-if). Categories to prefer: {R['quiz']}. Each question answerable "
        "ONLY from the narration given. 3 choices, similar length, plausible distractors, exactly one correct. Keep prompts under 25 words.\n"
        'Output JSON: {"questions":[{"prompt":"...","choices":["...","...","..."],"correct_index":0,"category":"...",'
        '"explanation":"why the right answer is right and the tempting wrong one is wrong","linked_video_ids":["r01"]}]}')
    user = json.dumps([{"video_id": r["id"], "title": r["title"], "narration": r["narration"], "retain_facts": r["retain_facts"],
                        "break_it": r["break_it"]} for r in reels], ensure_ascii=False)

    def validate(q):
        if len(q["questions"]) < 2:
            raise ValueError("need 3 questions")
        for x in q["questions"]:
            if len(x["choices"]) != 3 or not 0 <= int(x["correct_index"]) < 3:
                raise ValueError("each question needs 3 choices and a valid correct_index")
    q = llm.chat_json(f"S6_quiz_{role}_{idx}", system, user, tier="small", validate=validate, max_tokens=3000)
    rnd = random.Random(f"{role}{idx}")
    out = []
    for i, x in enumerate(q["questions"][:3]):
        correct = x["choices"][int(x["correct_index"])]
        ch = x["choices"][:]
        rnd.shuffle(ch)
        ci = ch.index(correct)
        out.append({"id": f"Q{idx}.{i + 1}", "label": f"Q{idx}.{i + 1} · {x.get('category', 'core').replace('_', ' ').title()}",
                    "prompt": x["prompt"], "choices": ch, "correct_index": ci, "correct_letter": "ABC"[ci],
                    "category": x.get("category", "core"), "explanation": x.get("explanation", ""),
                    "linked_video_ids": [v for v in x.get("linked_video_ids", []) if v in {r["id"] for r in reels}] or [reels[-1]["id"]]})
    return {"type": "quiz", "id": f"qc{idx}", "after_video_id": reels[-1]["id"], "video_ids": [r["id"] for r in reels],
            "pass_threshold": 0.67, "questions": out}


# ---------------------------------------------------------------- S7 approval summary
def stage_summary(llm, role, pr, graph, videos, org):
    R = ROLES[role]
    system = (
        f"You prepare the final approval screen of a pull request for a {R['label']}. Emphasise: {R['summary']}. Be specific to this PR. "
        "Only use cost numbers present in the org context.\nOutput JSON: "
        '{"verdict_suggestion":"approve|approve_with_conditions|request_changes","headline":"<=20 words",'
        '"what_changed":["3-5 bullets"],"why":"1-2 sentences",'
        '"risks":[{"title":"...","severity":"low|medium|high","component_ids":["c_x"],"mitigation":"..."}],'
        '"checklist":[{"text":"...","kind":"verify|test|ask|cost|rollout","blocking":bool}],'
        '"cost_impact":{"summary":"one sentence","monthly_delta_usd":number or null,"confidence":"stated|estimated|unknown"},'
        '"user_impact":"one sentence"}')
    user = json.dumps({"pr_title": pr.get("title"), "graph_summary": graph.get("summary"),
                       "components": [{k: c.get(k) for k in ("id", "name", "change", "owner_team", "risk", "risk_reason", "monthly_cost_usd", "cost_note")} for c in graph["components"]],
                       "reels": [{"id": v["id"], "title": v["title"], "narration": v["narration"]} for v in videos],
                       "org_context": org}, ensure_ascii=False)
    return llm.chat_json(f"S7_summary_{role}", system, user, tier="large", max_tokens=4000)


# ---------------------------------------------------------------- orchestration
def run_role(llm, role, pr, data, graph, org, out_dir, timings, styles=None):
    t0 = time.time()
    sb = stage_storyboard(llm, role, graph, org, styles)
    with ThreadPoolExecutor(4) as ex:
        scripts = list(ex.map(lambda r: stage_script(llm, role, r, graph, data, org, sb["arc"]), sb["reels"]))
    videos = [ground(role, s, r, graph, data) for s, r in zip(scripts, sb["reels"])]
    pairs = [videos[i:i + 2] for i in range(0, len(videos), 2)]
    with ThreadPoolExecutor(3) as ex:
        quizzes = list(ex.map(lambda ip: stage_quiz(llm, role, ip[0] + 1, ip[1]), enumerate(pairs)))
    summary = stage_summary(llm, role, pr, graph, videos, org)
    items = []
    for pair, q in zip(pairs, quizzes):
        items += pair + [q]
    items.append({"type": "verdict", "id": "verdict"})
    manifest = {
        "schema": "devtok.manifest.v1", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "role": role, "role_label": ROLES[role]["label"], "arc": sb["arc"],
        "pr": {k: pr.get(k) for k in ("title", "number", "repo", "url", "author", "merged_at")} | {
            "stats": data["stats"], "redactions": data["redactions"],
            "commits": [{"sha": (c.get("sha") or "")[:7], "message": (c.get("message") or "").split("\n")[0]} for c in pr.get("commits", [])],
            "files": [{"path": f["path"], "added": f["added"], "deleted": f["deleted"], "kind": f["kind"]} for f in data["files"]]},
        "graph": {k: graph[k] for k in ("summary", "components", "edges", "flows", "concepts")},
        "items": items, "summary": summary,
    }
    timings[role] = round(time.time() - t0, 1)
    (out_dir / f"manifest_{role}.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    (out_dir / f"explain_{role}.md").write_text(explain_md(manifest))
    return manifest


def explain_md(m):
    """The human-readable 'what are we explaining' text, for the debug view."""
    L = [f"# {m['pr']['title']}  —  {m['role_label']}", "", f"**Arc:** {m['arc']}", "", f"**System summary:** {m['graph']['summary']}", ""]
    for it in m["items"]:
        if it["type"] == "video":
            L += [f"## Reel {it['order']}: {it['title']}  ({it['scene_type']}, ~{it['duration_s']}s, focus `{it['focus_component_id']}`)",
                  f"*Hook:* {it['hook']}", "", it["narration"], ""]
            for s in it["shots"]:
                L.append(f"- `{s['t_start']:.1f}-{s['t_end']:.1f}s` **{s.get('caption', '')}** — {s.get('visual', '')}")
            for r in it["code_refs"]:
                L.append(f"- code: `{r['file']}:{r['start_line']}-{r['end_line']}` (hl {r['highlight_lines']}) — {r['why']}")
            if it["break_it"]:
                L.append(f"- break-it: line {it['break_it']['line']} `{it['break_it']['removed_code'].strip()}` → {it['break_it']['what_breaks']}")
            L.append(f"- retain: {'; '.join(it['retain_facts'])}")
            L.append("")
        elif it["type"] == "quiz":
            L.append(f"## Quiz {it['id']} (after {it['after_video_id']})")
            for q in it["questions"]:
                L.append(f"- **{q['prompt']}**  ✔ {q['choices'][q['correct_index']]}  — {q['explanation']}")
            L.append("")
    s = m["summary"]
    L += ["## Approval summary", f"**{s.get('verdict_suggestion')}** — {s.get('headline')}", ""]
    L += [f"- {x}" for x in s.get("what_changed", [])]
    L += ["", "Risks:"] + [f"- [{r.get('severity')}] {r.get('title')} — {r.get('mitigation')}" for r in s.get("risks", [])]
    L += ["", "Checklist:"] + [f"- {'(blocking) ' if c.get('blocking') else ''}{c.get('text')}" for c in s.get("checklist", [])]
    L += ["", f"Cost: {s.get('cost_impact', {}).get('summary')}", f"Users: {s.get('user_impact')}"]
    return "\n".join(L) + "\n"


def run_all(pr, diff_text, org, out_dir, roles=None, progress=None, styles=None):
    """Whole pipeline; `progress(stage, status, detail)` is called as stages start/finish (used by server.py)."""
    say = progress or (lambda *a: None)
    roles = roles or list(ROLES)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    say("ingest", "running", "Parsing the diff")
    data = ingest.ingest(diff_text)
    if not data["files"]:
        raise ValueError("The PR diff is empty or could not be parsed")
    say("ingest", "done", f"{data['stats']['files']} files, +{data['stats']['added']}/-{data['stats']['deleted']}, "
                          f"{sum(len(f['symbols']) for f in data['files'])} symbols, {data['redactions']} secrets redacted")
    llm = LLM(out_dir / "debug")
    graph_p = out_dir / "graph.json"
    say("graph", "running", "Building the system map")
    graph = json.loads(graph_p.read_text()) if graph_p.exists() else stage_graph(llm, pr, data, org)
    graph_p.write_text(json.dumps(graph, indent=2, ensure_ascii=False))
    say("graph", "done", f"{len(graph['components'])} components, {len(graph['edges'])} edges, {len(graph['concepts'])} concepts: "
                         + ", ".join(c["name"] for c in graph["components"]))
    timings = {}

    def one(role):
        say(role, "running", f"Storyboard, scripts, quiz and summary for {ROLES[role]['label']}")
        m = run_role(llm, role, pr, data, graph, org, out_dir, timings, styles if role == "technical_engineer" else None)
        vids = [i for i in m["items"] if i["type"] == "video"]
        say(role, "done", f"{len(vids)} reels: " + " / ".join(v["title"] for v in vids))
        return m
    with ThreadPoolExecutor(len(roles)) as ex:
        list(ex.map(one, roles))
    calls = [c for c in llm.calls if "usage" in c]
    stats = {"calls": llm.calls, "role_seconds": timings, "total_seconds": round(time.time() - t0, 1),
             "llm_calls": len(calls), "tokens": sum(c["usage"].get("total_tokens", 0) for c in calls)}
    (out_dir / "debug" / "calls.json").write_text(json.dumps(stats, indent=2))
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pr", default=str(Path(__file__).parent.parent / "mock" / "pr"))
    ap.add_argument("--out", default=str(Path(__file__).parent.parent / "out" / "run"))
    ap.add_argument("--roles", default=",".join(ROLES))
    ap.add_argument("--styles", default="", help="engineer reels 2..N styles, e.g. minimalistic-graphics,map-route,breakdown,graph")
    a = ap.parse_args()
    pr_dir = Path(a.pr)
    pr = json.loads((pr_dir / "pr.json").read_text())
    org_p = pr_dir / "org_context.md"
    org = org_p.read_text() if org_p.exists() else None
    stats = run_all(pr, (pr_dir / "pr.diff").read_text(), org, a.out, a.roles.split(","),
                    progress=lambda st, status, d: print(f"[{st}] {status}: {d}"), styles=[x for x in a.styles.split(",") if x] or None)
    print(f"done in {stats['total_seconds']}s, {stats['llm_calls']} LLM calls, {stats['tokens']} tokens")


if __name__ == "__main__":
    main()
