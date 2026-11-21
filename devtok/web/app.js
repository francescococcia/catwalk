// DevTok web: same flow as the iPhone app. All PR/model text goes in via textContent (prompt-injection / XSS safe).
"use strict";
const ROLES = { technical_engineer: "Engineer", team_lead: "Team lead", paying_manager: "Manager" };
const $ = (id) => document.getElementById(id);
const S = { source: null, role: "technical_engineer", manifest: null, security: null };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- start screen ----------
$("jobForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("jobError").textContent = "";
  const headers = { "Content-Type": "application/json" };
  const token = $("token").value.trim();
  if (token) headers["X-GitHub-Token"] = token;
  $("token").value = ""; // never kept around
  try {
    const st = await getJSON("/api/jobs", { method: "POST", headers, body: JSON.stringify({ pr_url: $("prUrl").value.trim() }) });
    poll(st.job_id);
  } catch (e) { $("jobError").textContent = e.message; }
});

async function poll(jid) {
  try {
    const st = await getJSON(`/api/jobs/${encodeURIComponent(jid)}`);
    const ol = $("progress");
    ol.replaceChildren(...st.stages.map((s) => {
      const li = el("li", null, `${s.label}${s.detail ? " - " + s.detail : ""}`);
      li.dataset.s = s.status;
      return li;
    }));
    if (st.status === "error") { $("jobError").textContent = st.error || "Job failed"; return; }
    if (st.status === "done") return openFeed({ kind: "job", id: jid }, st.roles_ready[0] || st.roles[0]);
    setTimeout(() => poll(jid), 1500);
  } catch (e) { $("jobError").textContent = e.message; }
}

async function listJobs() {
  try {
    const jobs = await getJSON("/api/jobs");
    $("jobs").replaceChildren(...jobs.filter((j) => j.status === "done").map((j) => {
      const b = el("button", null, j.pr && j.pr.title ? `${j.pr.repo || ""} #${j.pr.number || ""} - ${j.pr.title}` : j.pr_url);
      b.type = "button";
      b.onclick = () => openFeed({ kind: "job", id: j.job_id }, S.role);
      return b;
    }));
    if (!$("jobs").children.length) $("jobs").append(el("p", "muted", "No finished jobs on this server yet."));
  } catch { $("jobs").replaceChildren(el("p", "muted", "Job list unavailable.")); }
}
$("fixtureBtn").onclick = () => openFeed({ kind: "fixture" }, S.role);
$("fileIn").onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const m = JSON.parse(await f.text());
    openFeed({ kind: "file", manifest: m }, m.role || S.role);
  } catch (e) { alert("Not a manifest JSON: " + e.message); }
};
$("backBtn").onclick = () => { stopAll(); $("feedScreen").hidden = true; $("start").hidden = false; listJobs(); };

// ---------- feed ----------
async function openFeed(source, role) {
  S.source = source;
  try {
    if (!S.security) S.security = await getJSON("/api/security").catch(() => null);
    await loadRole(role in ROLES ? role : "technical_engineer");
    $("start").hidden = true;
    $("feedScreen").hidden = false;
    $("feed").focus();
  } catch (e) { $("jobError").textContent = "Could not load the feed: " + e.message; }
}

async function loadRole(role) {
  const src = S.source;
  S.manifest = src.kind === "file" ? src.manifest
    : await getJSON(src.kind === "job" ? `/api/jobs/${encodeURIComponent(src.id)}/manifest/${role}` : `/web/fixtures/manifest_${role}.json`);
  S.role = S.manifest.role || role;
  renderRoles();
  renderFeed();
}

function renderRoles() {
  $("roles").replaceChildren(...Object.entries(ROLES).map(([k, label]) => {
    const b = el("button", null, label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(k === S.role));
    b.disabled = S.source.kind === "file" && k !== S.role; // a single file holds one role
    b.onclick = () => { stopAll(); loadRole(k).catch((e) => alert(e.message)); };
    return b;
  }));
}

