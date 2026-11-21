# Vigil engine: contract between the parts

The single source of truth for how the pieces talk. Change it only together with every part it touches.

## Flow
```
vigil_scan (harness rules) --SUSPECT--> Detective (offline planner, or hosted Large 4 agent)
   -> read_file -> run_proof (allowlisted attack vs VIGIL_TARGET_URL) -> PROVEN?
   -> propose fix -> GATE (human clicks Approve on the live page) -> apply_fix
   -> run_proof again -> BLOCKED = FIXED, still PROVEN = automatic rollback
every step -> event -> live page (SSE) + optional Ministral narration + Voxtral voice
```

## Command
```
uv run --project engine engine/run.py <app_path> [--target http://localhost:3001] [--mode offline|mistral] [--port 8765] [--no-narrate]
```
- `<app_path>`: the app to check, e.g. `demo-app`. `apply_fix` can only write inside it.
- `--target` is optional: it only overrides the address from the app's target profile (below) and must stay loopback. Without it, the profile's `target` is used.
- `--mode offline` (default): scripted planner, no Mistral account needed. `--mode mistral`: hosted Large 4 agent via `engine/mistral_agent.py`.
- Prints `Open http://127.0.0.1:8765/` and serves the live page. Binds to **127.0.0.1 only**.

## Target profile (`.vigil/target.json` in the app root) — what makes the engine work on any repo
One JSON file per repo; attacks read address, login route, test users, their records and the routes to test **from this file**, never from code or the model:
```json
{
  "target": "http://localhost:3001",
  "login": {"path": "/api/login", "username_field": "username", "password_field": "password", "session_cookie": "vigil_session"},
  "users": [{"name": "alice", "password": "alice123", "records": ["ord_a1", "ord_a2"]},
            {"name": "bob",   "password": "bob123",   "records": ["ord_b1", "ord_b2"]}],
  "routes": {"record": "/api/orders/{id}"},
  "record_id_pattern": "^ord_[a-z0-9]{1,16}$",
  "secret_field": "secret_note"
}
```
- `engine/profile.py` `load_profile(app_path, target_override=None)` validates it and raises `ValueError` when unsafe. If the file is missing, the built-in demo profile is used (current behaviour preserved).
- **Safety:** `target` must be loopback (localhost / 127.0.0.0/8 / ::1) — enforced again in `attacks._target`, so attacks only ever go to the profile's local address. Routes must be absolute paths with no scheme/`..` and `routes.record` must contain `{id}`. Passwords exist **only** in this file: `attacks.validate` rejects credential-looking param keys, and `read_file`/`vigil_scan`/`apply_fix` deny `.vigil/` entirely, so no model can read or write them. `profile.sanitized()` (no passwords) is the only profile shape exposed to a hosted model, inside the `vigil_scan` result as `"profile"`.

## Tools (`engine/tools.py`, plain Python, stdlib only)
All return JSON-serialisable dicts and **never raise** to the caller: errors come back as `{"error": "..."}`.

| Tool | Signature | Returns |
|---|---|---|
| `vigil_scan` | `vigil_scan(path: str) -> dict` | `{"result": "PASS"\|"SUSPECT"\|"BLOCK", "tree": [relative file paths], "findings": [{rule,title,severity,level,attack,file,line,match,fix}], "profile": sanitized target profile (no passwords)}`. Runs `harness/vigil.py` rules in-process (no model). |
| `read_file` | `read_file(path: str) -> dict` | `{"path", "content"}`: the whole file, secret values masked as `***`. Path is relative to `<app_path>`. Denied: anything resolving outside `<app_path>`, `.env*`, `.vigil/`, `data/`, `node_modules/`, `.next/`, anything matched by the app's `.gitignore`, files > 200 KB. |
| `run_proof` | `run_proof(attack: str, params: dict) -> dict` | `{"status": "PROVEN"\|"BLOCKED"\|"ERROR", "attack", "params", "evidence": {"request", "status_code", "body_redacted"}, "control": {"ok": bool, "detail"}, "evidence_local": {"body"}}`. See allowlist. |
| `apply_fix` | `apply_fix(file: str, new_content: str) -> dict` | `{"applied": true, "file", "backup_id"}`. Called **only after the gate approved**. Keeps the original bytes in memory (demo-app is untracked, so git cannot roll back). `rollback(backup_id) -> dict` restores them. |

### Attack allowlist (`engine/attacks.py`)
The planner may only pick an id below. Params are names/ids only — `attacks.validate` rejects credential-looking keys and any user/record the profile does not declare. No shell, no other hosts.

| id | params (validated against the profile) | What it does |
|---|---|---|
| `idor_read` | `attacker` is a profile user with own records; `victim_order` matches the profile's `record_id_pattern` and is another profile user's record | Log in as attacker (password from the profile file, in code), GET `routes.record` with the victim id. PROVEN if the body's `id` equals `victim_order`. **Positive control:** the attacker can still read one of their own records (otherwise a fix that breaks the route would look "fixed"). |
| `unauth_read` | `record` matches the pattern and is one of the profile users' records | GET `routes.record` with the record id **without logging in at all** (no cookie). PROVEN if the record is served anonymously = missing authentication. Control: a logged-in owner can still read their own record. |

