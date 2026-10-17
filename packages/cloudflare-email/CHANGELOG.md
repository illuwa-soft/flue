# Changelog

## 0.2.0 — 2026-10-17

- Separate EMAIL/INBOX resources from mailboxAddress and optional channelId.
- Add handler(agent) and consumption-only useCloudflareEmail with read_email/reply_email tools.
- Support fixed conversations without replacing initialData; persist routes for stable retries and known replies.
- Validate delivery references and mailbox scope before model replies.
- Follow Reply-To/From and support reply-all To/CC with self/duplicate removal.
- Move simulation and outbound allowlists into consuming sender adapters.
- Publish new stable package versions from verified community pushes through npm OIDC; skip versions already present in the registry.
- Breaking: receive(message, admit) takes the admission callback per call. Low-level functions accept EmailContext, not an Env-shaped object. See MIGRATING.md.

## 0.1.0

- Extract the tested email adapter from the application example into one independently publishable package.
- Preserve existing R2 object keys, envelope-scoped delivery ids and `cloudflare-thread:` conversation ids.
- Support native ingress, HTML-only MIME bodies, known reply references, bounded retrieval and reply reservations.
- Add explicit structural binding types and a native handler factory; do not depend on a consumer-generated `Env`.
- Keep conversational agents, local faux models, HITL actions and legacy administration in the consuming application.
