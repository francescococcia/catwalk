"""Vigil security report: one Markdown file from a rules scan (+ optional npm deps) and an engine run log.

Usage:
  python harness/report.py <app_path> [--run engine/runs/<file>.jsonl] [--out REPORT.md] [--deps]
Without --run it uses the newest engine/runs/*.jsonl that contains a verdict.
Secret values are never printed: rule matches are masked by vigil, attack evidence uses the
run log's redacted body (never evidence_local), and a last pass masks provider-shaped tokens.
"""
import argparse, json, os, platform, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import vigil  # noqa: E402

RUNS = HERE.parent / "engine" / "runs"
SEV_ORDER = ["critical", "high", "medium", "low", "info"]

WHY = {
    "nextjs-api-no-ownership": "Any logged-in user can read or change other users' records by changing the id in the URL (IDOR). This is the most common API data leak.",
    "nextjs-api-no-auth": "Anyone on the internet can call this endpoint without logging in.",
    "nextjs-server-action-trusts-client": "Server actions are public HTTP endpoints; without a session check anyone can invoke them.",
    "hardcoded-secret": "Anyone with read access to the code (or a leaked copy) gets the credential.",
    "provider-secret": "A cloud/provider key in the repo lets whoever finds it spend money or read data as you. Bots scan public repos for these within minutes.",
    "env-file-committed": ".env files usually hold every secret of the app; once committed they live in git history.",
    "nextjs-public-secret": "NEXT_PUBLIC_ variables are bundled into the JavaScript sent to every visitor.",
    "supabase-service-role-in-client": "The service_role key bypasses all Row Level Security; in the browser it gives every visitor full database access.",
    "supabase-table-no-rls": "Without RLS, anyone holding the public anon key can read and write every row.",
    "supabase-rls-policy-true": "A USING (true) policy is the same as having no policy.",
    "sql-string-building": "If user input reaches the string, an attacker can rewrite the query (read, change or delete data).",
    "eval-use": "If user input reaches eval/exec, an attacker can run arbitrary code on the server or in the browser.",
    "raw-html": "Unsanitized HTML lets an attacker run script in other users' browsers (session theft, actions as the victim).",
    "cors-wildcard": "Any website can call this API from a visitor's browser.",
    "prompt-injection-bait": "Text aimed at AI reviewers/agents can trick automated tooling into approving or ignoring malicious code.",
    "jwt-unverified": "Without signature checks an attacker can forge a token and log in as anyone.",
    "jwt-decode-no-verify": "jwt.decode() does not check the signature; trusting its payload lets attackers pick their own user id or role.",
    "cookie-no-httponly": "Without httpOnly, any injected script can read the session cookie and hijack the account.",
    "dep-vulnerable": "Published vulnerabilities in a dependency are well known to attackers; exploit code often exists.",
    "dep-major-behind": "Old major versions stop receiving security fixes; the longer you wait, the bigger (and riskier) the upgrade.",
}

BLUE = {
    "access": ("Broken access control (IDOR / missing auth / RLS)",
               "Log every 403/404 on object routes with user id and object id. Alert on bursts of 404s or denied reads "
               "across many different ids from one user or IP (id enumeration). Add an automated test per route that "
               "user A cannot read user B's object, and keep the Vigil `idor_read` proof in CI."),
    "secret": ("Secrets in code",
               "Run secret scanning in CI and as a pre-commit hook (`python harness/vigil.py scan . --no-llm` blocks on "
               "provider keys and .env files). Enable the git host's push protection. Alert on use of rotated keys and "
               "on unusual API usage per key; keep keys in a secret manager with least privilege."),
    "injection": ("Injection (SQL, eval, XSS, prompt injection)",
                  "Log and alert on database errors and on requests containing SQL/script metacharacters to sensitive "
                  "routes (WAF in detect mode first). Add a Content-Security-Policy with reporting enabled to see XSS "
                  "attempts. Review any diff that adds text addressed to AI reviewers."),
    "auth": ("Authentication / session tokens",
             "Log token verification failures and alert on tokens with alg none or invalid signatures. Monitor for one "
             "session used from many IPs/agents. Set cookies httpOnly, secure, sameSite."),
    "config": ("Security misconfiguration (CORS)",
               "Track allowed origins in config, alert on preflight requests from unknown origins to credentialed endpoints."),
    "deps": ("Dependencies",
             "Run `npm audit` (or `vigil scan --deps`) in CI on every lockfile change and on a schedule; enable "
             "Dependabot/Renovate alerts; plan major upgrades before the old major goes end-of-life."),
}
BLUE_OF = {
    "nextjs-api-no-ownership": "access", "nextjs-api-no-auth": "access", "nextjs-server-action-trusts-client": "access",
    "supabase-table-no-rls": "access", "supabase-rls-policy-true": "access",
    "hardcoded-secret": "secret", "provider-secret": "secret", "env-file-committed": "secret",
    "nextjs-public-secret": "secret", "supabase-service-role-in-client": "secret",
    "sql-string-building": "injection", "eval-use": "injection", "raw-html": "injection", "prompt-injection-bait": "injection",
    "jwt-unverified": "auth", "jwt-decode-no-verify": "auth", "cookie-no-httponly": "auth",
    "cors-wildcard": "config", "dep-vulnerable": "deps", "dep-major-behind": "deps",
}


