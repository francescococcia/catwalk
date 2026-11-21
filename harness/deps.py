"""Dependency checks for vigil: npm audit (known vulnerabilities) and npm outdated (major versions behind).

check_deps(root) -> findings in the vigil finding shape. Never raises: npm missing, offline or
no lockfile prints a note to stderr and yields no findings for that folder.
Privacy: npm audit sends the lockfile's package names/versions to the npm registry (not your code).
"""
import json, re, shutil, subprocess, sys
from pathlib import Path

from vigil import SKIP_DIRS, add_standards

NPM_LEVEL = {"critical": ("critical", "block"), "high": ("high", "block"),
             "moderate": ("medium", "suspect"), "low": ("low", "suspect"), "info": ("low", "suspect")}
RANK = ["info", "low", "moderate", "high", "critical"]


def note(msg: str) -> None:
    print(f"vigil deps: {msg}", file=sys.stderr)


def npm(args: list[str], cwd: Path) -> dict | None:
    exe = shutil.which("npm")  # resolves npm.cmd on Windows; list args, no shell
    if not exe:
        note("npm not found, dependency check skipped")
        return None
    try:
        out = subprocess.run([exe, *args], cwd=cwd, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=60).stdout
        data = json.loads(out or "{}")  # exit code 1 just means "found something"
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        note(f"npm {args[0]} failed in {cwd.name}: {str(e)[:120]}")
        return None
    if isinstance(data, dict) and "error" in data:
        note(f"npm {args[0]} in {cwd.name}: {str(data['error'].get('summary') if isinstance(data['error'], dict) else data['error'])[:160]}")
        return None
    return data


def line_of(pkg_json: str, name: str) -> int:
    m = re.search(r'"' + re.escape(name) + r'"\s*:', pkg_json)
    return pkg_json.count("\n", 0, m.start()) + 1 if m else 1


def major(v) -> int | None:
    m = re.match(r"\D*(\d+)", str(v or ""))
    return int(m.group(1)) if m else None


def audit_findings(data: dict, rel: str, pkg_json: str) -> list[dict]:
    out = []
    for name, v in sorted((data.get("vulnerabilities") or {}).items()):
        severity, level = NPM_LEVEL.get(v.get("severity"), ("medium", "suspect"))
        advisories = sorted((a for a in v.get("via", []) if isinstance(a, dict)),
                            key=lambda a: RANK.index(a.get("severity", "info")) if a.get("severity") in RANK else 0, reverse=True)
        via = [a for a in v.get("via", []) if isinstance(a, str)]
        what = (f"{advisories[0]['title']}" + (f" (+{len(advisories) - 1} more)" if len(advisories) > 1 else "")
                if advisories else f"vulnerable through {', '.join(via)}")
        fx = v.get("fixAvailable")
        if isinstance(fx, dict):
            fixed = f"upgrade {fx.get('name')} to {fx.get('version')}" + (" (major version: may include breaking changes)" if fx.get("isSemVerMajor") else "")
        else:
            fixed = "run npm audit fix" if fx else "no fixed version published yet: watch the advisory or replace the package"
        out.append({"rule": "dep-vulnerable", "title": f"Vulnerable dependency {name} ({v.get('severity')}): {what}",
                    "severity": severity, "level": level, "attack": None, "pack": "deps",
                    "file": rel, "line": line_of(pkg_json, name),
                    "match": f"{name} {v.get('range', '')}".strip() + ("" if v.get("isDirect", True) else f" (indirect, via {', '.join(v.get('effects') or ['a dependency'])})"),
                    "fix": fixed + ". Advisories: " + (", ".join(a.get("url", "") for a in advisories[:3]) or "see npm audit"),
                    "ask": "Is the vulnerable code path of this package reachable from this app?"})
    return out


def outdated_findings(data: dict, rel: str, pkg_json: str) -> list[dict]:
    out = []
    for name, v in sorted(data.items()):
        cur, latest = major(v.get("current")), major(v.get("latest"))
        if cur is None or latest is None or latest <= cur:
            continue
        n = latest - cur
        out.append({"rule": "dep-major-behind",
                    "title": f"{name} is {n} major version{'s' if n > 1 else ''} behind: upgrading may include breaking changes",
                    "severity": "medium", "level": "suspect", "attack": None, "pack": "deps",
                    "file": rel, "line": line_of(pkg_json, name),
                    "match": f"{name} {v.get('current')} -> {v.get('latest')}",
                    "fix": f"Read the {name} {latest}.x migration guide/changelog, upgrade on a branch, run the tests. Old majors stop getting security fixes.",
                    "ask": "Does this app rely on APIs that changed in the newer major version?"})
    return out


def check_deps(root: Path, run=npm) -> list[dict]:
    root = Path(root)
    findings = []
    for pkg in sorted(root.rglob("package.json")):
        if SKIP_DIRS & set(pkg.relative_to(root).parts):
            continue
        rel, folder = pkg.relative_to(root).as_posix(), pkg.parent
        try:
            text = pkg.read_text(encoding="utf-8")
        except OSError:
            continue
        if (folder / "package-lock.json").exists():
            if (data := run(["audit", "--json"], folder)) is not None:
                findings += audit_findings(data, rel, text)
        else:
            note(f"{rel}: no package-lock.json, npm audit skipped")
        if (data := run(["outdated", "--json"], folder)) is not None:
            findings += outdated_findings(data, rel, text)
    return add_standards(findings)
