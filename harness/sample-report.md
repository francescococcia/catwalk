# Security report: demo-app

- **Date:** 2026-11-21 14:37 UTC
- **Application:** `demo-app` (stack detected: general, nextjs)
- **Red-team run log:** `20261121-141224.jsonl` against `http://localhost:3001` (offline mode)
- **Dependency check:** npm audit + npm outdated

## Executive summary

**Overall: BLOCK: high-risk findings must be fixed before release.**

| Critical | High | Medium | Low | Total | Scan result | Red-team verdict |
|---|---|---|---|---|---|---|
| 0 | 2 | 4 | 0 | 6 | BLOCK | FIXED |

Vigil found 6 issue(s) in `demo-app`. The most serious is "Vulnerable dependency postcss (high): PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments (+3 more)" in `package.json` (high). This is not theoretical: during the red-team run, alice used `idor_read` and read data that belongs to another user (GET /api/orders/ord_b1 (logged in as alice)). A fix was applied and the same attack was then blocked, while the owner could still read their own data. Some third-party packages have known vulnerabilities or are major versions behind; upgrades need testing because they can include breaking changes. Findings marked *suspect* are rule hits that still need proof; *block* findings are reliable enough to stop a release on their own.

## Red team: proven attacks

### Attack: `idor_read` -> **PROVEN**

- **Attacker:** alice  
- **Target object:** `ord_b1`
- **Request:** `GET /api/orders/ord_b1 (logged in as alice)` -> HTTP 200
- **Evidence (redacted):** `{"id": "ord_b1", "user_id": 2, "item": "Le Chonk plush", "total": 29.99, "secret_note": "BOB'***"}`
- **Control check:** ok (alice reading own order ord_a1: HTTP 200)
- PROVEN: alice read someone else's order ord_b1 just by changing the id in the URL. Control: the owner can still read their own order.

**Fix proposed** for `app/api/orders/[id]/route.ts`: Return 404 unless the logged-in user owns the order: `if (!order || order.user_id !== userId)`. Same answer as 'not found', so the id of someone else's record leaks nothing.

```diff
--- a/app/api/orders/[id]/route.ts
+++ b/app/api/orders/[id]/route.ts
@@ -20,7 +20,7 @@
   // Any logged-in user can read ANY order by changing the id in the URL.
   // The fix is: getOrderByIdForUser(id, userId) -> WHERE id = ? AND user_id = ?
   const order = getOrderById(id);
-  if (!order) {
+  if (!order || order.user_id !== userId) {
     return NextResponse.json({ error: "order not found" }, { status: 404 });
   }
```

**Approval:** allow by the agent (auto-apply).

**Fix applied** to `app/api/orders/[id]/route.ts`.

### Re-proof after fix: `idor_read` -> **BLOCKED**

- **Attacker:** alice  
- **Target object:** `ord_b1`
- **Request:** `GET /api/orders/ord_b1 (logged in as alice)` -> HTTP 404
- **Evidence (redacted):** `{"error": "order not found"}`
- **Control check:** ok (alice reading own order ord_a1: HTTP 200)
- BLOCKED: alice could not read order ord_b1. Control: the owner can still read their own order.

**Verdict: FIXED.** Verdict FIXED: the attack was proven, the fix was approved, and the same attack is now blocked.

## All findings

| # | Severity | Level | Rule | Location | OWASP | CWE |
|---|---|---|---|---|---|---|
| 1 | high | block | `dep-vulnerable` | `package.json:1` | A06:2021 | CWE-1395 |
| 2 | high | suspect, PROVEN by attack | `nextjs-api-no-ownership` | `app/api/orders/[id]/route.ts:7` | A01:2021, API1:2023 | CWE-639 |
| 3 | medium | suspect | `dep-vulnerable` | `package.json:12` | A06:2021 | CWE-1395 |
| 4 | medium | suspect | `dep-major-behind` | `package.json:12` | A06:2021 | CWE-1104 |
| 5 | medium | suspect | `dep-major-behind` | `package.json:17` | A06:2021 | CWE-1104 |
| 6 | medium | suspect | `dep-major-behind` | `package.json:20` | A06:2021 | CWE-1104 |

## Finding details

