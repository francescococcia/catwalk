// Per-harness stdin/stdout adapters (contracts/hooks.md, W0 landed).
// Neutral payload (core.mjs consumes):
//   { event, sessionId, parentSessionId?, transcriptPath?, cwd,
//     prompt?, turnId?, agentName?, responseText?, stopHookActive?, reason? }
// Vibe raw: hook_event_name session_start|pre_agent|post_agent|session_end +
// session_id, parent_session_id?, transcript_path, cwd, + per event
// prompt/turn_id (pre_agent), agent_name/turn_id/response_text (post_agent).
// The Claude runtime adapter (adapters/claude, H2) already normalises CC
// payloads onto the neutral shape before exec'ing `tool.mjs hook <event>`.
//
// stdout (contracts/hooks.md):
//   Vibe session-start:  {"hook_specific_output": {"additional_context": "…"}, "system_message"?: "…"}
//   Claude SessionStart: {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}, "systemMessage"?: "…"}
//   all other events:    empty stdout, exit 0.

const EVENT_MAP = {
  session_start: "session-start", "session-start": "session-start", SessionStart: "session-start",
  pre_agent: "pre-agent", "pre-agent": "pre-agent", UserPromptSubmit: "pre-agent",
  post_agent: "post-agent", "post-agent": "post-agent", Stop: "post-agent",
  session_end: "session-end", "session-end": "session-end", SessionEnd: "session-end",
};

export function normalizeEvent(name) {
  const n = EVENT_MAP[name];
  if (!n) throw new Error(`unknown hook event: ${name}`);
  return n;
}

export function parsePayload(raw, { cwdFallback } = {}) {
  let j = {};
  if (raw && raw.trim()) {
    try {
      j = JSON.parse(raw);
    } catch {
      j = {};
    }
  }
  return {
    event: normalizeEvent(j.hook_event_name || j.event || ""),
    sessionId: j.session_id ?? null,
    parentSessionId: j.parent_session_id ?? null,
    transcriptPath: j.transcript_path ?? null,
    cwd: j.cwd || cwdFallback || process.cwd(),
    prompt: j.prompt,
    turnId: j.turn_id ?? null,
    agentName: j.agent_name ?? null,
    responseText: j.response_text ?? null,
    stopHookActive: j.stop_hook_active ?? false,
    reason: j.reason ?? null,
    harness: j.harness || null,
  };
}

export function formatOutput(harness, event, { additionalContext, systemMessage } = {}) {
  if (event !== "session-start") return "";
  // The context MUST be nested, in both harnesses — a top-level key is
  // silently ignored and the agent is told nothing:
  //   Vibe   (app_server/_host_hooks.py, _session_start_output):
  //            parsed["hook_specific_output"]["additional_context"], parsed["system_message"]
  //   Claude Code SessionStart:
  //            hookSpecificOutput.{hookEventName, additionalContext}, systemMessage
  if (harness === "claude") {
    const out = {};
    if (additionalContext) out.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext };
    if (systemMessage) out.systemMessage = systemMessage;
    return Object.keys(out).length ? JSON.stringify(out) + "\n" : "";
  }
  const out = {};
  if (additionalContext) out.hook_specific_output = { additional_context: additionalContext };
  if (systemMessage) out.system_message = systemMessage;
  return Object.keys(out).length ? JSON.stringify(out) + "\n" : "";
}