def cell(s) -> str:
    return str(s if s not in (None, "") else "-").replace("|", "\\|").replace("\n", " ")


def short(ref: str) -> str:
    """'A01:2021 Broken Access Control; A05...' -> 'A01:2021, A05:2021'."""
    return ", ".join(p.strip().split(" ")[0] for p in (ref or "").split(";") if p.strip()) or "-"


def load_run(path: Path | None) -> list[dict]:
    if not path:
        return []
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def newest_run(runs: Path = RUNS) -> Path | None:
    for p in sorted(runs.glob("*.jsonl"), reverse=True):
        if any(e.get("type") == "verdict" for e in load_run(p)):
            return p
    return None


def overall(scan_result: str, run_verdict: str | None) -> str:
    if run_verdict == "PROVEN":
        return "AT RISK: an attack was proven against the running app and is still open"
    if scan_result == "BLOCK":
        return "BLOCK: high-risk findings must be fixed before release"
    if run_verdict == "FIXED":
        return "FIXED IN RUN: the proven issue was fixed and the same attack re-tested as blocked" + (
            "; the current source still has unproven suspects" if scan_result == "SUSPECT" else "")
    return {"SUSPECT": "NEEDS REVIEW: suspects found, none proven yet", "PASS": "PASS: no findings"}[scan_result]


def tool_version(args: list[str]) -> str:
    exe = shutil.which(args[0])
    if not exe:
        return "not found"
    try:
        return subprocess.run([exe, *args[1:]], capture_output=True, text=True, timeout=15).stdout.strip() or "?"
    except (OSError, subprocess.TimeoutExpired):
        return "?"


