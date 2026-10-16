# Threaded Cloudflare Email conversation and HITL

An application-owned email approval example built on Flue's native Cloudflare
entrypoint. Known email replies continue **one thread conversation**; individual
messages retain their own retrieval target and delivery/reply idempotency keys.
Ordinary questions receive ordinary replies using that conversation's history.
Only requested document artifacts enter the human-approval flow.

```text
email() → immutable R2 source → thread lookup → dispatch(EmailAssistant)
  → draft exact document → email approval request → idle
human reply → same conversation → validate code/expiry → save approved artifact
```

## Try it locally — no Cloudflare login, email account or model key

Run from the repository root (Node >=22.19.0, pnpm 11):

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@flue/cli...
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example dev:local
```

The server listens on **127.0.0.1:8787**. It uses the actual built Worker,
native email simulator, generated Flue Durable Object and a deterministic Pi
faux model. Outbound email is saved in a local R2 outbox; no external model or
mail service is called. Initial dependency installation may need the registry.

In a second terminal, also at the repository root:

```sh
pnpm --filter cloudflare-email-example email:local --text "회의 결과를 정리하는 문서를 작성해 주세요."
```

The command prints the thread id and a simulated approval email with a fresh
32-character code. Copy that code; the following commands use `CODE` as a
placeholder. **Replace it with the actual code.**

```sh
# Request a revision in the same email thread.
pnpm --filter cloudflare-email-example email:local --reply latest --text "수정 CODE: 결정 사항과 다음 할 일을 구분해 주세요."

# The revised approval email contains a NEW code. Approve that code.
pnpm --filter cloudflare-email-example email:local --reply latest --text "승인 NEW_CODE"

