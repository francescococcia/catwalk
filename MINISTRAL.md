# Ministral 3 — models, tools, and security

Practical guide for the hackathon. Sources: docs.mistral.ai, mistral.ai/news/mistral-3, Hugging Face model cards (read 2026-11-21). Gaps are marked **(unverified)**.

## 1. What Ministral 3 is

Small, **dense**, **open (Apache 2.0)** models with **text + vision**, made for edge/local use. Released Dec 2, 2025 (v25.12). Each size comes in **Base**, **Instruct** and **Reasoning** variants.

| Model | API ID (alias) | Context | Price (per M tokens) | Notes |
|---|---|---|---|---|
| Ministral 3 3B | `ministral-3b-2512` (`ministral-3b-latest`) | 256k | $0.10 | Tiny, edge |
| Ministral 3 8B | `ministral-8b-2512` (`ministral-8b-latest`) | 256k | $0.15 in / $0.15 out | 8.4B LM + 0.4B vision; fits ~12 GB VRAM in FP8 |
| Ministral 3 14B | `ministral-14b-2512` (`ministral-14b-latest`) | 256k | $0.20 | ≈ Mistral Small 3.2 24B quality |

All three support: function calling, structured outputs / JSON, document QnA, prefix, chat completions, conversations, batch.

**Benchmarks (vendor, HF card)** — Reasoning variants, AIME25 / GPQA Diamond / LiveCodeBench:
14B 0.850 / 0.712 / 0.646 · 8B 0.787 / 0.668 / 0.616 · 3B 0.721 / 0.534 / 0.548.

**Hugging Face** (`mistralai/…`): `Ministral-3-{3B,8B,14B}-{Base,Instruct,Reasoning}-2512`. Instruct checkpoints ship in FP8.

**Tips from the model card:** temperature **< 0.1** for production, keep the tool list **small**, keep images near 1:1.

### When to pick Ministral instead of Large 4
- Needs to run **locally / offline / on-device** (laptop, Jetson, RTX PC).
- **Cheap, fast, high-volume** steps: routing, classification, extraction, PII redaction, guard checks.
- Data that **must not leave the machine** (privacy-first demos).
- Use Large 4 for the hard reasoning; Ministral for the many small steps around it.

## 2. Using it via the API

```bash
uv add mistralai     # or: pip install mistralai
export MISTRAL_API_KEY=...   # console.mistral.ai/api-keys
```

### Basic chat (with an image)
```python
import os
from mistralai.client import Mistral

client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
r = client.chat.complete(
    model="ministral-8b-latest",
    temperature=0.1,
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "What is in this screenshot?"},
        {"type": "image_url", "image_url": "https://example.com/shot.png"},
    ]}],
)
print(r.choices[0].message.content)
```
> The image message format follows Mistral's standard vision API **(unverified for Ministral 3 specifically)**.

### Function calling (tools) — the loop
```python
import json

def get_order_status(order_id: str) -> str:
    return json.dumps({"order_id": order_id, "status": "shipped"})   # tools must return a string

TOOLS = {"get_order_status": get_order_status}
tools = [{
    "type": "function",
    "function": {
        "name": "get_order_status",
        "description": "Look up the shipping status of an order",
        "parameters": {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    },
}]

messages = [{"role": "user", "content": "Where is order A123?"}]
resp = client.chat.complete(model="ministral-8b-latest", messages=messages, tools=tools,
                            tool_choice="auto", temperature=0.1)
messages.append(resp.choices[0].message)

while resp.choices[0].message.tool_calls:
    for call in resp.choices[0].message.tool_calls:
        fn = TOOLS[call.function.name]                       # only call tools you defined
        result = fn(**json.loads(call.function.arguments))
        messages.append({"role": "tool", "name": call.function.name,
                         "content": result, "tool_call_id": call.id})
    resp = client.chat.complete(model="ministral-8b-latest", messages=messages, tools=tools,
                                temperature=0.1)
    messages.append(resp.choices[0].message)

print(resp.choices[0].message.content)
```
- `tool_choice`: `"auto"` (default) · `"any"` (must call a tool) · `"none"`.
- `parallel_tool_calls`: `True` (default) or `False` (one call at a time).

