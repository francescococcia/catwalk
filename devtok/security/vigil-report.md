# Security report: devtok

- **Date:** 2026-11-21 15:50 UTC
- **Application:** `devtok` (stack detected: general)
- **Red-team run log:** `empty.jsonl`
- **Dependency check:** not run (use --deps)

## Executive summary

**Overall: NEEDS REVIEW: suspects found, none proven yet.**

| Critical | High | Medium | Low | Total | Scan result | Red-team verdict |
|---|---|---|---|---|---|---|
| 0 | 0 | 6 | 0 | 6 | SUSPECT | not run |

Vigil found 6 issue(s) in `devtok`. The most serious is "Raw HTML injection (possible XSS)" in `renderer/src/main.js` (medium). Findings marked *suspect* are rule hits that still need proof; *block* findings are reliable enough to stop a release on their own.

## Red team: proven attacks

No attack was run (no run log). Start one with `uv run --project engine engine/run.py <app>`.

## All findings

| # | Severity | Level | Rule | Location | OWASP | CWE |
|---|---|---|---|---|---|---|
| 1 | medium | suspect | `raw-html` | `renderer/src/main.js:246` | A03:2021 | CWE-79 |
| 2 | medium | suspect | `raw-html` | `renderer/src/main.js:279` | A03:2021 | CWE-79 |
| 3 | medium | suspect | `raw-html` | `renderer/src/main.js:402` | A03:2021 | CWE-79 |
| 4 | medium | suspect | `raw-html` | `renderer/src/main.js:412` | A03:2021 | CWE-79 |
| 5 | medium | suspect | `raw-html` | `renderer/src/scenes.js:147` | A03:2021 | CWE-79 |
| 6 | medium | suspect | `raw-html` | `renderer/src/scenes.js:269` | A03:2021 | CWE-79 |

## Finding details

### 1. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/main.js` line 246
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

### 2. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/main.js` line 279
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

### 3. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/main.js` line 402
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

### 4. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/main.js` line 412
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

### 5. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/scenes.js` line 147
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

### 6. Raw HTML injection (possible XSS)

- **What:** `.innerHTML =` (medium, suspect)
- **Where:** `renderer/src/scenes.js` line 269
- **Why it matters:** Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).
- **Fix:** Render as text, or sanitize with a vetted HTML sanitizer first.
- **Standards:** A03:2021 Injection; n/a; CWE-79 Cross-site Scripting; NIST 800-53 SI-10 Information Input Validation; ISO 27001:2022 A.8.28 Secure coding

## Blue team recommendations

- **Injection (SQL, eval, XSS, prompt injection):** Log and alert on database errors and on requests containing SQL/script metacharacters to sensitive routes (WAF in detect mode first). Add a Content-Security-Policy with reporting enabled to see XSS attempts. Review any diff that adds text addressed to AI reviewers.
- **Always:** keep this report's checks in CI (`vigil.py scan --no-llm` as the gate), log authentication and authorization failures centrally, and review alerts weekly.

## Compliance mapping

Mappings are guidance for reporting and triage, not a certification or audit opinion.

| Rule | Findings | OWASP | NIST SP 800-53 | ISO/IEC 27001:2022 Annex A |
|---|---|---|---|---|
| `raw-html` | 6 | A03:2021 Injection | SI-10 Information Input Validation | A.8.28 Secure coding |

## Methodology

1. **Rules (deterministic):** `harness/vigil.py` with the packs general matched regex rules on the source (comments stripped for protection checks). Rules decide what is a finding; nothing else can remove one.
2. **Local Ministral:** explains each suspect in plain English. Its notes are shown above but never change a severity or verdict.
3. **Red team (engine):** only allowlisted attacks (`idor_read`, `unauth_read`) against the **local** target declared in `<app>/.vigil/target.json` (loopback only; users, records, routes and passwords come from that file, never from the model); a positive control checks the owner can still read their own data, so a broken route cannot look "fixed".
4. **Fix + re-proof:** the fix is applied through an approval gate, then the same attack is re-run; still proven = automatic rollback.
5. **Dependencies:** not run for this report.

**Not tested:** attacks other than `idor_read`/`unauth_read` (no SQLi/XSS exploitation, no brute force, no DoS); authenticated crawling/DAST of every route; business-logic flaws outside the rules; cloud, network and infrastructure configuration; secrets already in git history; whether vulnerable dependency code is actually reachable; files over 200 KB and folders like node_modules/.next. A clean result means "no rule fired", not "secure".

## Appendix

- Report generated: 2026-11-21 15:50 UTC
- Run started: -; verdict at: -
- Python 3.14.5 on Windows; node v24.16.0; npm 11.13.0
- Explanation model: `ministral-3:3b via local Ollama (engine default)`; 0 explanation(s) in the run log
- Rules loaded: 11 from packs general
- Run log: `empty.jsonl` (0 events)
