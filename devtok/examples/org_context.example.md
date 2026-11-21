# Example org context (INVENTED numbers — shows the format the team-lead and manager reels can cite)

Company: "Acme Assist", a SaaS support copilot built on pydantic-ai. Users upload PDFs/images (contracts,
invoices, screenshots) and ask questions about them.

## Teams / ownership
- Agents Platform team (lead: Dana): owns `pydantic_ai/messages.py`, the message model, OpenTelemetry instrumentation.
- Provider Integrations team (lead: Ravi): owns `pydantic_ai/models/*` (OpenAI, Anthropic, Google, Bedrock, xAI...).
- Frontend team (lead: Kim): owns the chat UI that talks to the backend via the Vercel AI adapter (`ui/vercel_ai`).
- Durable Workflows team (lead: Omar): runs long jobs on Temporal; message objects must stay serializable.

## Monthly spend (approximate, from the finance dashboard)
- OpenAI API: $9,400 / month. ~38% of input tokens are base64-encoded file bytes re-sent on every turn.
- Anthropic API: $5,100 / month. Same pattern: documents re-sent with every follow-up question.
- Google Gemini API: $1,900 / month.
- AWS Bedrock: $2,300 / month (includes S3 storage ~$12 / month for uploaded files).
- Provider file storage (OpenAI/Anthropic Files APIs): currently $0, would be ~$40 / month at our volume.
- Average conversation: 1 uploaded file, 6 follow-up questions.

## Product notes
- Users complain that long chats with a big PDF get slow (every request re-uploads the PDF bytes).
- Compliance: uploaded files must be deletable on request (GDPR); provider-side file ids must be tracked.