### Structured output
```python
# JSON mode
client.chat.complete(model="ministral-8b-latest", messages=msgs,
                     response_format={"type": "json_object"})

# Pydantic schema
from pydantic import BaseModel
class Verdict(BaseModel):
    label: str
    confidence: float
    reason: str

r = client.chat.parse(model="ministral-8b-latest", messages=msgs,
                      response_format=Verdict, temperature=0)
print(r.choices[0].message.content)   # JSON matching Verdict
```

### Inside Mistral Agents (bonus track)
The Agents SDK takes any model name, so Ministral can power a cheap sub-agent while Large 4 is the main agent:
```python
from mistralai import agents
triage = agents.Agent(model="ministral-8b-latest", tools=[...])   # model swap (unverified that all SDK features work on Ministral)
```

## 3. Running it locally

### vLLM (official, from the HF card)
```bash
pip install --upgrade vllm            # needs vllm >= 0.12, mistral_common >= 1.8.6
vllm serve mistralai/Ministral-3-8B-Instruct-2512 \
  --tokenizer_mode mistral --config_format mistral --load_format mistral \
  --enable-auto-tool-choice --tool-call-parser mistral
```
Then use any OpenAI client:
```python
from openai import OpenAI
c = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")
model = c.models.list().data[0].id
c.chat.completions.create(model=model, messages=[{"role": "user", "content": "hi"}], tools=tools)
```
`--enable-auto-tool-choice --tool-call-parser mistral` are **required** for tools.

### Ollama / llama.cpp / LM Studio
Supported runtimes for Mistral models in general; no official Ministral 3 tag or GGUF was in the docs we read **(unverified)** — check `ollama search ministral` or Hugging Face for GGUF builds.

### Hook Vibe CLI to a local Ministral
Vibe works with any OpenAI-compatible server. In `~/.vibe/config.toml`:
```toml
active_model = "ministral-local"      # must be above the first [[...]] table

[[providers]]
name = "local"
api_base = "http://localhost:8000/v1"
api_style = "openai"
backend = "generic"

[[models]]
name = "mistralai/Ministral-3-8B-Instruct-2512"   # whatever your server reports
provider = "local"
alias = "ministral-local"

enable_telemetry = false        # fully offline
enable_update_checks = false
```
Switch models in-session with `/model`. Mistral recommends Devstral Small 2 or Mistral Small 4 for local *coding*; Ministral is better as a fast helper than as the main coding agent.

---

## 4. Security — two angles

### A. Securing what you build

**1. Input moderation / jailbreak guard (API)**
```python
r = client.classifiers.moderate(model="mistral-moderation-2603", inputs=["user text"])
print(r.results)    # per-category scores
```
Categories: sexual, hate_and_discrimination, violence_and_threats, dangerous, criminal, selfharm, health, financial, law, **pii**, **jailbreaking**.

Or block automatically in the request with a guardrail:
```python
client.chat.complete(
    model="ministral-8b-latest", messages=msgs,
    guardrails=[{"type": "moderation_llm_v2",
                 "custom_category_thresholds": {"jailbreaking": 0.5},
                 "action": "block", "block_on_error": True}],
)   # blocked -> HTTP 403 "Content blocked by guardrail"
```
> The `guardrails` field shape is from the docs' JSON examples; check the exact Python form before relying on it.

**2. Agents SDK controls** (Managed Agents)
```python
agent = agents.Agent(
    model="mistral-large-4",
    tools=[open_case, read_logs],
    permission_policy=agents.PermissionPolicy(default="deny", rules=[
        agents.PermissionRule(tools=["client.read_logs"], decision="allow"),
        agents.PermissionRule(tools=["client.open_case"], decision="ask"),   # human approval
    ]),
    environment=agents.MistralSandbox(access="files"),  # sandbox, no bash
    secrets={"API_KEY": agents.MistralSecret.workspace("api-key", worker_env=True)},
)
```
- **Approvals**: `allow` / `ask` / `deny` per tool, answered via `on_approval=` → `agents.AllowApproval()` / `agents.DenyApproval()`. Unanswered after 1h means denied.
- **Guardrail hooks**: subclass `agents.Hook`, implement `async def pre_tool_call(self, ctx, call)`, `return agents.skip("reason")` to block.
- **Sandboxes**: `MistralSandbox`, `LocalDockerSandbox`, `BashkitSandbox` (weak isolation), `DangerousLocalSandbox` (none). **Network is `Network.none()` by default**; allowlist hosts/CIDRs only when needed.
- **Secrets**: `MistralSecret` from the workspace Secrets Manager (write-only, audited). Use `header_bindings` (e.g. `GitHubBinding`) so the sandbox never sees tokens.
- Mark read-only tools with `@agents.tool(annotations=agents.ToolAnnotations(read_only_hint=True))`.

