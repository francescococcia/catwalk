// What the hook hands the agent at session start about the SPACE AS A TEAM:
// who it is and what role it plays, that role's instructions, who else is in
// the space, what is waiting for its role, and exactly how to coordinate.
// Agents never message each other directly — they read and add records
// (packs/roles.notation). Read from the local copy; no network.

import { queryJson } from "./tonk.mjs";
import { wrapperCommand } from "./identity.mjs";

const latestBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k == null) continue;
    const prev = m.get(k);
    if (!prev || String(r.at || "") >= String(prev.at || "")) m.set(k, r);
  }
  return m;
};

export function readTeam(space, env) {
  const roles = latestBy(queryJson(space, "role", [], env), "name");
  const agents = latestBy(queryJson(space, "agent", [], env), "name");
  const tasks = queryJson(space, "task", [], env);
  const statusByTask = latestBy(queryJson(space, "task-status", [], env), "task");
  const notes = queryJson(space, "note", [], env);
  return { roles, agents, tasks, statusByTask, notes };
}

const one = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** The note for a project that is connected to a space. */
export function buildTeamContext({ space, agentName, role, harness, env, wrapper = wrapperCommand(env) }) {
  const team = readTeam(space, env);
  const roleNames = [...team.roles.keys()].sort();
  const mine = role ? team.roles.get(role) : null;
  const L = [];
  // name the space on every command: a git worktree is not a folder tonk has bound
  const T = `tonk --space ${space}`;

  L.push(`# You are working inside the Tonk space "${space}"`);
  L.push("");
  L.push(
    `Everything you change in this project is recorded into this space automatically at the end of each turn — ` +
      `you do nothing for that. The space is also how you work with the other agents on this project: ` +
      `you do not message them, you read and add records in the space.`,
  );
  L.push("");
  L.push(`You are agent \`${agentName}\`${role ? `, playing the role \`${role}\`` : ""}.`);
  L.push(
    `In your first reply, tell the user in one line: "Recording to Tonk space ${space} as ${agentName}` +
      `${role ? ` (${role})` : ""}."`,
  );

  // (a) + (b): its role and that role's instructions
  L.push("");
  if (mine) {
    L.push(`## Your role: ${role}`);
    L.push("");
    L.push(String(mine.instructions || "").trim());
    L.push("");
    L.push(`Follow these. Re-read them any time: \`tonk query role --where name=${role}\``);
  } else if (roleNames.length) {
    L.push(`## You have no role yet`);
    L.push("");
    L.push(
      role
        ? `Your role \`${role}\` is not installed on this space. Installed roles:`
        : `Before doing any work, take a role. Ask the user which one if they have not said. Installed roles:`,
    );
    for (const n of roleNames) L.push(`- \`${n}\` — ${one(team.roles.get(n).instructions, 140)}`);
    L.push("");
    L.push(`Take one with: \`${wrapper} role <name>\` (it registers you in the space), then follow its instructions.`);
  } else {
    L.push(`## Roles`);
    L.push("");
    L.push(`This space has no roles installed, so there is nothing to coordinate through yet; just work normally.`);
  }

  // (c): the others, and what is waiting
  if (roleNames.length) {
    const others = [...team.agents.values()].filter((a) => a.name !== agentName);
    L.push("");
    L.push(`## Other agents in this space`);
    L.push("");
    L.push(others.length ? others.map((a) => `- \`${a.name}\` — ${a.role} (${a.harness || "?"})`).join("\n") : "(none registered yet)");

    const open = (t) => {
      const s = team.statusByTask.get(t.title);
      return !s || (s.status !== "done");
    };
    const forMe = team.tasks.filter((t) => role && t.for === role && open(t));
    L.push("");
    L.push(`## Tasks waiting for ${role ? `your role (${role})` : "a role"}`);
    L.push("");
    L.push(
      forMe.length
        ? forMe
            .map((t) => {
              const s = team.statusByTask.get(t.title);
              const state = s ? `${s.status} by ${s.by}${s.note ? `: ${one(s.note, 80)}` : ""}` : "open";
              return `- "${t.title}" [${state}] — from ${t.by}. ${one(t.detail, 160)}`;
            })
            .join("\n")
        : "(none)",
    );
    const notes = team.notes
      .filter((n) => role && (n.to === role || n.to === "all") && n.from !== agentName)
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
      .slice(0, 10);
    L.push("");
    L.push(`## Notes left for you`);
    L.push("");
    L.push(notes.length ? notes.map((n) => `- from ${n.from} (${n.at}): ${one(n.body, 240)}`).join("\n") : "(none)");

    L.push("");
    L.push(`## How to coordinate with the other agents`);
    L.push("");
    L.push(`Do it through records, with plain \`tonk\` commands. Use the current UTC time for \`at\`. Records are add-only: never edit one, add a newer one.`);
    L.push("");
    L.push("```sh");
    L.push(`# see what is there`);
    L.push(`${T} query task --where for=${role || "<role>"}      # tasks for a role`);
    L.push(`${T} query task-status                       # who claimed / finished what (latest per task wins)`);
    L.push(`${T} query note --where to=${role || "<role>"}       # notes for a role`);
    L.push(`${T} query agent                             # who is here and in which role`);
    L.push("");
    L.push(`# claim a task before you start it, so nobody else takes it`);
    L.push(`${T} eval --no-sync -c 'task-status!: { task: "<exact task title>", status: "claimed", by: "${agentName}", note: "<one line>", at: "<UTC time>" }'`);
    L.push(`# when finished (or stuck): status "done" or "blocked", note = what changed / what blocks you`);
    L.push(`${T} eval --no-sync -c 'task-status!: { task: "<exact task title>", status: "done", by: "${agentName}", note: "<one line>", at: "<UTC time>" }'`);
    L.push(`# ask another role for work`);
    L.push(`${T} eval --no-sync -c 'task!: { title: "<one line>", detail: "<what done looks like>", for: "<role>", by: "${agentName}", at: "<UTC time>" }'`);
    L.push(`# tell a role something`);
    L.push(`${T} eval --no-sync -c 'note!: { to: "<role or all>", from: "${agentName}", body: "<message>", at: "<UTC time>" }'`);
    L.push(`# send your records to the others and fetch theirs now (otherwise it happens every 10 turns)`);
    L.push(`${wrapper} sync`);
    L.push("```");
    L.push("");
    L.push(`If a \`tonk eval\` fails with a "Version mismatch" or lock error, another write was in flight: run it again.`);
  }
  return L.join("\n") + "\n";
}

