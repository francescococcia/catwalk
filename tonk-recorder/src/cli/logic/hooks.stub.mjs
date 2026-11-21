// STUB for the R3 hook runtime (agent r1-r3-r5 owns src/hooks/, entry
// src/hooks/tool.mjs — INTEGRATION POINT contracts/hooks.md + layout.md).
// The single-file build embeds the real src/hooks/tool.mjs when it exists and
// this stub until then. Contract: export async runHook(event, payload, ctx)
// → returns the hook's stdout object ({} = no output), never throws.
//
// Stub behaviour (SPEC §6.3, §6.1, §3.4):
//   - unbound folder → {} immediately (no-op, exit 0)
//   - session-start → B3 update check → { system_message } when a newer
//     trusted tool record exists, plus additional_context with the decision
//     instructions (R4 text; richer context is R3's job)
//   - pre-agent / post-agent / session-end → {} (recording is R3's job)
export async function runHook(event, payload, ctx) {
  try {
    if (event !== "session-start") return {};
    if (ctx && typeof ctx.isBound === "function" && !(await ctx.isBound())) return {}; // §6.1 no-op
    const out = {};
    if (ctx && typeof ctx.checkForUpdate === "function") {
      const upd = await ctx.checkForUpdate(ctx.version);
      if (upd && upd.notice) out.system_message = upd.notice; // SPEC §3.4 one-line notice
    }
    if (ctx && ctx.instructions) {
      out.hook_specific_output = {
        additional_context: "Tonk recorder is active for this space.\n\n" + String(ctx.instructions).trim(),
      };
    }
    return out;
  } catch {
    return {}; // hooks fail open (SPEC §4.1)
  }
}