# Inspect the simulated emails, including their Message-IDs.
pnpm --filter cloudflare-email-example outbox:local
```

To cancel a pending request, reply with `취소 CODE`. English `approve CODE`,
`revise CODE: instruction`, and `cancel CODE` also work. `--reply latest` selects
the last simulated outgoing email; when testing several threads, pass an exact
`--reply '<local-…@example.invalid>'` Message-ID instead.

The local faux model copies the request/revision text into a document rather
than generating prose with a real LLM. Approval saves **those exact contents**
under `artifacts/<threadId>/<approvalId>.json`; it does not run arbitrary commands
or publish anything externally.

### Test ordinary conversation

```sh
pnpm --filter cloudflare-email-example email:local --text "기억표식은 푸른달42입니다."
pnpm --filter cloudflare-email-example email:local --reply latest --text "앞에서 말한 표식이 뭐였지?"
```

The local mock echoes bounded prior human messages so the marker remains
visible. The live model answers naturally from the same Flue conversation.
Ordinary questions remain possible while a document is waiting for approval;
they do not change its pending contents or consume its approval code.

### Restart and inspect

Stop the server with Ctrl+C while it is awaiting approval. Start `dev:local`
again and reply to the same approval message. Workflow state, mail, reference
indexes, outbox and the Flue conversation persist under `.wrangler/local-hitl`.
You can test a new independent task by omitting `--reply`.

All HTTP routes other than `/health` require authentication. The local runner
uses the public **local-only demo value** `Bearer local-demo-only`:

| Route                                                     | Purpose                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `/api/local/outbox`                                       | Paginated simulated mail, available only in local mode.    |
| `/api/emails`                                             | Paginated admitted email identifiers.                      |
| `/api/emails/<emailId>`                                   | Current mail and receipt (including threadId).             |
| `/api/threads/<threadId>`                                 | Approval phase, revision, pending plan/code, artifact key. |
| `/api/artifacts/<threadId>/<approvalId>`                  | The approved JSON document.                                |
| `/agents/email/cloudflare-thread:<threadId>?view=history` | Full Flue conversation.                                    |

For example, replace `THREAD_ID` with the printed value:

```sh
curl -H 'Authorization: Bearer local-demo-only' http://127.0.0.1:8787/api/threads/THREAD_ID
```

Do not use the local demo token on a deployed Worker. The normal Wrangler config
defaults to `EMAIL_MODE: "live"`; the local runner overrides mode and credentials
only in its local process. Running plain `vite dev` is not the offline demo.

## Real email behavior

- The first mail starts a `cloudflare-thread:<threadId>` conversation. Known
  `In-Reply-To` / `References` point later mail to it, including replies to the
  agent's outgoing messages. Subjects do not identify conversations.
- Another author cannot join a known thread by copying its references.
  Forwarded and multi-party approvals are outside this example's scope.
- Each proposal saves exact title/content, a fresh **128-bit code** and a
  **24-hour expiry**. The first new plain-text line must be the complete command.
  Quoted commands, a bare `승인`, old codes and expired codes do not execute work.
- A revision invalidates the prior request. Approval/cancellation compete through
  R2 conditional writes; only the selected state transition proceeds.
- Approval executes the saved plan in application code before model work. The
  artifact is created conditionally under the approval id, so recovery can
  repeat the write without duplicating the artifact.
- Each incoming mail can receive one reply. Interrupted/ambiguous sends remain
  reserved as `sending` and need operator reconciliation. No R2/email
  cross-service exactly-once guarantee is claimed.
- The recipient is bound to an allowlisted parsed MIME From author, never a
  model argument or Reply-To. SMTP envelopes may be provider bounce addresses.
  A From allowlist is not sender authentication: the approval code is a bearer
  secret delivered to that mailbox. Use authenticated sender/identity policy
  appropriate to the real operation before adapting this demo to sensitive work.
- Source limit: **1 MiB**. Retrieved text: **16,000 characters**. Proposed
  document: **12,000 characters**. Attachments remain metadata-only.
- HTML-only mail is converted with `html-to-text`; quoted blocks stay quoted
  and cannot become first-line approval commands. Reply subjects are normalized
  to one `Re:` prefix rather than accumulating prefixes.

R2 owns approval state and immutable mail/artifacts; Flue owns the durable
conversation and admission queue. `useAgentStart()` processes human decisions,
and the model's proposal tool uses `terminate: true` to end the response rather
than waiting on a running tool call for a human.

## Verify

```sh
pnpm --filter cloudflare-email-example check:types
pnpm --filter cloudflare-email-example test
pnpm --filter cloudflare-email-example build
pnpm --filter cloudflare-email-example test:workerd
pnpm --filter cloudflare-email-example test:blueprint
```

The workerd check now covers the complete offline request → revise → restart →
approve → duplicate → cancel flow, with successful Flue settlements rather than
the v1 admission-only test. It uses isolated temporary persistence and never
contacts live services. The installed Wrangler 4.116 native-email simulator
uses `/cdn-cgi/handler/email`; this is not an application HTTP ingress route.
It also verifies HTML-only questions, retained conversation context and normal
chat during pending approval.

## Blueprint CLI development

The upstream public registry does not publish this fork's blueprint. Build the
fork CLI and run its site locally:

```sh
pnpm exec turbo run build --filter=@flue/cli...
pnpm --filter apps-www dev
```

In another terminal (adjust port 4321 to Astro's actual port):

```sh
FLUE_REGISTRY_URL=http://localhost:4321/cli/blueprints node packages/cli/bin/flue.mjs add channel cloudflare-email --print
FLUE_REGISTRY_URL=http://localhost:4321/cli/blueprints node packages/cli/bin/flue.mjs update channel cloudflare-email --print
```

`add`/`update` print a coding-agent implementation guide; they do not edit the
project themselves. The consumer test verifies the actual site route and CLI,
then typechecks, tests and builds the guide's source in a clean consumer.
`scripts/refresh-blueprint.mjs` regenerates v3 source/diff from the executable
example and the fixed v2 commit while retaining earlier upgrade history; future published contract changes need a new
version rather than rewriting history.

## Deploying deliberately

Configure an application-owned R2 bucket, `send_email` binding, receiving
mailbox, sender allowlist and a private `ADMIN_TOKEN`. Generate Env after config
changes, build, dry-run and deploy. Preserve deployed migration history and
existing Email Routing rules. Arbitrary-recipient sending currently requires
Email Sending beta, Workers Paid and an onboarded sending domain.

The agent creation contract is `{ threadId, owner }`; v1 per-mail instances
are not resumed as approval tasks. New mail uses the new conversation prefix.
Do not replay historical mail as approved work. Committed example addresses are
not personal deployment settings: keep real overrides private and explicit.
Retention, sender authentication, real domain effects and notification recovery
remain application responsibilities.

### Explicit legacy conversation import

An administrator may POST `{ "rootEmailId": "...", "emailIds": ["..."] }` to
`/api/admin/legacy-thread`, with the private deployment admin bearer token.
Select **1–50** v1 mail records from the same allowlisted author, including the
root and required intermediate replies. The importer validates a connected
reference chain, indexes incoming/sent Message-IDs and supplies bounded prior
human text to the new conversation. It does not rewrite raw mail, merge the
old Flue record logs, replay submissions or carry over any approval.

This is an explicit operator action, not automatic subject matching. A
conflicting existing link is rejected. Ordinary fresh threads do not need an
import; their conversation context is retained directly by Flue.

See [VALIDATION.md](./VALIDATION.md) for the exact scope of local and historical
live checks, and [Discussion #864](https://github.com/withastro/flue/discussions/864)
for upstream integration discussion.