### 1. Vulnerable dependency postcss (high): PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments (+3 more)

- **What:** `postcss <=8.5.22 (indirect, via next)` (high, block)
- **Where:** `package.json` line 1
- **Why it matters:** Published vulnerabilities in a dependency are well known to attackers; exploit code often exists.
- **Fix:** upgrade next to 16.4.6 (major version: may include breaking changes). Advisories: https://github.com/advisories/GHSA-6g55-p6wh-862q, https://github.com/advisories/GHSA-r28c-9q8g-f849, https://github.com/advisories/GHSA-qx2v-qp2m-jg93
- **Standards:** A06:2021 Vulnerable and Outdated Components; n/a; CWE-1395 Dependency on Vulnerable Third-Party Component; NIST 800-53 RA-5 Vulnerability Monitoring and Scanning, SI-2 Flaw Remediation; ISO 27001:2022 A.8.8 Management of technical vulnerabilities

### 2. API route reads a record by ID without checking who owns it

- **What:** `export async function GET` (high, suspect, PROVEN by attack)
- **Where:** `app/api/orders/[id]/route.ts` line 7
- **Why it matters:** Any logged-in user can read or change other users' records by changing the id in the URL (IDOR). This is the most common API data leak.
- **Fix:** Load the record scoped to the session user (e.g. WHERE id = ? AND user_id = ?) and return 404 when it is not theirs.
- **Ministral explanation** (model note, never the verdict; confidence 1.0): An attacker could read or modify orders belonging to other users by crafting a malicious URL with an ID of a target user's order. Suggested fix: Replace `getOrderById(id)` with `getOrderByIdForUser(id, userId)` to enforce ownership validation.
- **Standards:** A01:2021 Broken Access Control; API1:2023 Broken Object Level Authorization; CWE-639 Authorization Bypass Through User-Controlled Key; NIST 800-53 AC-3 Access Enforcement, AC-6 Least Privilege; ISO 27001:2022 A.5.15 Access control, A.8.3 Information access restriction

### 3. Vulnerable dependency next (moderate): vulnerable through postcss

- **What:** `next 9.3.4-canary.0 - 16.3.0-preview.10` (medium, suspect)
- **Where:** `package.json` line 12
- **Why it matters:** Published vulnerabilities in a dependency are well known to attackers; exploit code often exists.
- **Fix:** upgrade next to 16.4.6 (major version: may include breaking changes). Advisories: see npm audit
- **Standards:** A06:2021 Vulnerable and Outdated Components; n/a; CWE-1395 Dependency on Vulnerable Third-Party Component; NIST 800-53 RA-5 Vulnerability Monitoring and Scanning, SI-2 Flaw Remediation; ISO 27001:2022 A.8.8 Management of technical vulnerabilities

### 4. next is 1 major version behind: upgrading may include breaking changes

- **What:** `next 15.5.29 -> 16.4.6` (medium, suspect)
- **Where:** `package.json` line 12
- **Why it matters:** Old major versions stop receiving security fixes; the longer you wait, the bigger (and riskier) the upgrade.
- **Fix:** Read the next 16.x migration guide/changelog, upgrade on a branch, run the tests. Old majors stop getting security fixes.
- **Standards:** A06:2021 Vulnerable and Outdated Components; n/a; CWE-1104 Use of Unmaintained Third Party Components; NIST 800-53 SI-2 Flaw Remediation, CM-3 Configuration Change Control; ISO 27001:2022 A.8.8 Management of technical vulnerabilities, A.8.32 Change management

### 5. @types/node is 2 major versions behind: upgrading may include breaking changes

- **What:** `@types/node 24.19.2 -> 26.6.6` (medium, suspect)
- **Where:** `package.json` line 17
- **Why it matters:** Old major versions stop receiving security fixes; the longer you wait, the bigger (and riskier) the upgrade.
- **Fix:** Read the @types/node 26.x migration guide/changelog, upgrade on a branch, run the tests. Old majors stop getting security fixes.
- **Standards:** A06:2021 Vulnerable and Outdated Components; n/a; CWE-1104 Use of Unmaintained Third Party Components; NIST 800-53 SI-2 Flaw Remediation, CM-3 Configuration Change Control; ISO 27001:2022 A.8.8 Management of technical vulnerabilities, A.8.32 Change management

