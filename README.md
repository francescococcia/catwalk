# Le Chonk in London — Mistral Vibe Hackathon

> **Our project: DevTok × Vigil.** DevTok explains a PR as a 60-second video feed per role; Vigil proves the PR is safe (attacks a local copy, fixes, re-proves) and feeds its findings into DevTok's approval screen. Pitch: [PITCH.md](PITCH.md) · **Demo script (video + live): [DEMO.md](DEMO.md)** · DevTok: [devtok/README.md](devtok/README.md) (web app: `python devtok/pipeline/server.py --port 8770`, open http://127.0.0.1:8770/) · Tonk recorder: [tonk-recorder/README.md](tonk-recorder/README.md) (records what agents do into a Tonk space; `vigil install` gives its security role Vigil) · Real-world review: [reviews/mistral-vibe-pr140.md](reviews/mistral-vibe-pr140.md) · Video handoff: [handoff/max-video.md](handoff/max-video.md) · Vigil: below.
>
> **Windows notes:** run DevTok's server with `$env:PYTHONUTF8 = "1"` (otherwise it crashes writing `→`); DevTok's 3D video rendering needs the Mac (planning, scripts and quiz work on Windows).

## Vigil: try it (teammates start here)
Vigil is a security skill for Vibe that **proves before it speaks**. Rules spot a suspect, Ministral (local) explains it, the Detective agent attacks your own app to prove it, applies a fix, and attacks again to prove the fix works. A live cartoon page shows it all.

