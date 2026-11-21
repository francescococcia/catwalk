Build a one-page promotional site for PRODUCT_NAME = "Vigil" (swap this one name
everywhere if the product is renamed). Vigil is a security skill for Mistral Vibe
that "proves before it speaks". Hackathon project from "Le Chonk in London"
(Mistral Vibe hackathon, London, 21 November 2026).

AUDIENCE: the jury (Mistral engineers) and developers at the hackathon. They have
about one minute. Tone: playful but technical, cartoon security comic. NOT a generic
SaaS template.

HARD RULES
- Use only the facts, strings and numbers in this brief. Do not invent metrics,
  testimonials, customer logos, pricing, or extra features.
- Copy the code, evidence and command strings exactly as written here.
- Never iframe or link to localhost as live content. localhost appears only as text
  inside the quickstart code block.
- Fill the two placeholders: VIDEO_URL (demo video) and nothing else.
- Respect prefers-reduced-motion: no pulsing or auto-playing sequences, show the
  final state instead.
- Accessible: real headings in order, 4.5:1 text contrast in both themes, visible
  focus rings, status is never shown by colour alone (always the word PROVEN /
  BLOCKED / FIXED next to it).

STRUCTURE (single scroll page, sticky nav with section links + light/dark toggle)

1. HERO
   Headline (huge, chunky): "Vigil proves it before it speaks."
   Subline: "A security skill for Mistral Vibe. Rules spot a suspect, a local model
   explains it, an agent attacks a local copy of your app to prove it, the fix goes
   through an approval gate, and the same attack runs again to prove the fix works."
   Buttons: "Watch the run" (scrolls to demo), "Try it" (scrolls to quickstart).
   Right side: the 4 characters as cards, in this order, each lighting up in sequence
   on a loop, like the live page:
     🦊 Scout — rules
     🕵️ Detective — agent + proof
     🛠️ Mechanic — fix
     🦉 Gatekeeper — human gate
   Under the cards, one line that changes with the active character:
     Scout: "scan SUSPECT: 1 finding in 14 files"
     Detective: "PROVEN: alice read someone else's record ord_b1"
     Mechanic: "Fix applied to app/api/orders/[id]/route.ts"
     Gatekeeper: "Verdict FIXED"

2. THE PROBLEM (short band, 2 sentences)
   "AI writes pull requests faster than people can review them. Security tools flag
   fifty 'maybe' issues, so people learn to ignore them."
   Then, bold: "Vigil only raises its voice when an attack actually works."

3. HOW IT WORKS — 5 cards in a row with arrows (stack vertically on mobile)
   1. Scan — "Deterministic rules, no model. A match is only a suspect."  pill: amber SUSPECT
   2. Explain — "Ministral 3B runs on your laptop through Ollama and explains the suspect in plain words."  pill: amber SUSPECT
   3. Attack — "The Detective, a Mistral Agent on Large 4, picks an attack from an allowlist and runs it against your local app."  pill: red PROVEN
   4. Approve — "Every fix goes through a gate. Default: auto-apply with re-proof and automatic rollback. Add --ask to require a human click."  pill: amber WAITING
   5. Verify — "The same attack runs again. Code decides the verdict from what the app returned, not the model."  pill: green BLOCKED
   Cards appear and highlight as they scroll into view.

4. LIVE DEMO (id="demo")
   A 16:9 video player with src = VIDEO_URL (a screen recording of the live page).
   Caption: "Watch a real run: alice reads bob's order, the fix lands, the same
   attack is blocked."
   Fallback when VIDEO_URL is empty: an animated replay built in the page, stepping
   through these real events from the run of 21 Nov 2026, 16:55 (about 2 s per step,
   with a replay button). Show character emoji + text, colour the status words:
     🦊 Scout — scan SUSPECT: 1 finding in 14 files
     🦊 Scout — API route reads a record by ID without checking who owns it (app/api/orders/[id]/route.ts:7)
     🕵️ Detective — Mistral Large 4 is taking the case.
     🕵️ Detective — PROVEN: alice read someone else's record ord_b1 just by changing the id in the URL. (GET /api/orders/ord_b1 → HTTP 200)
     🛠️ Mechanic — Proposed fix: load the order scoped to the session user, return 404 when it is not theirs.
     🦉 Gatekeeper — Fix approved.
     🛠️ Mechanic — Fix applied to app/api/orders/[id]/route.ts and lib/db.ts.
     🕵️ Detective — BLOCKED: alice could not read record ord_b1. (same request → HTTP 404)
     🦉 Gatekeeper — Verdict FIXED: the attack was proven, the fix was approved, and the same attack is now blocked.

5. SAFE BY CONSTRUCTION — 3 icon cards
   - "Loopback only." Attacks go only to the loopback address in the repo's
     .vigil/target.json. Anything else is refused.
   - "The model never holds the keys." Users, records and passwords come only from
     that file. The agent cannot read .vigil/ or .env, and never sees or sends them.
   - "No fix without proof." Every fix goes through the approval gate and is rolled
     back automatically if the re-proof still succeeds. A control check confirms the
     owner can still read their own record, so a broken route cannot look fixed.
   Below, one line: "Works on any repo: drop a .vigil/target.json in it."

