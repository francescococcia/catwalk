# DevTok — big PRs explained as a TikTok-style feed (handover)

A large, often agent-written pull request is turned into a role-specific series of short vertical videos with voice,
subtitles, a cartoon cat narrator and real code references. A short quiz follows every 2 videos (skippable), and a
final screen to approve or request changes (simulated, nothing is posted to GitHub).

Roles: `technical_engineer` (mechanism, code, "delete this line → what breaks"), `team_lead` (owners, blast radius,
review checks), `paying_manager` (what we pay, what users get, risk; numbers only from an org context file).

```
phone (SwiftUI app)  ──PR link + GitHub token──▶  pipeline/server.py  ──▶ GitHub REST (PR, commits, diff, repo tree)
        ▲                                               │
        │ manifests + /media/*.mp4                      ├─ pipeline/run.py     Mistral API: system map → storyboard → scripts
        └───────────────────────────────────────────────┤                      → quiz every 2 reels → approval summary
                                                        ├─ pipeline/inserts.py styled inserts (graph / tree / steps)
                                                        └─ renderer/build.py   Kokoro voice → word timings → three.js frames
                                                                               (headless Chrome) → ffmpeg → mp4
```

## What is in this folder
| Path | What |
|---|---|
| `pipeline/ingest.py` | Diff parser: files, hunks, post-change line numbers, symbols, secret redaction (no LLM) |
| `pipeline/run.py` | Stages S2–S7. Rule: the LLM only references ids we give it; code re-grounds every file:line from the diff |
| `pipeline/llm.py` | Stdlib Mistral client (JSON mode, retries, every prompt/response logged to `out/*/debug/`) |
| `pipeline/github.py` | Fetches a PR (+ repo tree and README for context beyond the diff) |
| `pipeline/server.py` | Job server for the app: `POST /api/jobs`, progress, manifests, `/media` with HTTP Range |
| `pipeline/inserts.py` | Picks 0–2 styled inserts per role from the claude-animation-skills catalogue |
| `pipeline/security.py` | Reads a Vigil `report.json` and maps it onto `security/threats.json` (see below) |
| `renderer/` | three.js "architecture tour" scene, cat narrator, code cards, skill-style reels; `build.py` renders a run |
| `app/` | SwiftUI iOS app (xcodegen `project.yml`): feed, code sheet, system map, quiz, verdict, debug texts |
| `examples/org_context.example.md` | Format of the optional org context (teams, monthly spend). Numbers are invented |
| `SECURITY_REVIEW_REQUEST.md` | **What we need from the Vigil team** |
| `security/threats.json` | Our threat register (machine-readable), statuses we will update after your report |

Not included on purpose: generated videos/manifests, job caches, prompt logs, research notes, API keys.

## Run it
Needs Python 3.12, Node 18+, ffmpeg, Xcode 26 + xcodegen, and the kit from
[claude-animation-skills](https://github.com/artemnovitckii/claude-animation-skills) (`./install.sh --voice` gives
three.js/Playwright and the free Kokoro voice + Parakeet word timings, ~1 GB once).

```bash
export DEVTOK_KIT=/path/to/claude-animation-skills/kit
ln -s "$DEVTOK_KIT/node_modules" devtok/renderer/node_modules
ln -s "$DEVTOK_KIT/fonts" devtok/renderer/fonts
export MISTRAL_API_KEY=...                         # or VOXTRAL_API_KEY in a repo-root .env (git-ignored)

# one PR end to end, from the command line
python3 devtok/pipeline/run.py --pr <dir with pr.json + pr.diff> --out devtok/out/my-pr \
        [--roles technical_engineer] [--styles minimalistic-graphics,breakdown,graph]
python3 devtok/renderer/build.py --out devtok/out/my-pr --prefix mypr --media devtok/media

# or the server the app talks to (paste a PR link in the app)
python3 devtok/pipeline/server.py                  # 127.0.0.1:8765 (simulator); --host 0.0.0.0 for a phone on LAN

# iOS app
cd devtok/app && xcodegen generate && open DevTok.xcodeproj   # set your own signing team in Xcode
```

Measured on an M-series Mac: pipeline ~35–50 s and ~90–160k tokens per PR (all 3 roles); rendering ~25–40 s per
20 s reel, ~3.5 min for 14 reels with 3 parallel Chrome workers.

## Status / known gaps
- Approval is simulated (animation only). Quizzes and checklist are advisory and never block approval.
- GitHub sign-in in the app is a pasted personal access token (Keychain). Production needs the OAuth device flow.
- `$` figures for managers are only as good as the org context; the model can still do loose arithmetic on them.
- **Security review pending** → `SECURITY_REVIEW_REQUEST.md`.

## Credits
`renderer/src/{cat,anim,textures}.js` are derived from claude-animation-skills (MIT, (c) 2026 Artem Novitckii).
Skill-style reels call that kit's `skills/*/build.py` at render time.