Needs: Node 22.5+, Python 3.12+, [uv](https://docs.astral.sh/uv/), optional [Ollama](https://ollama.com) for Ministral.

```powershell
# 1. the target app (terminal 1)
cd demo-app; npm install; npm run dev:3001
# 2. Ministral, local (one time; skip to run without it)
ollama pull ministral-3:3b
ollama create vigil -f harness/Modelfile
# 3. Vigil (terminal 2, repo root), then open http://127.0.0.1:8765/
uv run --project engine engine/run.py demo-app
```
- Add `--ask` to require an Approve click, `--no-narrate` to skip Ministral, and `--mode mistral` (with `MISTRAL_API_KEY` set) to use the hosted Large 4 agent.
- **Mistral Studio / Vibe Code Web:** `uv run --project engine agents serve engine` runs the Large 4 Detective on your laptop, registers it as the managed agent `vigil-detective` in your workspace, and prints a Vibe Code Web link (chat with it, e.g. "check the app") and a Studio debug link (its sessions and traces). Steps are logged to `engine/runs/serve-*.jsonl`. Fixes (`apply_fix`) ask for approval.
- After a FIXED run, reset the demo bug: `Copy-Item engine\fixtures\orders_id_route.ts.orig "demo-app\app\api\orders\[id]\route.ts" -Force`
- Tests: `python harness/test_vigil.py` · `uv run --project engine engine/test_engine.py` (needs demo-app running) · `uv run --project engine python engine/test_mistral_layer.py`
- How the parts fit: [engine/CONTRACT.md](engine/CONTRACT.md) · Vibe skill: [.vibe/skills/vigil/SKILL.md](.vibe/skills/vigil/SKILL.md) · scanner: [harness/README.md](harness/README.md)

---

One-day hackathon run by Mistral. **Saturday 21 November 2026, 08:30–20:30**, Fora – Chancery House, 53–64 Chancery Ln, London WC2A 1QS.

- Event page: https://luma.com/le-chonk-in-london
- Teams: 3–5 people (required), 18+ only
- Food: breakfast, lunch, dinner provided
- Community: Mistral Discord — https://discord.gg/mistralai

> Wi-Fi password and the Pro/credit redeem codes are in the organisers' Google Doc. They are deliberately **not** in this public repo.

## Schedule

| Time | What |
|---|---|
| 09:00 | Breakfast & kickoff |
| 12:00 | Lunch |
| 16:00 | Snacks |
| **18:00** | **Submissions due (project + demo video)** |
| 18:15 | Drinks & snacks, jury presentations |
| ~20:30 | Winners announced |

## Tracks & prizes

| Track | What | Prize |
|---|---|---|
| Track 01 — Anything goes | Build anything around **Mistral Vibe** and **Le Chonk (Mistral Large 4)**: agents, skills, MCPs, scheduled tasks. Ambitious, creative, impactful. | 1st £3,000 · 2nd £2,000 · 3rd £1,000 (Mistral credits) |
| Bonus 02 — Agents / Workflows | Use **Mistral Agents** and/or **Mistral Workflows**, and say where/how in the pitch. | +£500 credits to winners who do |
| Special 03 — Voxtral | Best use of **Voxtral** (speech) | £250 credits |

All attendees get 3 months of Mistral Pro + extra API credits (codes in the organisers' doc).

## Judging

1. Submit project + demo video by **18:00**.
2. Groups present live to a jury: **5 minutes, any format**.
3. Jury picks finalists → finalists present to everyone (5 min).
4. Jury: Mistral AI engineers, SWEs, TPMs, AI scientists.

**What to optimise for:** heavy, visible use of Large 4 + Vibe; mention Agents/Workflows explicitly (bonus); a Voxtral voice angle can stack a second prize; a demo video that works without you.

---

# The tech stack

## Le Chonk = Mistral Large 4

- **1.05T total params, 52B active** (granular MoE), natively multimodal (1.6B vision encoder), 1M token context.
- Open weights (Oct 29, 2026) — "Mistral Ecosystem Open-Weight" licence (modified MIT; MaaS providers need a commercial licence). HF: `mistralai/Mistral-Large-4-1T-A52B`.
- API model: `mistral-large-4`. Price: $0.70/M input, $0.07/M cached, $2.10/M output.
- Reasoning modes: Low / Medium / High (default).
- Supports: structured outputs, function calling, document QnA, chat completions (`/v1/chat/completions`, `/v1/conversations`), batch (`/v1/batch`), agents (`/v1/agents`), built-in tools.

## Mistral Vibe (the "unified agent")

- **Work mode**: web + mobile chat app, with Skills invoked via `@`.
- **Code mode**: coding agent in terminal (CLI), VS Code, **Vibe Desktop** (macOS/Windows), or cloud sessions.

### Vibe CLI setup

```bash
uv tool install mistral-vibe          # or: curl -LsSf https://mistral.ai/vibe/install.sh | bash
vibe                                  # run in project root
```

- On first run choose **"Use an API key"** — hackathon credits only work in Vibe via an API key from https://console.mistral.ai/api-keys.
- Re-run setup: `vibe --setup`. Update: `vibe update`.
- Config: `~/.vibe/config.toml`, project-level `.vibe/` (agents, skills, prompts, plugins, tools), `AGENTS.md` for project instructions, `.agents/skills/` (Agent Skills standard).
- Approval agents: `ask`, `accept-edits` (default), `smart-approve` (classifier model), `auto-approve`. Switch with `Shift+Tab` or `vibe --agent <name>`.
- Headless: `vibe --prompt "..." --auto-approve`.
- MCP tools are named `{server}_{tool}`; per-tool permissions in `config.toml` (`[tools.bash] allowlist/denylist`, etc.).

## Mistral Agents (Managed Agents + Agents SDK, public preview)

```python
# pip/uv: mistralai-agents ; env: MISTRAL_API_KEY
import asyncio
from mistralai import agents

@agents.tool
def get_order(order_id: str) -> dict:
    """Look up an order."""
    return {"id": order_id, "status": "shipped"}

agent = agents.Agent(
    model="mistral-large-4",
    tools=[get_order],
    connectors=[agents.connector("github")],                       # catalog connectors
    mcps={"deepwiki": agents.RemoteMCP(url="https://mcp.deepwiki.com/mcp")},  # your own MCP
)
print(asyncio.run(agent.run("Say hello")).text)
```

- Run modes: in-process (`agents.Agent(...)` / `agents chat`), self-hosted (`agents serve`), Mistral-managed (`agents deploy`).
- Sessions: `agent.start_session()`, `session.run(msg)`; results are `Completed` / `Failed` / `Blocked` / `Busy`. Deployed sessions last 24h (4h idle).
- Environments give a sandbox with bash + files; also approvals, skills, structured output, secrets, guardrails, subagents.
- Every turn is traced in Studio. Older API: `client.beta.agents`.
- Docs: https://docs.mistral.ai/studio/agents/overview

## Mistral Workflows (public preview)

Durable multi-step AI workflows, powered by **Temporal**: retries, pause for human signals, streaming, OpenTelemetry, cron/one-shot scheduling. Composes with Agents, Judges, Datasets. Triggers: Studio UI, `POST /v1/workflows/{name}/execute`, Vibe Work.

```bash
mistral workflows init my-workflow && cd my-workflow
mistral dev        # starts local worker (needs Python 3.12+, uv, Bun; CLI installer is macOS/Linux)
```

```python
import mistralai.workflows as workflows

@workflows.activity()
async def greet(name: str) -> str: ...

@workflows.workflow.define(name="hello-world")
class Hello:
    @workflows.workflow.entrypoint
    async def run(self, name: str): ...

# execute
from mistralai.client import Mistral
Mistral().workflows.execute_workflow(workflow_identifier="hello-world", input={"name": "Ada"}, wait_for_result=True)
```

Docs: https://docs.mistral.ai/studio/workflows/overview

## Voxtral 3 (speech, Oct 2026)

| Model | Use | Price |
|---|---|---|
| `voxtral-small-transcribe-3-0` | Flagship STT + diarization | $0.004/min |
| `voxtral-mini-transcribe-3-0` | Batch STT (4B) | $0.0035/min |
| `voxtral-mini-transcribe-realtime-3-0` | Realtime STT, <500ms, turn detection | $0.008/min |
| `voxtral-mini-tts-3-0` | TTS, streaming, voice cloning, `emotion`/`pacing`/`emphasis` | $13/M chars |

- STT: 50+ languages, context biasing (key terms, no fine-tuning). TTS: 35+ languages, 50+ dialects.
- **Voice agent SDK** (LiveKit-based): realtime STT → LLM (e.g. Mistral Small 4) with tools → TTS; SIP (phone) or WebRTC (browser). ~$0.04/min.
- https://mistral.ai/news/voxtral-3

## Ministral 3 (small/edge models)

Apache 2.0, text + vision, built for edge/on-device:

| Model | Notes |
|---|---|
| Ministral 3 3B | Tiny, efficient |
| Ministral 3 8B (`ministral-8b-2512`) | 256k context, ~$0.15/M tokens |
| Ministral 3 14B | Strongest of the three, text + vision |

Good for: local/offline agents, cheap classifiers/routers inside a bigger Large 4 pipeline, on-device demos (Vibe CLI supports offline local models).

**Deep dive (usage, tools, local running, security): [MINISTRAL.md](MINISTRAL.md)**

## Other current Mistral models

- **Mistral Small 4** — hybrid instruct/reasoning/coding (Apache 2.0); default LLM in the voice agent SDK.
- **Codestral 25.08** — code completion (FIM); **Codestral Embed** — code embeddings.
- **OCR 4.1 / OCR 3** — Document AI with bounding boxes.
- **Mistral Embed**, **Mistral Moderation 2**, **Shieldstral 1.0** (moderation), **Timestral 1.0** (time series).
- Deprecated: Devstral, Magistral, Pixtral, old Ministral (2410), Mistral Medium 3.x.

## Links

- Vibe docs: https://docs.mistral.ai/vibe
- Vibe Desktop: https://docs.mistral.ai/vibe/code/desktop/overview
- Agents: https://docs.mistral.ai/studio/agents/overview
- Workflows: https://docs.mistral.ai/studio/workflows/overview
- Models: https://docs.mistral.ai/getting-started/models/
- Studio console / API keys: https://console.mistral.ai
