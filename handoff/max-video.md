# Handoff → Max: DevTok video of mistral-vibe PR #140 (with Vigil's review)

Paste everything below the line into your Claude / Vibe session on the **Mac**.

---

You are on the team's Mac. Goal by **17:20**: a rendered DevTok feed (real video reels, Voxtral voice) of the PR
https://github.com/mistralai/mistral-vibe/pull/140 ("feat: add OpenTelemetry observability integration"), plus a
screen recording of it in the app, ending on the approval screen that shows Vigil's security review.

Repo: https://github.com/francescococcia/ministral (pull `main`). Read `devtok/README.md` (Run it) and
`reviews/mistral-vibe-pr140.md` (Vigil's review of this PR) first.

1. `git pull` (main has: DevTok planning on Mistral **Large 4**, the narrator voice on **Voxtral**, a fix for
   empty Large 4 replies on big PRs, the DevTok web app, Vigil's review of PR #140).
2. Environment (never paste keys into files or chat):
   ```bash
   export MISTRAL_API_KEY=...          # team key
   export DEVTOK_TTS=voxtral           # otherwise the kit's Kokoro voice wins
   export PYTHONUTF8=1
   export DEVTOK_KIT=/path/to/claude-animation-skills/kit   # node_modules + fonts symlinked as in the README
   ```
3. Start the job server: `python3 devtok/pipeline/server.py` (127.0.0.1:8765). If Vigil's live page also runs on
   this Mac, use `--port 8770` for DevTok instead.
4. Create the job **with a GitHub token** (the unauthenticated GitHub limit is nearly used up today):
   paste the PR link in the iOS app (token field), or
   `curl -s -X POST localhost:8765/api/jobs -H 'Content-Type: application/json' -H "X-GitHub-Token: $GITHUB_TOKEN" -d '{"pr_url":"https://github.com/mistralai/mistral-vibe/pull/140","roles":["technical_engineer","team_lead"]}'`
   Poll `GET /api/jobs/mistralai__mistral-vibe__140` until `render` is done (planning ~3-5 min on Large 4 for a big
   PR, rendering ~3-4 min).
5. Security in the verdict screen: the review has **no blocking findings** and one **medium privacy note** (user
   prompts exported as span attributes when tracing is on; off by default). Add it to the register so the app shows it:
   append a threat to `devtok/security/threats.json` titled "PR #140: prompts exported in telemetry spans
   (opt-in content capture missing)", severity medium, status open, source "vigil", where
   `vibe/core/observability/tracing.py`. Keep the JSON valid.
6. Record (QuickTime or the Simulator's record button), 60–90 s:
   feed (engineer reel 1–2) → quiz → **Vigil proved it** card → approval screen with the security checklist.
   Export as MP4 and send it to the video teammate by **17:25**.
7. If rendering fails: open the DevTok web app (`http://127.0.0.1:<port>/`), load the job (scripts and quiz are
   there even without video) and record that instead. Do not debug past 17:15.

Report back: the job id, whether videos rendered, the recording file, anything that broke.
