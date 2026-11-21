"""S4b: pick 0-2 styled inserts per role from the claude-animation-skills catalogue (without touching narration).

    python3 inserts.py --out ../out/pydantic-ai-3942 [--org ../mock/pr/org_context.md]

Adds `insert` to some video items of manifest_<role>.json:
  {"style": "graph", "shot_index": 1, "spec": {label, values[], labels[], final, prefix, suffix, decimals}}
  {"style": "dan-koe", "shot_index": 2, "spec": {"lines": [a, b], "depth": 8}}
  {"style": "minimalistic-graphics", "shot_index": 0, "spec": {"lines": [a, b], "steps": 4}}
"""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from llm import LLM

STYLES = {
    "graph": "an animated line graph + a big number counting up. Use for growth over time / steps: tokens or $ saved per chat turn, "
             "number of providers supported, cumulative cost. values: 4-9 numbers that INCREASE (the count follows the line up). "
             "Only use numbers stated in the narration or org context.",
    "dan-koe": "one white dot that branches into a tree, splitting at every level. Use for fan-out / blast radius: one change spreading "
               "to many providers, teams or call sites. lines: two short lowercase lines, the second is the payoff.",
    "minimalistic-graphics": "thin steps rising, a dot hops up them. Use for a sequence of steps: a rollout plan, a review checklist, "
                             "the request path in N hops. lines: two short lowercase lines; steps: 3-7 = number of steps.",
}
ROLE_PREF = {
    "technical_engineer": "Engineers mostly watch code; add at most 1 insert, only if a reel describes a sequence or a fan-out.",
    "team_lead": "Team leads like blast radius (dan-koe) and checklists (minimalistic-graphics). Add 1-2 inserts.",
    "paying_manager": "Managers like money and growth numbers. If the org context states monthly costs or percentages, you MUST add one "
                      "graph insert built from those numbers (e.g. cumulative $ or tokens re-sent per chat turn before the change, as an "
                      "increasing series). Otherwise use blast radius. Add 1-2 inserts.",
}


def clip(s, n):
    s = s.strip().rstrip(".")
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0]


def validate(obj, videos):
    ids = {v["id"]: v for v in videos}
    out = []
    for ins in obj.get("inserts", [])[:2]:
        v = ids.get(ins.get("reel_id"))
        style, spec = ins.get("style"), ins.get("spec") or {}
        if not v or style not in STYLES:
            continue
        k = max(0, min(int(ins.get("shot_index", 1)), len(v["shots"]) - 1))
        if style == "graph":
            vals = [float(x) for x in spec.get("values", []) if isinstance(x, (int, float))]
            if len(vals) < 3 or any(b < a for a, b in zip(vals, vals[1:])) or vals[-1] <= 0:
                continue
            spec = {"label": str(spec.get("label", ""))[:32], "values": vals[:9],
                    "labels": [str(x)[:6] for x in spec.get("labels", [])][:len(vals)] or None,
                    "final": spec.get("final") if isinstance(spec.get("final"), (int, float)) else None,
                    "prefix": str(spec.get("prefix", ""))[:2], "suffix": str(spec.get("suffix", ""))[:4],
                    "decimals": int(spec.get("decimals", 0)) if str(spec.get("decimals", 0)).isdigit() else 0, "dark": True}
            spec = {k2: v2 for k2, v2 in spec.items() if v2 is not None}
        else:
            lines = [clip(str(x).lower(), 26) for x in spec.get("lines", []) if str(x).strip()][:2]
            if len(lines) < 2:
                continue
            spec = {"lines": lines, **({"depth": 8} if style == "dan-koe" else {"steps": max(3, min(7, int(spec.get("steps", 4) or 4)))})}
        out.append({"reel_id": v["id"], "style": style, "shot_index": k, "spec": spec, "why": str(ins.get("why", ""))[:160]})
    return out


def run(out_dir, org=None, roles=None):
    out_dir = Path(out_dir)
    llm = LLM(out_dir / "debug")

    def one(mp):
        m = json.loads(mp.read_text())
        role = m["role"]
        videos = [i for i in m["items"] if i["type"] == "video"]
        system = ("You are a motion designer adding ONE-shot visual inserts to short explainer reels. Available styles:\n"
                  + "\n".join(f"- {k}: {v}" for k, v in STYLES.items())
                  + f"\n{ROLE_PREF.get(role, '')} Pick at most 2 inserts, at most one per reel, only where it clearly helps. Never invent numbers. Lines must be <= 24 characters each.\n"
                  'Output JSON: {"inserts":[{"reel_id":"r02","shot_index":1,"style":"graph|dan-koe|minimalistic-graphics","spec":{...},"why":"..."}]}\n'
                  'graph spec: {"label":"<=32 chars","values":[...],"labels":["..."],"final":number,"prefix":"$","suffix":"%","decimals":0}. '
                  'dan-koe spec: {"lines":["...","..."]}. minimalistic-graphics spec: {"lines":["...","..."],"steps":4}.')
        user = json.dumps({"role": role, "org_context": org, "reels": [
            {"reel_id": v["id"], "title": v["title"], "scene_type": v.get("scene_type"),
             "shots": [{"shot_index": k, "narration": s.get("narration"), "visual": s.get("visual")} for k, s in enumerate(v["shots"])]}
            for v in videos]}, ensure_ascii=False)
        obj = llm.chat_json(f"S4b_inserts_{role}", system, user, tier="medium", max_tokens=2500)
        chosen = validate(obj, videos)
        for v in videos:
            v.pop("insert", None)
        for ins in chosen:
            v = next(x for x in videos if x["id"] == ins["reel_id"])
            v["insert"] = {k: ins[k] for k in ("style", "shot_index", "spec", "why")}
        mp.write_text(json.dumps(m, indent=2, ensure_ascii=False))
        return role, [(c["reel_id"], c["style"], c["shot_index"]) for c in chosen]

    files = [p for p in sorted(out_dir.glob("manifest_*.json")) if not roles or p.stem.split("_", 1)[1] in roles]
    with ThreadPoolExecutor(3) as ex:
        return dict(ex.map(one, files))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--org")
    a = ap.parse_args()
    print(run(a.out, Path(a.org).read_text() if a.org else None))
