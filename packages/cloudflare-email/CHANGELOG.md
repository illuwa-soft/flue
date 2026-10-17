# Changelog

## 0.1.0

- Extract the tested email adapter from the application example into one independently publishable package.
- Preserve existing R2 object keys, envelope-scoped delivery ids and `cloudflare-thread:` conversation ids.
- Support native ingress, HTML-only MIME bodies, known reply references, bounded retrieval and reply reservations.
- Add explicit structural binding types and a native handler factory; do not depend on a consumer-generated `Env`.
- Keep conversational agents, local faux models, HITL actions and legacy administration in the consuming application.