let observer;
function renderFeed() {
  stopAll();
  const feed = $("feed");
  const pages = [];
  for (const it of S.manifest.items || []) {
    if (it.type === "video") pages.push(reelPage(it));
    else if (it.type === "quiz") pages.push(quizPage(it));
    else {
      if (S.security && S.security.slide) pages.push(vigilPage(S.security.slide, S.security.standards || []));
      pages.push(verdictPage());
    }
  }
  feed.replaceChildren(...pages);
  feed.scrollTop = 0;
  observer = new IntersectionObserver((entries) => entries.forEach((en) => {
    const v = en.target.querySelector("video");
    if (!v) return;
    if (en.isIntersecting) v.play().catch(() => {}); else v.pause();
  }), { root: feed, threshold: 0.6 });
  pages.forEach((p) => observer.observe(p));
}
function stopAll() {
  if (observer) observer.disconnect();
  document.querySelectorAll("video").forEach((v) => v.pause());
  if (window.speechSynthesis) speechSynthesis.cancel();
}

function reelPage(r) {
  const p = document.querySelector("#tReel").content.firstElementChild.cloneNode(true);
  const v = p.querySelector("video");
  v.src = "/media/" + encodeURIComponent(r.video);
  p.querySelector(".title").textContent = r.title;
  p.querySelector(".hook").textContent = r.hook;
  const sub = p.querySelector(".sub");
  const shots = r.shots || [];
  v.addEventListener("timeupdate", () => {
    const s = shots.find((s) => v.currentTime >= s.t_start && v.currentTime < s.t_end);
    sub.textContent = s ? (s.caption || s.narration || "") : "";
  });
  const btn = p.querySelector(".unmute");
  btn.onclick = () => { v.muted = !v.muted; btn.textContent = v.muted ? "Tap for sound" : "Mute"; };
  v.onclick = () => (v.paused ? v.play() : v.pause());
  return p;
}

function quizPage(q) {
  const p = el("section", "page text");
  p.append(el("p", "kicker", "Quick check"));
  for (const qu of q.questions || []) {
    p.append(el("h2", null, qu.prompt));
    const expl = el("p", "muted");
    const btns = qu.choices.map((c, i) => {
      const b = el("button", "choice", c);
      b.type = "button";
      b.onclick = () => {
        btns.forEach((x, j) => { x.disabled = true; if (j === qu.correct_index) x.classList.add("right"); });
        if (i !== qu.correct_index) b.classList.add("wrong");
        expl.textContent = qu.explanation;
      };
      return b;
    });
    p.append(...btns, expl);
  }
  const skip = el("button", "ghost skip", "Skip");
  skip.type = "button";
  skip.onclick = () => next(p);
  p.append(skip);
  return p;
}