6. PROOF, NOT VIBES — styled like a terminal / report page
   Evidence block (monospace, exactly):
     GET /api/orders/ord_b1 (logged in as alice) -> HTTP 200
     {"id": "ord_b1", "user_id": 2, "item": "Le Chonk plush", "total": 29.99, "secret_note": "BOB'***"}
     ...fix applied...
     GET /api/orders/ord_b1 (logged in as alice) -> HTTP 404
     {"error": "order not found"}
   Verdict table, one row:  Scan: SUSPECT → Attack: PROVEN → Re-proof: BLOCKED → Run: FIXED
   Badges: "OWASP API1:2023 Broken Object Level Authorization", "OWASP A01:2021",
   "CWE-639", "NIST 800-53 AC-3", "ISO 27001:2022 A.5.15"
   Small print under the badges: "Mappings are guidance, not a certification."
   Link: "Read the full report" → https://github.com/francescococcia/ministral/blob/main/REPORT.md

7. WHERE MISTRAL RUNS — 5 small cards
   - Mistral Agents: "The Detective is an agent on Large 4 with 4 tools, deny-by-default permissions and an approval rule for fixes. Served with `agents serve`, traced in Studio, chat with it in Vibe Code Web."
   - Large 4 (Le Chonk): "Picks the attack and writes the fix."
   - Ministral 3B: "Scout and narrator, local through Ollama. Private code never leaves the laptop."
   - Voxtral: "Gives each character its own voice."
   - Vibe: "Runs as the /vigil skill."

8. PART OF SOMETHING BIGGER — one band, 3 columns: Record / Prove / Explain
   - Record — Tonk recorder: "Hooks record what agents do into a shared space."
   - Prove — Vigil: "This page." (highlighted column)
   - Explain — DevTok: "Turns the pull request into a 60-second video feed per role, with Vigil's findings on the approval screen."

9. QUICKSTART (id="quickstart") — dark code block with a copy button
   Needs line: "Node 22.5+, Python 3.12+, uv. Optional: Ollama for Ministral."
   Code, exactly:
     # 1. the target app (terminal 1)
     cd demo-app; npm install; npm run dev:3001
     # 2. Ministral, local (one time; skip to run without it)
     ollama pull ministral-3:3b
     ollama create vigil -f harness/Modelfile
     # 3. Vigil (terminal 2, repo root), then open http://127.0.0.1:8765/
     uv run --project engine engine/run.py demo-app
   Three flag chips under the block:
     --ask → "require a human Approve click"
     --mode mistral → "hosted Large 4 agent (needs MISTRAL_API_KEY)"
     --no-narrate → "skip Ministral, run offline"

10. HONEST LIMITS — one quiet line above the footer
   "Vigil proves two attack types today: reading another user's record, and reading
   without login. New attacks are entries in an allowlist. A clean result means no
   rule fired, not 'secure'."

11. FOOTER
   "Le Chonk in London · Mistral Vibe hackathon · 21 November 2026"
   "Mistral Vibe + Large 4 + Ministral 3B (Ollama) + Voxtral voices"
   Links (base https://github.com/francescococcia/ministral):
     Repo → /
     README → /blob/main/README.md
     Report → /blob/main/REPORT.md
     Demo script → /blob/main/DEMO.md
     Run logs → /tree/main/engine/runs
     Review of a real Mistral Vibe PR → /blob/main/reviews/mistral-vibe-pr140.md

STYLE
- Light: background #fff7ec, panel #ffffff, ink #2b2140, muted text #5a5070, lines #eadfce.
- Dark: background #1b1630, panel #251f3f, ink #f4efff, muted #c3b9dc, lines #3a3160.
- Status: red #c42b30 (soft #ffe1e1), amber #ffb020, green #17804c (soft #ddf6e8).
  Amber is a fill only: put ink-coloured text on it, never amber text on cream.
- Panels: 2px ink border, hard offset shadow 0 6px 0 rgba(43,33,64,.12), radius 16px.
  Buttons use the same border and shadow and press down 3px on click.
- Hero background: soft sky gradient #ffe3c2 → #ffd1e0 (dark mode: #251f3f → #1b1630).
- Fonts: "Bricolage Grotesque" 800 for headlines, Inter for body, IBM Plex Mono for
  code and status pills.
- Emoji characters are the brand. Show them large (64px+ in the hero cards).
- Motion: character card pulses red on PROVEN and settles green on BLOCKED; step
  cards fade up on scroll; nothing else moves.
- Theme toggle in the nav; default follows the system setting.
- Responsive: one column under 768px, hero characters in a 2×2 grid, nav collapses
  to the brand + toggle + "Try it" button. No horizontal scroll at 375px.