/** The note for a project that is NOT connected to a space. */
export function buildUnconnectedContext({ env = process.env, wrapper = wrapperCommand(env) } = {}) {
  return [
    `# Tonk recorder is installed, but this project is not connected to a Tonk space`,
    ``,
    `Nothing is being recorded, and there is no space, no role and no other agent to coordinate with yet. If the user asks to create a space, join a space, gives you a Tonk link, or talks about "the space", roles or recording as if they existed, connect the project FIRST, before any other work, by running ONE of these in the project folder (ask which, if it is not clear):`,
    ``,
    "```sh",
    `${wrapper} new <space-name> [--role <role>]     # create a space for this project`,
    `${wrapper} join '<link>' [--role <role>]        # join the space a link points to`,
    "```",
    ``,
    `\`new\` makes a space that is local to this machine: no account, no sign-in. \`join\` needs no sign-in either. Only the first \`${wrapper} invite\` opens a Tonk page in the user's browser, to attach the space to their account (they sign in there if asked) — when you run it, tell them to approve it, and wait; never repeat the link it prints anywhere but to the user.`,
    ``,
    `After it finishes, run \`${wrapper} role\` to see your role and the roles installed, and \`tonk query role\` to read their instructions; from your next session this note will carry your role's instructions and the other agents' tasks. The folder does not need to be a git repository yet; \`new\` and \`join\` make it one.`,
    ``,
    `A link is a key to the space: pass it to the command exactly as given, and never repeat it back, write it to a file, or commit it. Recording starts on the next turn; no restart is needed. Roles installed by default: builder, reviewer.`,
    ``,
  ].join("\n");
}
