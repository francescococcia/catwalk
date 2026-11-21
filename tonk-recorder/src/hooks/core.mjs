// Harness-neutral hook core (SPEC §6.3, contracts/hooks.md). Entry:
// handleEvent(payload, opts). Fail-open everywhere: exit 0, print nothing.
//
// Every hook (§6.1): resolve the space (--space > TONK_SPACE > nearest
// ancestor binding in tonk's spaces.json registry — read directly so the
// unbound no-op is <100 ms with zero tonk calls). No binding → exit 0,
// record nothing. Not a git repo → one warning per session, record nothing.
// Active branch ≠ main → no-op.

import fs from "node:fs";
import path from "node:path";
import { resolveSpace } from "./binding.mjs";
import {
  snapshotTree, diffTrees, isGitRepo, currentBranch, headCommit, projectName,
} from "../snapshot/tool.mjs";
import {
  dataRoot, paths, readTree, writeTree, loadSessionState, saveSessionState,
  stashPrompt, getPrompt, clearPrompts,
} from "./state.mjs";
import { writeChange, writeSessionStart, writeSessionEnd, writeAgent, writeSessionRole } from "./writer.mjs";
import { shouldCheckpoint } from "../writer/tool.mjs"; // R2 (landed)
import { buildSessionStartContext, updateNotice } from "./context.mjs";
import { buildTeamContext, buildUnconnectedContext } from "./team.mjs";
import { readIdentity, writeIdentity, defaultAgentName } from "./identity.mjs";
import { drain, sleepMs } from "./queue.mjs";
import { readRoles, resolveSessionRole, writeRoleAgents, rememberByHandFiles, withoutByHandFiles } from "./roles.mjs";
import { workFolder } from "./identity.mjs";
import { pull, push } from "./tonk.mjs";
import { formatOutput } from "./adapters.mjs";

const CHECKPOINT_INTERVAL_DEFAULT = 10; // SPEC §11.9 default

/** Version of the logic actually running: the installed plugin's manifest
 *  (never a hard-coded number — that makes every space look "newer"). */
function installedLogicVersion(env) {
  if (env.TONK_RECORDER_VERSION) return env.TONK_RECORDER_VERSION;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(env.PLUGIN_ROOT || process.cwd(), "plugin.json"), "utf8")).version;
    if (v) return String(v);
  } catch { /* not running from a plugin dir */ }
  return "0.0.0";
}

/**
 * One checkpoint (SPEC §6.5): put everything queued into tonk, then
 * `tonk pull` + `tonk push` — all as the single writer, because a pull moves
 * the local head just like a write does. A small random delay first keeps a
 * swarm from pushing in step. Fail-soft: records stay local/queued and go up
 * at the next checkpoint.
 */
export function syncNow(space, env = process.env, { timeoutMs = 20000, lockWaitMs = 20000 } = {}) {
  const jitter = Number(env.TONK_SYNC_JITTER ?? 3000);
  if (jitter > 0) sleepMs(Math.floor(Math.random() * jitter));
  const out = { writer: false, pulled: false, pushed: false };
  const d = drain(space, env, {
    waitMs: lockWaitMs,
    budgetMs: 3000, // in a busy swarm, don't hold this agent's turn writing everyone's backlog; pull/push regardless
    after: () => {
      out.pulled = pull(space, env, timeoutMs).code === 0;
      out.pushed = push(space, env, timeoutMs).code === 0;
    },
  });
  out.writer = d.writer;
  out.pending = d.pending;
  return out;
}