def build(app: Path, stack: set, findings: list[dict], events: list[dict], run_name: str | None, used_deps: bool) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    findings = sorted(findings, key=lambda f: (SEV_ORDER.index(f["severity"]) if f["severity"] in SEV_ORDER else 9, f["level"] != "block", f["file"], f["line"]))
    by = lambda t: [e for e in events if e.get("type") == t]
    verdicts = by("verdict")
    run_verdict = verdicts[-1]["result"] if verdicts else None
    scan_result = vigil.result(findings)
    counts = {s: sum(f["severity"] == s for f in findings) for s in SEV_ORDER}
    expl = {(e.get("file"), e.get("rule")): e for e in by("explanation")}
    proofs = by("proof")
    proven_attacks = {p.get("attack") for p in proofs if p.get("status") == "PROVEN"}
    lvl = lambda f: f["level"] + (", PROVEN by attack" if f.get("attack") and f["attack"] in proven_attacks else "")
    started = (by("run_started") or [{}])[0]

    o = [f"# Security report: {app.name}", "",
         f"- **Date:** {now}",
         f"- **Application:** `{app.name}` (stack detected: {', '.join(sorted(stack))})",
         f"- **Red-team run log:** `{run_name or 'none'}`" + (f" against `{started.get('target')}` ({started.get('mode')} mode)" if started else ""),
         f"- **Dependency check:** {'npm audit + npm outdated' if used_deps else 'not run (use --deps)'}", "",
         "## Executive summary", "",
         f"**Overall: {overall(scan_result, run_verdict)}.**", "",
         "| Critical | High | Medium | Low | Total | Scan result | Red-team verdict |",
         "|---|---|---|---|---|---|---|",
         f"| {counts['critical']} | {counts['high']} | {counts['medium']} | {counts['low']} | {len(findings)} | {scan_result} | {run_verdict or 'not run'} |", ""]
    para = [f"Vigil found {len(findings)} issue(s) in `{app.name}`."]
    if findings:
        top = findings[0]
        para.append(f"The most serious is \"{top['title']}\" in `{top['file']}` ({top['severity']}).")
    proven = [p for p in proofs if p.get("status") == "PROVEN"]
    if proven:
        p = proven[0]
        para.append(f"This is not theoretical: during the red-team run, {p.get('params', {}).get('attacker', 'a test user')} "
                    f"used `{p.get('attack')}` and read data that belongs to another user ({p['evidence'].get('request')}).")
    if run_verdict == "FIXED":
        para.append("A fix was applied and the same attack was then blocked, while the owner could still read their own data.")
    elif run_verdict == "PROVEN":
        para.append("The attack still works: fix this first.")
    if any(f["rule"].startswith("dep-") for f in findings):
        para.append("Some third-party packages have known vulnerabilities or are major versions behind; upgrades need testing because they can include breaking changes.")
    para.append("Findings marked *suspect* are rule hits that still need proof; *block* findings are reliable enough to stop a release on their own.")
    o += [" ".join(para), ""]

    o += ["## Red team: proven attacks", ""]
    if not proofs:
        o += ["No attack was run (no run log). Start one with `uv run --project engine engine/run.py <app>`.", ""]
    after_fix = False
    for e in events:
        t = e.get("type")
        if t == "proof":
            ev, ctl = e.get("evidence") or {}, e.get("control") or {}
            o += [f"### {'Re-proof after fix' if after_fix else 'Attack'}: `{e.get('attack')}` -> **{e.get('status')}**", "",
                  f"- **Attacker:** {e.get('params', {}).get('attacker', '-')}  ",
                  f"- **Target object:** `{e.get('params', {}).get('victim_order', '-')}`",
                  f"- **Request:** `{ev.get('request', '-')}` -> HTTP {ev.get('status_code', '-')}",
                  f"- **Evidence (redacted):** `{str(ev.get('body_redacted', '-'))[:300]}`",
                  f"- **Control check:** {'ok' if ctl.get('ok') else 'FAILED'} ({ctl.get('detail', '-')})",
                  f"- {e.get('text', '')}", ""]
        elif t == "fix_proposed":
            o += [f"**Fix proposed** for `{e.get('file')}`: {e.get('reason', '')}", "", "```diff", e.get("diff", "").replace("\r", "").rstrip(), "```", ""]
        elif t == "approval":
            o += [f"**Approval:** {e.get('decision')} by {e.get('by', 'a human')}.", ""]
        elif t == "fix_applied":
            after_fix = True
            o += [f"**Fix applied** to `{e.get('file')}`.", ""]
        elif t == "rollback":
            o += [f"**Rolled back** `{e.get('file')}`: {e.get('reason', '')}", ""]
        elif t == "verdict":
            o += [f"**Verdict: {e.get('result')}.** {e.get('text', '')}", ""]

    o += ["## All findings", "", "| # | Severity | Level | Rule | Location | OWASP | CWE |", "|---|---|---|---|---|---|---|"]
    for i, f in enumerate(findings, 1):
        s = f.get("standards") or {}
        owasp = ", ".join(x for x in (short(s.get("owasp_top10_2021")), short(s.get("owasp_api_2023")), short(s.get("owasp_llm_2025"))) if x not in ("-", "n/a"))
        o.append(f"| {i} | {f['severity']} | {lvl(f)} | `{f['rule']}` | `{cell(f['file'])}:{f['line']}` | {cell(owasp)} | {cell(short(s.get('cwe')))} |")
    o += [""]

    o += ["## Finding details", ""]
    for i, f in enumerate(findings, 1):
        s = f.get("standards") or {}
        o += [f"### {i}. {f['title']}", "",
              f"- **What:** `{cell(f['match'])}` ({f['severity']}, {lvl(f)})",
              f"- **Where:** `{f['file']}` line {f['line']}",
              f"- **Why it matters:** {WHY.get(f['rule'], s.get('cwe', 'See the rule description.'))}",
              f"- **Fix:** {f['fix']}"]
        if (x := expl.get((f["file"], f["rule"]))):
            o.append(f"- **Ministral explanation** (model note, never the verdict; confidence {x.get('confidence')}): "
                     f"{x.get('text', '').removeprefix('Ministral Scout: ')} Suggested fix: {x.get('fix', '-')}")
        if s:
            o.append(f"- **Standards:** {s.get('owasp_top10_2021', '-')}; {s.get('owasp_api_2023', '-')}"
                     + (f"; {s['owasp_llm_2025']}" if s.get("owasp_llm_2025") else "")
                     + f"; {s.get('cwe', '-')}; NIST 800-53 {', '.join(s.get('nist_800_53', []))}; ISO 27001:2022 {', '.join(s.get('iso27001_2022', []))}")
        o.append("")

    o += ["## Blue team recommendations", ""]
    groups = sorted({BLUE_OF.get(f["rule"], "config") for f in findings}, key=list(BLUE).index)
    for g in groups:
        title, text = BLUE[g]
        o += [f"- **{title}:** {text}"]
    o += ["- **Always:** keep this report's checks in CI (`vigil.py scan --no-llm` as the gate), log authentication and "
          "authorization failures centrally, and review alerts weekly.", ""]

    o += ["## Compliance mapping", "",
          "Mappings are guidance for reporting and triage, not a certification or audit opinion.", "",
          "| Rule | Findings | OWASP | NIST SP 800-53 | ISO/IEC 27001:2022 Annex A |", "|---|---|---|---|---|"]
    for rule in sorted({f["rule"] for f in findings}):
        s = vigil.STANDARDS.get(rule, {})
        owasp = "; ".join(x for x in (s.get("owasp_top10_2021"), s.get("owasp_api_2023"), s.get("owasp_llm_2025")) if x and x != "n/a")
        o.append(f"| `{rule}` | {sum(f['rule'] == rule for f in findings)} | {cell(owasp)} | {cell(', '.join(s.get('nist_800_53', [])))} | {cell(', '.join(s.get('iso27001_2022', [])))} |")
    o += [""]

    o += ["## Methodology", "",
          f"1. **Rules (deterministic):** `harness/vigil.py` with the packs {', '.join(sorted(stack))} matched regex rules on the source "
          "(comments stripped for protection checks). Rules decide what is a finding; nothing else can remove one.",
          "2. **Local Ministral:** explains each suspect in plain English. Its notes are shown above but never change a severity or verdict.",
          "3. **Red team (engine):** only allowlisted attacks (`idor_read`) against a **local** target with fixed demo accounts; "
          "a positive control checks the owner can still read their own data, so a broken route cannot look \"fixed\".",
          "4. **Fix + re-proof:** the fix is applied through an approval gate, then the same attack is re-run; still proven = automatic rollback.",
          "5. **Dependencies:** " + ("`npm audit --json` and `npm outdated --json` per package.json. npm audit sends the lockfile's package list (not code) to the npm registry."
                                     if used_deps else "not run for this report."), "",
          "**Not tested:** attacks other than `idor_read` (no SQLi/XSS exploitation, no brute force, no DoS); authenticated "
          "crawling/DAST of every route; business-logic flaws outside the rules; cloud, network and infrastructure configuration; "
          "secrets already in git history; whether vulnerable dependency code is actually reachable; files over 200 KB and "
          "folders like node_modules/.next. A clean result means \"no rule fired\", not \"secure\".", ""]

    o += ["## Appendix", "",
          f"- Report generated: {now}",
          f"- Run started: {started.get('ts', '-')}; verdict at: {verdicts[-1].get('ts', '-') if verdicts else '-'}",
          f"- Python {platform.python_version()} on {platform.system()}; node {tool_version(['node', '-v'])}; npm {tool_version(['npm', '-v'])}",
          f"- Explanation model: `{os.environ.get('VIGIL_MODEL', 'ministral-3:3b via local Ollama (engine default)')}`; "
          f"{len(by('explanation'))} explanation(s) in the run log",
          f"- Rules loaded: {len(vigil.load_rules(stack))} from packs {', '.join(sorted(stack))}",
          f"- Run log: `{run_name or 'none'}` ({len(events)} events)", ""]
    return vigil.TOKEN.sub(lambda m: m.group(1) + "***", "\n".join(o))  # last line of defence: no provider tokens in the report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="report")
    ap.add_argument("app")
    ap.add_argument("--run", help="engine run log (.jsonl); default: newest with a verdict")
    ap.add_argument("--out", default="REPORT.md")
    ap.add_argument("--deps", action="store_true", help="include npm audit / npm outdated")
    a = ap.parse_args(argv)
    app = Path(a.app).resolve()
    stack, findings = vigil.scan(app)
    if a.deps:
        import deps
        findings += deps.check_deps(app)
    run = Path(a.run) if a.run else newest_run()
    md = build(app, stack, findings, load_run(run), run.name if run else None, a.deps)
    Path(a.out).write_text(md, encoding="utf-8")
    print(f"wrote {a.out}: {len(findings)} finding(s), run log {run.name if run else 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