**3. Vibe CLI permissions** (`~/.vibe/config.toml` or `.vibe/config.toml`)
```toml
[tools.bash]
permission = "ask"
allowlist = ["git status", "pytest"]
denylist  = ["rm -rf", "curl"]

[tools.read_file]
outside_workdir = "deny"
```
- Use the `ask` or `accept-edits` agent; `smart-approve` is "a classifier, not a sandbox".
- Project `.vibe/` config (skills, MCP servers) only loads in **trusted folders** — review it before trusting a cloned repo.
- `.env` reads/edits always prompt unless allowlisted.
- Headless `vibe --prompt` denies risky calls unless you pass `--auto-approve`; don't use that on untrusted repos.

**4. Prompt-injection hygiene** (general practice; Mistral has no dedicated page)
- Treat tool output, web pages, files and transcripts as **data**, never instructions.
- Least privilege: smallest tool set, `default="deny"`, human approval on anything that writes/sends/pays.
- Validate tool arguments in code (allowlists, types), and only dispatch to functions you defined.
- Run a cheap Ministral or moderation check on inputs *before* they reach the main agent.
- Never put secrets in prompts; use secrets/bindings.

Large 4 is vendor-reported at **97.1%** on the B3 Agent Security benchmark and a **96.6%** refusal rate on malicious cyber prompts, while still doing defensive security work (51% on the AA Cyber Index).

### B. Using Ministral *for* security (hackathon-friendly)

Because it is small, open and runs locally, Ministral fits security tooling where data cannot leave the box:

| Idea | How |
|---|---|
| **Local PII/secret redactor** | Ministral 3B/8B + structured output strips names, keys, emails from logs or prompts before anything is sent to Large 4 or the cloud. |
| **LLM firewall / router** | Ministral classifies each incoming prompt (benign / injection / off-topic) with a `Verdict` schema; only clean ones reach the main agent. Combine with the moderation API. |
| **Log & alert triage** | Stream SIEM/auth logs to a local Ministral; it labels severity and summarises, Large 4 investigates only the top alerts. A Workflow schedules it and asks a human before any block action. |
| **Phishing / scam checker** | Vision lets it read email screenshots; Voxtral can transcribe suspicious voicemails/calls for the same check. |
| **Secure code review helper** | Vibe + a skill that runs a local Ministral over diffs to flag hardcoded secrets, injection, unsafe deserialization; Large 4 writes the fix. |
| **Config auditor** | Feed Dockerfiles, IAM policies, nginx configs (256k context fits a lot); output structured findings. |

Keep it defensive: Mistral's models are tuned to refuse attacking live targets, and judges will look for safe design (approvals, sandboxing, least privilege).

## Links
- Ministral 3 announcement: https://mistral.ai/news/mistral-3
- Model pages: https://docs.mistral.ai/models/ministral-3-8b-25-12 (also `-3b-`, `-14b-`)
- Function calling: https://docs.mistral.ai/capabilities/function_calling/
- Structured output: https://docs.mistral.ai/capabilities/structured_output/json_mode/
- HF collection: https://huggingface.co/collections/mistralai/ministral-3
- Vibe offline models: https://docs.mistral.ai/vibe/code/cli/offline-models
- Moderation & guardrails: https://docs.mistral.ai/studio/safety-moderation
- Agents approvals / guardrails / sandbox / secrets: https://docs.mistral.ai/studio/agents/
- Vibe permissions: https://docs.mistral.ai/vibe/code/safety-approvals-permissions