Rules for `run_proof`:
- Target is the profile's `target` (`--target`/`VIGIL_TARGET_URL` only override it, loopback enforced); every request is checked against its scheme/host/port, the same guard as `engine/proof/attack.py`.
- App unreachable or login failing is **`ERROR`, never `BLOCKED`**: a dead server must not read as "fix proven".
- After a fix, re-proof retries for up to ~6 s while `next dev` hot-reloads.
- `evidence.body_redacted` (sent to the hosted agent) truncates/masks the profile's `secret_field`; the full body stays in `evidence_local` (shown only on the local page).
- Passwords come only from `.vigil/target.json`, never from the model or from params.

## The approval gate (`engine/run.py`)
`gate.request(kind="apply_fix", file, new_content, diff, reason) -> bool` stores the patch **server-side** under a new `approval_id`, emits `fix_proposed`, and blocks until `POST /approve` answers. The browser only sends `{approval_id, decision}`, never patch content. The offline planner and the Mistral adapter (`on_approval`) both go through this same gate. Unanswered after 10 min = deny.
**Default is auto-apply** (team decision): the gate emits `fix_proposed` with `auto: true`, waits `VIGIL_AUTO_PAUSE` (4 s) so the diff is visible, then answers allow itself (`approval.by = "the agent (auto-apply)"`). Safety then rests on the re-proof and automatic rollback. `run.py --ask` restores the human click.

## HTTP (run.py, 127.0.0.1)
| Route | |
|---|---|
| `GET /` | serves `harness/viewer/live.html` |
| `GET /events` | Server-Sent Events, `data: <event JSON>`; replays all past events to a newly connected page |
| `POST /approve` | body `{"approval_id": str, "decision": "allow"\|"deny"}` -> `{"ok": true}`; unknown id -> 404 |
| `GET /tts?text=...&character=...` | `audio/mpeg` from `engine/voxtral.py` when `MISTRAL_API_KEY` is set; otherwise `503` (the page then uses browser speech) |
| `GET /run.jsonl` | the full event log of this run (also saved to `engine/runs/<timestamp>.jsonl` for the offline backup replay) |

## Events (one JSON object each)
Common fields: `seq` (int, 1..n), `ts` (ISO time), `type`, `character` (`scout`\|`detective`\|`mechanic`\|`gatekeeper`), `text` (a ready-to-show templated line, plain English, no secrets).

| type | character | extra fields |
|---|---|---|
| `run_started` | scout | `app`, `target`, `mode` |
| `scan_done` | scout | `result`, `findings` |
| `thinking` | detective | (text only: the planner's reasoning) |
| `tool_call` | by tool | `tool`, `args` |
| `tool_result` | by tool | `tool`, `summary` |
| `proof` | detective | `status`, `attack`, `params`, `evidence`, `evidence_local`, `control` |
| `fix_proposed` | mechanic | `approval_id`, `file`, `diff` (unified), `reason` |
| `approval` | gatekeeper | `approval_id`, `decision` |
| `fix_applied` | mechanic | `file` |
| `rollback` | mechanic | `file`, `reason` |
| `narration` | any | `for_seq`, `line`: a Ministral-written line for event `for_seq`, arriving later |
| `explanation` | scout | `for_seq` (the scan_done), `file`, `rule`, `agrees`, `confidence`, `fix`: Ministral Scout's explanation of one suspect, via `harness/vigil.py` `ask_model` on local Ollama (`vigil` model); arrives later, never changes a verdict |
| `verdict` | gatekeeper | `result`: `PASS`\|`FIXED`\|`PROVEN`\|`BLOCK`\|`ERROR` |
| `error` | gatekeeper | `message` |
| `run_finished` | gatekeeper | |

Tool -> character: `vigil_scan` scout · `read_file`/`run_proof` detective · `apply_fix`/`rollback` mechanic.

## Models
- **Ministral 3B (local Ollama)**: `harness/vigil.py` explanations; `engine/narrator.py` `narrate(event: dict) -> dict | None` returns `{"character", "line"}` (<=20 words). Slow (~25 s on a 4 GB GPU), so it never blocks the run: the page shows `text` first and swaps in the `narration` line when it arrives.
- **Large 4 (hosted, `--mode mistral`)**: `engine/mistral_agent.py`, the Detective. Same four tools as client tools, `PermissionPolicy(default="deny")`, `apply_fix` = ask (routed to the gate), GitHub connector. Untested until a `MISTRAL_API_KEY` exists.
- **Voxtral TTS**: `engine/voxtral.py` `synthesize(text: str, character: str) -> bytes` (mp3), one voice per character.

## File ownership (parallel build)
| Part | Owns (creates/edits) | Must not touch |
|---|---|---|
| Engine core | `engine/profile.py`, `engine/tools.py`, `engine/attacks.py`, `engine/planner.py`, `engine/run.py`, `engine/test_engine.py`, `engine/runs/`, `<app>/.vigil/target.json` | `harness/`, `engine/proof/attack.py`, `engine/pyproject.toml` |
| Live page | `harness/viewer/live.html` | everything else (`index.html` stays the file replay) |
| Mistral layer | `engine/mistral_agent.py`, `engine/voxtral.py`, `engine/narrator.py`, `engine/test_mistral_layer.py`, `engine/pyproject.toml`, `engine/uv.lock` | the other parts' files |

`demo-app/` source is never edited by hand. Only `apply_fix` writes there, at runtime, and every test restores the original file byte-for-byte.
