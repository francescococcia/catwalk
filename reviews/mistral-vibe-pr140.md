# Vigil review: mistralai/mistral-vibe PR #140

**PR:** https://github.com/mistralai/mistral-vibe/pull/140 · "feat: add OpenTelemetry observability integration" · 24 files, +3435/-170 · reviewed 2026-11-21 at commit `2252d48`
**Method:** Vigil static rules (`harness/vigil.py scan --no-llm`) over the PR's code, plus a short manual read of the telemetry path. No code from the PR was run and no attack was attempted: there is no running app to prove against.

## Result: no blocking findings in the PR's files

| Check | Result |
|---|---|
| Secrets in code (provider keys, private keys, hard-coded credentials) | none in the changed files |
| Dynamic code execution, SQL built from strings, raw HTML | none |
| Text trying to steer AI reviewers | none |

**Calibration note (honest):** the first pass flagged 11 "hardcoded secrets" in `vibe/core/observability/semconv.py` and `vibe/core/llm/backend/*.py`. All were OpenTelemetry attribute **names** (e.g. `TOKENS = "gen_ai.usage.input_tokens"`), plus 3 env-var **names** (`api_key_env_var="MISTRAL_API_KEY"`) elsewhere in the repo. Vigil's rule was fixed to skip dotted identifiers and upper-case env-var names; those are now quiet. The one remaining hit is outside the PR, `tests/onboarding/test_ui_onboarding.py:45`, a test value (`sk-onboarding-test-key`): not a real key.

## Manual review: one privacy point worth a look (medium)

- **User prompts are exported as span attributes when tracing is on.** `vibe/core/observability/tracing.py` sets `metadata["input"] = {"prompt": …}` (lines ~500 and ~543) and writes it to the span as `input-json` (line ~122). The OpenTelemetry GenAI conventions treat message content as **opt-in** because prompts can carry code, secrets and personal data.
  - Mitigating: observability is **off by default** (`enabled: bool = False`).
  - Suggestion: a separate flag for content capture (default off) and/or truncation and redaction before export, documented in `docs/observability/usage.md`.
  - Standards: OWASP A09:2021 Security Logging and Monitoring Failures / CWE-532 (sensitive information in log files); ISO 27001:2022 A.8.12 Data leakage prevention.
- **Default OTLP endpoint is `http://localhost:4318`.** Fine locally; if a user points it to a remote collector over plain `http://`, prompts would travel unencrypted. A warning for non-loopback `http://` endpoints would help.
- **File exporter** writes JSONL to disk: with content capture on, prompts end up in plain files; worth a note on retention.

## What Vigil did not cover
Python-specific taint analysis, dependency vulnerabilities in `uv.lock` (Vigil's dependency check is npm-only today), and runtime behaviour. This is a review aid, not an audit.
