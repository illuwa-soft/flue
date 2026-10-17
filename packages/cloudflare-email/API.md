# API reference

All exports come from `@illuwa-soft/flue-cloudflare-email`. ESM and TypeScript
declarations are included in the npm tarball. There are no deep/internal import
paths and no runtime import of `cloudflare:workers`.

## Types

| Export          | Contract                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ |
| `IncomingEmail` | The native message's `from`, `to`, `headers.get`, `raw`, `rawSize`, and `setReject`.       |
| `EmailStore`    | The R2 `get`/conditional `put` subset used by this adapter.                                |
| `OutgoingEmail` | Bound `from`, `to`, `subject`, `text`, and string headers.                                 |
| `EmailBindings` | `INBOX`, `EMAIL`, `EMAIL_RECIPIENT`, `EMAIL_REPLY_ALLOWED_SENDERS`, optional `EMAIL_MODE`. |
| `AdmitEmail`    | A callback accepting Flue `AgentDispatchRequest` and returning `DispatchReceipt`.          |

These are structural library contracts, not aliases of a consumer's generated
`Env`. Typecheck the actual native bindings in each consuming Worker.

## Factory

`createCloudflareEmailChannel({ bindings, admit })` captures the application-owned
bindings and admission callback. Its methods do not depend on `this`:

| Method                 | Result                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `email(message)`       | Native Worker handler, resolves `void` after admission.                              |
| `receive(message)`     | Resolves `{ emailId, threadId, receipt }`, or `undefined` for a permanent rejection. |
| `retrieve(emailId)`    | Bounded parsed email and attachment metadata.                                        |
| `reply(emailId, text)` | Bound send result; a prior successful send returns `deduplicated: true`.             |

The caller supplies the agent registration, model and tools. The factory does
not manage Cloudflare accounts, DNS, resource creation, user identity, retention
or workflow approval.

## Functional composition

The same implementation is available without a factory:

- `receiveEmail(message, bindings, admit)`.
- `retrieveEmail(bindings, emailId)`.
- `retrieveThreadEmail(bindings, threadId, owner, emailId)` — also verifies this
  mail belongs to the specified thread and author.
- `replyToEmail(bindings, emailId, text)`.
- `readableEmailText({ text?, html? })` — plain text takes precedence; HTML uses
  a parser with quoted-block preservation.
- `indexThreadMessage(bindings, messageId, threadId, owner)` — advanced,
  application-owned migration support; ids are not authorization capabilities.

Never expose arbitrary storage identifiers or the indexing helper as a public,
unauthenticated HTTP tool.

## Persisted format (0.1.x)

| Key prefix                    | Contents                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `inbound/<emailId>.eml`       | Immutable RFC email bytes and envelope/thread metadata.       |
| `message-index/<digest>.json` | Mailbox-scoped Message-ID → thread and owner.                 |
| `receipts/<emailId>.json`     | Admission receipt and thread id.                              |
| `replies/<emailId>.json`      | `sending` reservation or `sent` provider message id.          |
| `outbox/...json`              | Local-mode simulated sends only.                              |
| `legacy-links/<emailId>.json` | Optional application migration association read by retrieval. |

Message identity hashes the SMTP envelope sender, recipient and Message-ID,
falling back to the raw digest. A conflicting source under that same identity
is rejected. This is not a provider-issued delivery id or a claim of universal
SMTP retry equivalence.

Unknown references create a new thread. Different known threads in one message
or a different MIME From author on a known thread are rejected. The receiving
mailbox scopes all reference indexes. A fresh subject alone never joins a thread.

The example's `hitl/`, `artifacts/` and `thread-history/` records are owned by the
example, not the package. Do not delete or rewrite storage just because the
implementation package changes. SemVer and migration notes must describe any
future persisted-format change.
