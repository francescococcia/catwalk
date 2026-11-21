# Demo script: DevTok × Vigil (+ Tonk recorder)

**One line:** *AI agents write PRs faster than humans can review them. Tonk remembers what every agent did and why, Vigil proves the change is safe (and fixes it), DevTok explains it to every person on the team in 60 seconds of video.*

Three teammates' pieces, one loop:

| Piece | Job in the story | Mistral inside |
|---|---|---|
| **Tonk recorder** (goblinoats) | Agents work in a shared Tonk space; hooks in Vibe record every change and decision. Roles (builder, **security**, …) coordinate through the space. The security role must use Vigil | Vibe hooks |
| **Vigil** | The security role: rules → **Ministral** explains → **Large 4 agent** attacks a local copy → fix → attack again → report (OWASP/NIST/ISO) | Vibe skill, Agents SDK + Studio, Large 4, Ministral, Voxtral |
| **DevTok** | Turns the PR into a video feed per role, quiz, approval screen with Vigil's checklist | Large 4 planning, Voxtral narrator |

---

## A. Demo video (target 2:30, record now, submit by 17:45)

| # | Time | On screen (what to record) | Voice-over (read this) |
|---|---|---|---|
| 1 | 0:00–0:15 | Title card "DevTok × Vigil" + a 3,000-line PR scrolling | "AI agents now write pull requests of thousands of lines. Nobody reads them. They get merged anyway." |
| 2 | 0:15–0:35 | Vibe: ask for an orders API; Vibe writes `app/api/orders/[id]/route.ts`; type `/vigil demo-app` | "Our team builds with Mistral Vibe. When the agent writes code, our Vigil skill kicks in by itself." |
| 3 | 0:35–1:05 | Live page `127.0.0.1:8765` (Voice on): Scout → **Ministral** explanation bubble | "Vigil's rules spot a suspect. Ministral, running locally on this laptop, explains it: anyone could read anyone's order." |
| 4 | 1:05–1:35 | Detective attack → **PROVEN**, Bob's secret in red; fix diff; re-attack **BLOCKED → FIXED** | "Vigil doesn't guess. Our Large 4 agent attacks a local copy of the app. Proven: Alice reads Bob's order. It writes the fix, attacks again, and the attack is blocked. Fixed, and proven fixed." |
| 5 | 1:35–1:50 | Mistral **Studio** session of `vigil-detective` (tool calls listed) | "It's a real Mistral Agent on Large 4: every step is traced in Studio, and anyone can chat with it in Vibe Code Web." |
| 6 | 1:50–2:15 | Max's DevTok recording: reels → quiz → **Vigil proved it** card → approval screen with the security checklist | "DevTok turns the same PR into a 60-second feed for each role, with a quiz, and Vigil's proof right on the approval screen." |
| 7 | 2:15–2:25 | `REPORT.md` scrolling: red team, blue team, OWASP / NIST / ISO table; `reviews/mistral-vibe-pr140.md` | "Every run ends in a report a security team can use. We even reviewed a real Mistral Vibe pull request with it." |
| 8 | 2:25–2:30 | End card: "Vibe lets 3 people ship like 30. We make sure the 3 still understand, and it's safe." + logos: Vibe · Large 4 · Ministral · Voxtral · Agents | (read the end card) |

**Recording commands (Windows, two terminals):**
```powershell
Copy-Item engine\fixtures\orders_id_route.ts.orig "demo-app\app\api\orders\[id]\route.ts" -Force
uv run --project engine engine/run.py demo-app --mode mistral     # open http://127.0.0.1:8765/ , tick Voice
```
Studio: `uv run --project engine agents serve engine` → open the printed Debug link (after the run, or in a second terminal).
Report: `python harness/report.py demo-app --out REPORT.md`.

---

## B. Live pitch (5:00)

| Time | Who | Say / do |
|---|---|---|
| 0:00 | Speaker 1 | **Hook:** "Raise your hand if you merged a PR this week that you didn't fully read." (pause) "Same. With Vibe, agents write more code than we can review. That's the problem we solved." |
| 0:30 | Speaker 1 | **What we built:** one sentence per piece: Tonk remembers, Vigil proves, DevTok explains. |
| 1:00 | Speaker 2 (laptop) | **Live:** `/vigil demo-app` in Vibe, or the backup: start the live run. Narrate Scout → Ministral → PROVEN → fix → BLOCKED → FIXED (~60 s with Large 4). |
| 2:15 | Speaker 2 | **Judge moment:** hand a judge Vibe Code Web: "Ask it: is this app safe?" The Large 4 agent answers live. (Skip if time is short.) |
| 3:00 | Speaker 3 | **DevTok:** play the 30-s recording: feed, quiz, approval screen with Vigil's checklist. |
| 3:40 | Speaker 3 | **Where we use Mistral** (slide, read it: this is the Agents bonus): Agents SDK + Studio (Vigil Detective on Large 4) · Large 4 in DevTok · Ministral local · Voxtral voices · Vibe skill + Vibe hooks. |
| 4:20 | Speaker 1 | **Why it matters + honest limits:** proof before alert means teams trust it; 2 attack types today, new ones are allowlist entries; approval in DevTok is simulated. |
| 4:45 | Speaker 1 | **Close:** "Vibe lets 3 people ship like 30. DevTok × Vigil makes sure those 3 still understand what they ship, and that it's safe." |

**Backups (have them open before you start):** the recorded video; a saved run (`engine/runs/*.jsonl`) to replay on the live page with "Load run"; the DevTok web app with the fixture feed (`http://127.0.0.1:8770/`).

## Pre-flight checklist (5 minutes before)
- [ ] demo-app running on :3001, demo bug reset (command above)
- [ ] `MISTRAL_API_KEY` set in the terminal (`[bool]$env:MISTRAL_API_KEY` → True)
- [ ] Ollama running (`ollama ps`), so the Ministral Scout answers fast (run one scan before the pitch to warm it up)
- [ ] Ports free: 8765 (Vigil), 8770 (DevTok)
- [ ] Laptop volume up for Voxtral; Wi-Fi tested (Large 4, Voxtral need it; Ministral doesn't)