### 6. typescript is 2 major versions behind: upgrading may include breaking changes

- **What:** `typescript 5.9.3 -> 7.0.2` (medium, suspect)
- **Where:** `package.json` line 20
- **Why it matters:** Old major versions stop receiving security fixes; the longer you wait, the bigger (and riskier) the upgrade.
- **Fix:** Read the typescript 7.x migration guide/changelog, upgrade on a branch, run the tests. Old majors stop getting security fixes.
- **Standards:** A06:2021 Vulnerable and Outdated Components; n/a; CWE-1104 Use of Unmaintained Third Party Components; NIST 800-53 SI-2 Flaw Remediation, CM-3 Configuration Change Control; ISO 27001:2022 A.8.8 Management of technical vulnerabilities, A.8.32 Change management

## Blue team recommendations

- **Broken access control (IDOR / missing auth / RLS):** Log every 403/404 on object routes with user id and object id. Alert on bursts of 404s or denied reads across many different ids from one user or IP (id enumeration). Add an automated test per route that user A cannot read user B's object, and keep the Vigil `idor_read` proof in CI.
- **Dependencies:** Run `npm audit` (or `vigil scan --deps`) in CI on every lockfile change and on a schedule; enable Dependabot/Renovate alerts; plan major upgrades before the old major goes end-of-life.
- **Always:** keep this report's checks in CI (`vigil.py scan --no-llm` as the gate), log authentication and authorization failures centrally, and review alerts weekly.

## Compliance mapping

Mappings are guidance for reporting and triage, not a certification or audit opinion.

| Rule | Findings | OWASP | NIST SP 800-53 | ISO/IEC 27001:2022 Annex A |
|---|---|---|---|---|
| `dep-major-behind` | 3 | A06:2021 Vulnerable and Outdated Components | SI-2 Flaw Remediation, CM-3 Configuration Change Control | A.8.8 Management of technical vulnerabilities, A.8.32 Change management |
| `dep-vulnerable` | 2 | A06:2021 Vulnerable and Outdated Components | RA-5 Vulnerability Monitoring and Scanning, SI-2 Flaw Remediation | A.8.8 Management of technical vulnerabilities |
| `nextjs-api-no-ownership` | 1 | A01:2021 Broken Access Control; API1:2023 Broken Object Level Authorization | AC-3 Access Enforcement, AC-6 Least Privilege | A.5.15 Access control, A.8.3 Information access restriction |

## Methodology

1. **Rules (deterministic):** `harness/vigil.py` with the packs general, nextjs matched regex rules on the source (comments stripped for protection checks). Rules decide what is a finding; nothing else can remove one.
2. **Local Ministral:** explains each suspect in plain English. Its notes are shown above but never change a severity or verdict.
3. **Red team (engine):** only allowlisted attacks (`idor_read`) against a **local** target with fixed demo accounts; a positive control checks the owner can still read their own data, so a broken route cannot look "fixed".
4. **Fix + re-proof:** the fix is applied through an approval gate, then the same attack is re-run; still proven = automatic rollback.
5. **Dependencies:** `npm audit --json` and `npm outdated --json` per package.json. npm audit sends the lockfile's package list (not code) to the npm registry.

**Not tested:** attacks other than `idor_read` (no SQLi/XSS exploitation, no brute force, no DoS); authenticated crawling/DAST of every route; business-logic flaws outside the rules; cloud, network and infrastructure configuration; secrets already in git history; whether vulnerable dependency code is actually reachable; files over 200 KB and folders like node_modules/.next. A clean result means "no rule fired", not "secure".

## Appendix

- Report generated: 2026-11-21 14:37 UTC
- Run started: 2026-11-21T14:12:25.529+00:00; verdict at: 2026-11-21T14:13:25.062+00:00
- Python 3.14.5 on Windows; node v24.16.0; npm 11.13.0
- Explanation model: `ministral-3:3b via local Ollama (engine default)`; 1 explanation(s) in the run log
- Rules loaded: 15 from packs general, nextjs
- Run log: `20261121-141224.jsonl` (32 events)
