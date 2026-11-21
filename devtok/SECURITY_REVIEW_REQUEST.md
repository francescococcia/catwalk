# Security review request → Vigil team

**From:** DevTok (PR explainer) · **To:** Vigil · **Scope:** this `devtok/` folder

We would like a Vigil security report on DevTok before we demo it on real (possibly private) repositories. We will
feed your report into our pipeline (`pipeline/security.py`), track every finding against our threat register
(`security/threats.json`), and reply with what we fixed and how we proved it.

## What we need from you
1. **Static scan** of the folder, rules + model explanations, as both files:
   `python harness/vigil.py scan devtok --json devtok/security/vigil-report.json` and the markdown report
   (`harness/report.py`), saved next to it as `devtok/security/vigil-report.md`.
2. **Red-team where it applies.** DevTok has no users or login, so the IDOR attacks do not map one to one.
   The live surface is the job server (`python3 devtok/pipeline/server.py`, loopback `127.0.0.1:8765`):
   - `POST /api/jobs {pr_url}` (+ header `X-GitHub-Token`), `GET /api/jobs[/<id>[/manifest|explain/<role>]]`, `GET /media/<file>`.
   - Please try at least: path traversal on `/media`, reading another job's cached manifests, triggering jobs without
     any credential, oversized/malformed PR links, and prompt injection through a PR body/diff (see T3).
3. **Mapping.** For each finding, if you can, add `"devtok_threat": "T<n>"` (ids below). Unmapped findings are fine;
   we will open new ids for them.
4. Anything you see that is not in our list.

## Our own threat register (pre-review)
Severity is our guess; please correct it. Statuses live in `security/threats.json`.

| Id | Threat | Where | Our severity | Current mitigation |
|---|---|---|---|---|
| T1 | GitHub token exposure | app → server header `X-GitHub-Token`; `pipeline/github.py` | High | Keychain on device; server never writes or logs it (request line only). Not encrypted in transit (see T9) |
| T2 | Unauthenticated job server: anyone who can reach it can start jobs (spend Mistral credit) and read cached results, including private-repo PR text | `pipeline/server.py` | High | Binds to loopback by default; `--host 0.0.0.0` is opt-in. No auth, no per-user isolation |
| T3 | Prompt injection via PR content: the body, diff, commit messages and README go into LLM prompts and could steer narration, quiz answers or the "AI suggests: approve" line | `pipeline/run.py`, `inserts.py` | High | Only ids we hand out are accepted; code re-grounds file:line; quiz answers are shuffled in code. Nothing filters instructions inside PR text; the verdict suggestion is still model text |
| T4 | Secrets in diffs sent to third parties (Mistral API) | `pipeline/ingest.py` (`redact`) | Medium | One regex for `api_key/secret/token/password = ...`; misses many formats (PEM, JWT, cloud keys) |
| T5 | Data retention: PR text, full prompts and manifests are cached on disk with no expiry | `storage/jobs/*`, `out/*/debug/` | Medium | Folders are git-ignored; no TTL or delete endpoint |
| T6 | Path traversal on file serving | `server.py /media`, `renderer/render.mjs` local server | Medium | `/media` rejects `/`, `\` and leading dots; the renderer's loopback server joins request paths without a check |
| T7 | HTML/script injection into the renderer page from LLM text | `renderer/src/main.js` overlays | Medium | Text is escaped before `innerHTML`; labels are drawn on canvas |
| T8 | Subprocess calls with model-produced data (skill specs, TTS text) | `renderer/build.py` | Low | No shell; specs are written as JSON files; argv lists only |
| T9 | Cleartext transport: the app talks HTTP to the server (ATS `NSAllowsArbitraryLoads`), so the token crosses Wi-Fi in clear when used on a LAN | `app/DevTok/Info.plist`, `Network.swift` | High (LAN) | Intended for loopback / simulator only |
| T10 | SSRF through the PR link | `pipeline/github.py` | Low | Only `api.github.com` is called; owner/repo/number parsed by regex |
| T11 | Supply chain: models and packages downloaded without hash pinning | kit setup (Kokoro, Parakeet, Playwright, three.js) | Medium | Versions pinned in the kit's `package.json`; model files not hash-checked |
| T12 | Resource exhaustion: no size cap on diffs, each job spawns 3 headless Chrome renders | `server.py`, `build.py` | Medium | Prompt size is capped (70 files); no diff byte cap, no job queue limit |
| T13 | Approval integrity: when approval becomes real, a fooled model or a skipped quiz must not approve on its own | app verdict screen | Medium (future) | Today approval is a human tap and only an animation; the AI suggestion is advisory |

## How we will integrate your report
- `python3 devtok/pipeline/security.py devtok/security/vigil-report.json` merges your findings into
  `security/threats.json`: mapped ones attach to their T-id, unmapped ones become new T-ids. Every finding keeps its
  `rule`, `severity`, `level`, `file:line`, `standards` and your `fix` text.
- The pipeline then shows them in the app: a security checklist on the verdict screen (and, for engineers, a reel).
- When we fix something, the status moves `open → mitigated → verified`. We want "verified" to mean your rule or
  attack no longer fires: we will re-run your exact command and attach the before/after output.
- We will send back a short reply: threat id, what changed, commit, and the re-run result.

Contact: the DevTok team at the hackathon table. Thanks!