export async function handleEvent(payload, { env = process.env, spaceArg, now = () => new Date().toISOString() } = {}) {
  const harness = payload.harness || env.TONK_HARNESS || "vibe";
  const empty = { code: 0, stdout: "" };

  // §6.1 binding rule — first and fast (pure local fs reads).
  const binding = resolveSpace(payload.cwd, { env, spaceArg });
  if (!binding) {
    // Not connected to a space: record nothing, no state, no tonk calls.
    // But the plugin is only installed in folders someone ran `connect` in, so
    // ALWAYS tell the agent at launch that the recorder is here and how to
    // connect — otherwise "create a space" / "join this link" in chat goes
    // nowhere. (Do not make this silent again.)
    if (payload.event === "session-start") {
      return { code: 0, stdout: formatOutput(harness, "session-start", { additionalContext: buildUnconnectedContext({ env }) }) };
    }
    return empty;
  }
  const space = binding.space;

  const root = dataRoot(env);
  // R2's lockPathFor/dataRoot read process.env.DATA_ROOT — point them at ours
  if (!process.env.DATA_ROOT) process.env.DATA_ROOT = root;
  if (spaceArg && spaceArg !== env.TONK_SPACE) process.env.TONK_SPACE = spaceArg; // --space wins for child tonk calls
  const sessionId = payload.sessionId || "default";
  let sess = loadSessionState(root, sessionId);

  // Not a git repo → one warning per session, record nothing.
  if (!isGitRepo(payload.cwd)) {
    if (!sess.warnedNotGit) {
      sess.warnedNotGit = true;
      saveSessionState(root, sessionId, sess);
      process.stderr.write(`tonk-recorder: ${payload.cwd} is not a git repo; not recording (v1)\n`);
    }
    return empty;
  }

  // The GIT branch is recorded, never gated on: agents work on any branch
  // (master, agent/<name> worktrees, …).
  const branch = currentBranch(payload.cwd);

  // Who this agent is: the name `new` / `join` stored for this working
  // folder, else a derived name nobody had to choose.
  const identity = readIdentity(payload.cwd, env);
  const mine = identity && identity.space === space ? identity : null;
  const agentName =
    mine?.agent || env.TONK_AGENT_NAME || sess.agentName || defaultAgentName(payload.cwd, harness);
  sess.agentName = agentName;

  // The ROLE belongs to the session and is injected by the harness (roles.mjs):
  // Vibe names the session's agent on the hook call — `default` → builder, a
  // subagent spawned as `tonk-recorder:<role>` → that role. The role's
  // settings are read from the tonk. Cached per session; re-read at session
  // start and whenever the harness names a different agent.
  const agentKey = payload.agentName || "";
  if (payload.event === "session-start" || !sess.roles || (agentKey && sess.agentKey !== agentKey)) {
    sess.roles = readRoles(space, env);
    if (agentKey) sess.agentKey = agentKey;
  }
  const resolved = resolveSessionRole({ payload, sess, env, roles: sess.roles });
  const role = resolved.role;
  const recording = resolved.recording; // "manual" → the hooks record no turns for this session
  if (role && sess.role !== role) {
    sess.role = role;
    sess.roleWritten = false;
  }
  const interval = parseInt(env.TONK_CHECKPOINT_INTERVAL || `${CHECKPOINT_INTERVAL_DEFAULT}`, 10);
  // inside a hook: if the writer is busy for 5 s, skip — the next checkpoint does it
  const sync = () => syncNow(space, env, { lockWaitMs: 5000 });

  try {
    switch (payload.event) {
      case "session-start": {
        const tree = snapshotTree(payload.cwd, paths.index(root, sessionId));
        writeTree(root, sessionId, tree);
        sess.lastSnapshotAt = Date.now();
        sess.turns = sess.turns || 0;
        saveSessionState(root, sessionId, sess);
        // session record (started, changes: 0) — one local eval
        await writeSessionStart(space, {
          session: sessionId, agent: agentName, harness, project: projectName(payload.cwd), started: now(),
        }, env, root);
        // who is acting as what, in the space: once per session + role
        if (role && !sess.roleWritten) {
          await writeAgent(space, { name: agentName, role, harness, at: now() }, env);
          await writeSessionRole(space, { session: sessionId, role, agent: agentName, at: now() }, env);
          sess.roleWritten = true;
        }
        // keep the Vibe subagent files in step with the roles on the space, so
        // the main agent can spawn a subagent BY ROLE (picked up on /reload)
        try { writeRoleAgents(workFolder(payload.cwd), { space, roles: sess.roles, env }); } catch { /* best effort */ }
        saveSessionState(root, sessionId, sess);
        // checkpoint sync (network allowed here) + update check
        sync();
        sess.lastCheckpointAt = now();
        saveSessionState(root, sessionId, sess);

        const systemMessage = updateNotice({ space, localVersion: installedLogicVersion(env), env });
        // The agent is told, in order: which space it is in and what role it
        // plays, that role's instructions, who else is here and what waits
        // for it, how to coordinate — then decisions and recent changes.
        const teamContext = buildTeamContext({ space, agentName, role, harness, env, recording, roles: sess.roles });
        const additionalContext = teamContext + "\n" + buildSessionStartContext({
          space,
          agentName,
          lastSeenOtherAgentAt: sess.lastSeenOtherAgentAt || null,
          ageTurns: 0,
          env: { ...env, __CWD: payload.cwd },
          cwd: payload.cwd,
        });
        return { code: 0, stdout: formatOutput(harness, "session-start", { additionalContext, systemMessage }) };
      }

      case "pre-agent": {
        if (payload.turnId != null && payload.prompt != null) {
          stashPrompt(root, sessionId, payload.turnId, payload.prompt, now());
        }
        return empty; // no rewrite, no context
      }

      case "post-agent": {
        sess.turns = (sess.turns || 0) + 1;
        // Subagent sessions never get session_start (Vibe), so baseline their
        // first turn on the parent session's snapshot (SPEC §4.1, §11.4).
        const prev = readTree(root, sessionId) ?? (payload.parentSessionId ? readTree(root, payload.parentSessionId) : null);
        const next = snapshotTree(payload.cwd, paths.index(root, sessionId));
        if (!prev) {
          writeTree(root, sessionId, next); // session-start was missed; record nothing this turn
          saveSessionState(root, sessionId, sess);
          return empty;
        }
        // a subagent's session has no session-start: say who it is on its first turn
        if (role && !sess.roleWritten) {
          await writeSessionRole(space, { session: sessionId, role, agent: agentName, at: now() }, env);
          sess.roleWritten = true;
        }
        let d = diffTrees(payload.cwd, prev, next);
        // a role recorded BY HAND (security): the hooks put nothing of this
        // turn into the space — the agent adds its own account, with discretion.
        // Its files are remembered (paths only) so they are also left out of
        // the next recorded turn of a session sharing this folder (its parent).
        if (recording === "manual") rememberByHandFiles(root, d.files || []);
        else d = withoutByHandFiles(root, d, sess.lastSnapshotAt || 0);
        if (!d.empty && recording !== "manual") {
          const rec = {
            session: sessionId,
            turn: payload.turnId || `turn-${sess.turns}`,
            parentSession: payload.parentSessionId || undefined,
            agent: agentName,
            harness,
            // a turn whose prompt the harness never showed us (subagent turns) still records
            prompt: (payload.turnId != null ? getPrompt(root, sessionId, payload.turnId) : null) ?? "(prompt not captured)",
            response: payload.responseText ?? null,
            project: projectName(payload.cwd),
            branch: branch || "(detached)",
            base: prev,
            head: next,
            commit: headCommit(payload.cwd) || "(no commits yet)", // a brand-new project still records
            files: d.files,
            linesAdded: d.totals.added,
            linesRemoved: d.totals.removed,
            diff: d.diff,
            redacted: false,
            at: now(),
          };
          const w = await writeChange(space, rec, env, root); // ONE local tonk eval --no-sync, no network
          if (w.written) sess.changes = (sess.changes || 0) + 1;
        }
        writeTree(root, sessionId, next); // snapshot becomes prev
        sess.lastSnapshotAt = Date.now();
        // checkpoint every N turns (default 10) — the ONLY post-agent network path
        if (shouldCheckpoint(sess.turns, interval)) {
          sync();
          sess.lastCheckpointAt = now();
        }
        saveSessionState(root, sessionId, sess);
        return empty; // post-agent: no stdout
      }

      case "session-end": {
        const ended = now();
        // count changes this session from local state: count written turns
        // (tracked implicitly by prompts/turns; we store the counter on the
        //  session state — incremented per written change below)
        await writeSessionEnd(space, {
          session: sessionId, agent: agentName, harness,
          project: projectName(payload.cwd), ended,
          changes: sess.changes || 0,
        }, env, root);
        sync();
        sess.lastCheckpointAt = ended;
        clearPrompts(root, sessionId);
        saveSessionState(root, sessionId, sess);
        return empty; // session-end output ignored
      }

      default:
        return empty;
    }
  } catch (err) {
    // fail open (contracts/hooks.md): never block the harness
    process.stderr.write(`tonk-recorder: hook ${payload.event} failed open: ${err && err.message ? err.message : err}\n`);
    return empty;
  }
}