function diffBlock(diff) {
  const pre = el("pre", "diff");
  for (const line of String(diff || "").replace(/\r/g, "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    pre.append(el("span", line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : null, line || " "));
  }
  return pre;
}
function box(title, ...children) {
  const b = el("div", "box");
  b.append(el("h3", null, title), ...children);
  return b;
}
function sevClass(s) { return { critical: "bad", high: "bad", medium: "warn" }[s] || ""; }

function vigilPage(sl, standards) {
  const p = el("section", "page text");
  p.append(el("p", "kicker", "Vigil security reel"), el("h2", null, "Vigil proved it"));
  p.append(el("p", null, sl.text));
  if (sl.explanation) p.append(el("p", "muted", sl.explanation));
  const ev = sl.evidence || {};
  p.append(box("Evidence (redacted)", el("pre", null, `${ev.request || ""}\nHTTP ${ev.status_code ?? "?"}\n${ev.body_redacted || ""}`)));
  if (sl.control) p.append(box("Control", el("p", null, sl.control)));
  if (sl.diff) p.append(box(`Fix${sl.file ? " - " + sl.file : ""}`, diffBlock(sl.diff)));
  const badges = el("div", "badges");
  badges.append(el("span", "pill bad", "PROVEN"), el("span", null, "->"),
    el("span", `pill ${sl.reattack === "BLOCKED" ? "ok" : "warn"}`, `re-attack: ${sl.reattack || "not run"}`), el("span", null, "->"),
    el("span", `pill ${sl.verdict === "FIXED" ? "ok" : "warn"}`, sl.verdict || "?"));
  p.append(box("Result", badges));
  if (standards.length) {
    const chips = el("div", "badges");
    chips.append(...standards.map((s) => el("span", "pill", s)));
    p.append(box("Standards", chips));
  }
  const say = el("button", "ghost skip", "Play voice-over");
  say.type = "button";
  say.onclick = () => speak([`Vigil proved it. ${sl.text}`, sl.reattack ? `Re-attack: ${sl.reattack}. Verdict: ${sl.verdict}.` : ""].join(" "));
  p.append(say, el("p", "muted", `Source: ${sl.source}`));
  return p;
}
function speak(text) {
  const fallback = () => { if (window.speechSynthesis) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };
  const a = new Audio("/tts?text=" + encodeURIComponent(text)); // server TTS if one exists, else browser voice
  a.onerror = fallback;
  a.play().catch(fallback);
}

function verdictPage() {
  const m = S.manifest, pr = m.pr || {}, sum = m.summary || {};
  const p = el("section", "page text");
  p.append(el("p", "kicker", `${pr.repo || ""} #${pr.number ?? ""}`), el("h2", null, pr.title || "Pull request"));
  if (sum.headline) p.append(el("p", null, sum.headline));
  if (pr.stats) p.append(el("p", "muted", `${pr.stats.files} files, +${pr.stats.added} -${pr.stats.deleted}${pr.author ? ", by " + pr.author : ""}`));
  if (sum.why) p.append(box("Why", el("p", null, sum.why)));
  if (sum.what_changed && sum.what_changed.length) {
    const ul = el("ul");
    ul.append(...sum.what_changed.map((t) => el("li", null, t)));
    p.append(box("What changed", ul));
  }
  if (sum.risks && sum.risks.length) {
    const ul = el("ul", "checklist");
    ul.append(...sum.risks.map((r) => { const li = el("li"); li.append(el("span", `pill ${sevClass(r.severity)}`, r.severity || "risk"), el("span", null, r.title + (r.mitigation ? " - " + r.mitigation : ""))); return li; }));
    p.append(box("Risks", ul));
  }
  if (sum.checklist && sum.checklist.length) {
    const ul = el("ul", "checklist");
    ul.append(...sum.checklist.map((c) => { const li = el("li"); li.append(el("span", null, (c.blocking ? "[blocking] " : "") + c.text)); return li; }));
    p.append(box("Reviewer checklist", ul));
  }
  const threats = (S.security && S.security.threats) || [];
  if (threats.length) {
    const ul = el("ul", "checklist");
    ul.append(...threats.map((t) => {
      const li = el("li");
      li.append(el("span", "tid", t.id), el("span", `pill ${sevClass(t.severity)}`, t.severity),
        el("span", `pill ${t.status === "verified" ? "ok" : t.status === "mitigated" ? "warn" : "bad"}`, t.status));
      if (t.source === "vigil") li.append(el("span", "pill vigil", "Vigil"));
      li.append(el("span", null, t.title));
      return li;
    }));
    p.append(box("Security checklist", ul));
  }
  if (sum.verdict_suggestion) p.append(el("p", "muted", `Suggested: ${sum.verdict_suggestion} (a suggestion only - you decide)`));
  const out = el("p", "decision");
  const row = el("div", "decide");
  const mk = (cls, label, msg) => { const b = el("button", cls, label); b.type = "button"; b.onclick = () => { out.textContent = msg; }; return b; };
  row.append(mk("reject", "Request changes", "Changes requested (simulated)."), mk("approve", "Approve PR", "Approved with confidence (simulated)."));
  p.append(row, out);
  return p;
}

function next(page) {
  const n = page.nextElementSibling;
  if (n) n.scrollIntoView({ behavior: "smooth" });
}
document.addEventListener("keydown", (e) => {
  if ($("feedScreen").hidden || e.target.tagName === "INPUT") return;
  const f = $("feed");
  if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); f.scrollBy({ top: f.clientHeight, behavior: "smooth" }); }
  if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); f.scrollBy({ top: -f.clientHeight, behavior: "smooth" }); }
});

listJobs();
