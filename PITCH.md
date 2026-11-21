# DevTok × Vigil: ship AI-written PRs you understand and can trust

## One line
**AI writes pull requests faster than humans can review them. DevTok makes every PR understandable in 60 seconds of video; Vigil proves it is safe, and fixes it if it is not.**

## The problem (say it with the room)
- Teams using Vibe merge PRs of thousands of lines that **nobody reads**.
- Text reviews get skimmed. Security tools flag 50 "maybe" issues, so people ignore them.
- Result: code nobody understands, holes nobody notices.

## The product
| | What it does | Built on |
|---|---|---|
| **DevTok** | Turns a PR into a vertical video feed **per role** (engineer, team lead, manager), with a quiz and an approval screen | Mistral **Large 4** (system map, storyboard, approval summary), 3D renderer, iOS app |
| **Vigil** | Finds suspects, **attacks a local copy of the app to prove them**, applies a fix, **attacks again to prove the fix**, then writes a full report (OWASP / NIST / ISO 27001) | Vibe skill, **Large 4 as a Mistral Agent** (Studio), **Ministral** local, **Voxtral** voices |
| **Together** | Vigil's findings land in DevTok's threat register and on its **approval screen**: you approve a PR you understood *and* that was proven safe | `devtok/pipeline/security.py` reads Vigil's `report.json` |

## Demo (5 minutes)
1. **Hook (20 s):** "Raise your hand if you merged a PR this week you didn't fully read."
2. **Vibe writes code (40 s):** in Vibe, ask for an orders API. Vibe ships it. `/vigil` fires.
3. **Vigil proves it (90 s, live page + voices):** Ministral Scout explains the suspect → Large 4 Detective attacks → **Alice reads Bob's secret** → Large 4 writes the fix → attacks again → **BLOCKED → FIXED**. Show the session in **Mistral Studio**.
4. **DevTok explains it (90 s, iPhone simulator recording):** the same PR as a 60-second feed for the engineer and the manager, the quiz, then the approval screen **with Vigil's security checklist**.
5. **Report (20 s):** the generated report: red team, blue team, OWASP / NIST / ISO mapping.
6. **Close (20 s):** "Vibe lets 3 people ship like 30. DevTok × Vigil makes sure the 3 still understand what they ship, and that it's safe."

## Where we use Mistral (say this out loud: the Agents bonus asks for it)
- **Mistral Agents:** the Vigil Detective is an `agents.Agent` on **Large 4** with 4 tools, deny-by-default permissions and an approval rule for fixes; served with `agents serve`, visible in **Studio** and chat-able in **Vibe Code Web**.
- **Large 4 (Le Chonk):** Vigil's Detective, and DevTok's planning stages.
- **Ministral 3 (local, Ollama):** Vigil's Scout and narrator: private code never leaves the laptop.
- **Voxtral:** Vigil's character voices (DevTok's voice is the next swap).
- **Vibe:** the `/vigil` skill (`.vibe/skills/vigil`).

## Honest limits (if asked)
- Vigil proves 2 attack types today (reading another user's record; reading without login). New attacks are entries in an allowlist.
- Approval in DevTok is simulated; nothing is posted to GitHub.
- Mappings to OWASP / NIST / ISO are guidance, not a certification.
