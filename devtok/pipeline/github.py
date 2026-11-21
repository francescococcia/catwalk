"""Fetch a pull request (metadata, commits, file stats, unified diff) from the GitHub REST API.

The token, if any, comes from the caller (the phone's GitHub sign-in) and is only used for these requests:
it is never written to disk or logged.
"""
import json
import re
import urllib.error
import urllib.request

API = "https://api.github.com"
URL_RE = re.compile(r"github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)")


class GitHubError(Exception):
    pass


def parse_pr_url(url):
    m = URL_RE.search(url or "")
    if not m:
        raise GitHubError("Not a GitHub pull request link (expected https://github.com/<owner>/<repo>/pull/<number>)")
    return m.group(1), m.group(2).removesuffix(".git"), int(m.group(3))


def _get(path, token=None, accept="application/vnd.github+json", raw=False):
    req = urllib.request.Request(API + path, headers={
        "Accept": accept, "User-Agent": "devtok-prototype", "X-GitHub-Api-Version": "2022-11-28",
        **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            remaining = r.headers.get("X-RateLimit-Remaining")
    except urllib.error.HTTPError as e:
        msg = e.read()[:300].decode("utf-8", "replace")
        if e.code == 404:
            raise GitHubError("PR not found, or it is private and you are not signed in to GitHub")
        if e.code in (401, 403) and "rate limit" in msg.lower():
            raise GitHubError("GitHub rate limit reached: sign in to GitHub in the app to raise it")
        if e.code == 401:
            raise GitHubError("GitHub rejected the token: sign in again")
        raise GitHubError(f"GitHub HTTP {e.code}: {msg}")
    return (body.decode("utf-8", "replace") if raw else json.loads(body)), remaining


def fetch_pr(url, token=None, max_commits=250):
    owner, repo, num = parse_pr_url(url)
    base = f"/repos/{owner}/{repo}/pulls/{num}"
    pr, _ = _get(base, token)
    commits, page = [], 1
    while len(commits) < min(max_commits, pr.get("commits", 0) or max_commits) and page <= 3:
        batch, _ = _get(f"{base}/commits?per_page=100&page={page}", token)
        if not batch:
            break
        commits += batch
        page += 1
    files, page = [], 1
    while page <= 30:  # GitHub returns up to 3000 files
        batch, _ = _get(f"{base}/files?per_page=100&page={page}", token)
        files += batch
        if len(batch) < 100:
            break
        page += 1
    diff, remaining = _get(base, token, accept="application/vnd.github.v3.diff", raw=True)
    # repository context (so the map can show what the change connects to, beyond the diff)
    tree, readme = [], ""
    try:
        ref = (pr.get("base") or {}).get("sha") or (pr.get("base") or {}).get("ref") or "HEAD"
        t, remaining = _get(f"/repos/{owner}/{repo}/git/trees/{ref}?recursive=1", token)
        tree = [x["path"] for x in t.get("tree", []) if x.get("type") == "blob"]
        readme, remaining = _get(f"/repos/{owner}/{repo}/readme", token, accept="application/vnd.github.raw", raw=True)
    except GitHubError:
        pass
    meta = {
        "repo": f"{owner}/{repo}", "number": num, "title": pr.get("title"), "url": pr.get("html_url"),
        "author": (pr.get("user") or {}).get("login"), "created_at": pr.get("created_at"), "merged_at": pr.get("merged_at"),
        "state": pr.get("state"), "draft": pr.get("draft"), "head_sha": (pr.get("head") or {}).get("sha"),
        "labels": [l.get("name") for l in pr.get("labels", [])], "body": pr.get("body") or "",
        "changed_files": pr.get("changed_files"), "additions": pr.get("additions"), "deletions": pr.get("deletions"),
        "files": [{"filename": f["filename"], "additions": f.get("additions", 0), "deletions": f.get("deletions", 0)} for f in files],
        "commits": [{"sha": c["sha"], "author": ((c.get("commit") or {}).get("author") or {}).get("name"),
                     "date": ((c.get("commit") or {}).get("author") or {}).get("date"),
                     "message": (c.get("commit") or {}).get("message", "")} for c in commits],
        "private": (pr.get("base") or {}).get("repo", {}).get("private", False),
        "repo_tree": tree, "readme": readme[:6000],
    }
    return meta, diff, remaining


if __name__ == "__main__":
    import sys
    m, d, rem = fetch_pr(sys.argv[1])
    print(m["title"], m["changed_files"], len(m["commits"]), len(d), "bytes diff; rate remaining", rem)
