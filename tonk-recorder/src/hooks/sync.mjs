// Checkpoint sync (SPEC §6.5): `tonk pull` then, after a small random delay
// (0–3 s) so a swarm does not push in step, `tonk push`. Hard timeout
// (default 20 s each); on timeout or failure the hook returns normally —
// everything is already in tonk locally and goes up at the next checkpoint.
// Network is touched ONLY here (session-start, session-end, every N turns,
// on-demand `sync`) — never on the per-turn post-agent path.

import { pull, push } from "./tonk.mjs";

export async function checkpointSync(space, env, { timeoutMs = 20000, maxDelayMs = 3000, rand = Math.random } = {}) {
  const out = { pulled: false, pushed: false, errors: [] };
  const p = pull(space, env, timeoutMs);
  out.pulled = p.code === 0 && !p.timedOut;
  if (p.code !== 0) out.errors.push(`pull: ${p.timedOut ? "timeout" : `exit ${p.code}`} ${p.stderr.trim()}`.trim());
  const delay = Math.floor(rand() * (maxDelayMs + 1));
  if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  const s = push(space, env, timeoutMs);
  out.pushed = s.code === 0 && !s.timedOut;
  if (s.code !== 0) out.errors.push(`push: ${s.timedOut ? "timeout" : `exit ${s.code}`} ${s.stderr.trim()}`.trim());
  return out;
}
