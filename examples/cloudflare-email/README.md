# Cloudflare Email Service example

A Cloudflare-only, project-owned email integration. Native Email Routing events
enter through `src/cloudflare.ts`; no public HTTP webhook accepts email.

```text
Email Routing → email() → conditional R2 write → dispatch(EmailAssistant)
  → durable agent admission → retrieve_cloudflare_email → reply_to_cloudflare_email
```

## Setup

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@flue/vite...
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example check:types
pnpm --filter cloudflare-email-example test
pnpm --filter cloudflare-email-example build
pnpm --filter cloudflare-email-example test:workerd
```

## Blueprint CLI development

The upstream public registry does not publish this fork's blueprint. Build the
fork CLI and run the fork website locally:

```sh
pnpm exec turbo run build --filter=@flue/cli...
pnpm --filter apps-www dev
```

In a second terminal, use the **local-development-only** registry override,
adjusting port 4321 to the port printed by Astro:

```sh
FLUE_REGISTRY_URL=http://localhost:4321/cli/blueprints node packages/cli/bin/flue.mjs add channel cloudflare-email --print
FLUE_REGISTRY_URL=http://localhost:4321/cli/blueprints node packages/cli/bin/flue.mjs update channel cloudflare-email --print
pnpm --filter cloudflare-email-example test:blueprint
```

The blueprint test exercises the actual website route and fork CLI, extracts
the guide's complete source into a disposable consumer, runs its assertion
tests, typechecks and builds it. `add`/`update` print instructions; they do not
edit a project by themselves. Preservation of custom changes remains a coding
agent/manual review responsibility, not a guarantee made by this test.

`test` uses Node assertions, synthetic email, and fake bindings. `test:workerd`
loads the built Worker, injects a native email event, verifies actual local R2
storage and durable dispatch admission, repeats the event, and checks HTTP
authorization. It forces local bindings: Workers AI is unavailable and the agent
model operation fails locally. This test proves admission, not LLM completion or
real delivery. It never sends real email. The installed Wrangler 4.116 simulator
uses `/cdn-cgi/handler/email`; newer documentation describes
`/cdn-cgi/local/email`. Use the endpoint supported by the installed Wrangler.

Before deployment:

1. Choose a Worker name and R2 bucket. Create the bucket and set its name in
   `wrangler.jsonc`.
2. Set `EMAIL_RECIPIENT` to the exact mailbox handled by this Worker.
3. Set `EMAIL_REPLY_ALLOWED_SENDERS` to comma-separated addresses allowed to
   receive automatic replies. Empty disables all replies. This is demonstration
   application policy, not authentication of the sender or a framework default.
4. Set `ADMIN_TOKEN` with `wrangler secret put ADMIN_TOKEN`. Store local secrets
   in the ignored `.dev.vars` file. Never commit them.
5. Build and run `wrangler deploy --dry-run`, then deploy. Configure the exact
   address in Email Routing to send to this Worker. Back up an existing rule
   before changing its destination.
6. For arbitrary-recipient outbound mail, enable Email Sending on the domain
   and use Workers Paid. The account must have access to the current beta.

The compatibility date is deliberately within the installed workerd support
window. Rerun `cf-typegen` whenever the Wrangler bindings change; the generated
`worker-configuration.d.ts` is ignored.

## Behavior and limits

- A maximum **1 MiB** inbound message is stored as immutable RFC 5322 bytes.
- Identity is SHA-256 of `[envelope from, envelope to, Message-ID]`, falling
  back to the raw digest when Message-ID is absent. This is an application
  convention: Cloudflare provides no Resend/Svix delivery id here. A reused
  identity with different bytes is a conflict, not a silently overwritten mail.
- Storage completes before dispatch. The email id is also Flue's
  `idempotencyKey`. Dispatch failures can be retried without losing the source.
  Each inbound message has its own agent instance; this is not conversation
  grouping by `References`.
- MIME parsing uses `postal-mime`; tools return at most **16,000 characters**
  and attachment metadata, never arbitrary attachment contents.
- Replies target the parsed `From` author only when explicitly allowlisted,
  ignoring model-selected recipients and the untrusted `Reply-To` header. The
  SMTP envelope can be a provider bounce address and is kept separately. A
  `From` allowlist alone does not authenticate the sender. The configured receiving
  mailbox is the outbound sender. Automated/list messages are not replied to.
- A conditional R2 reply reservation prevents concurrent/ordinary duplicate
  sends. If sending or recording its result fails, the reservation remains
  `sending`. This is an **uncertain outcome**, not proof of failure: reconcile
  provider delivery before manually clearing it. Email Sending has no atomic
  transaction with R2, so this is not an exactly-once delivery guarantee.
- `Auto-Submitted`, `In-Reply-To`, and `References` are added to replies.
  Each message id maps to one response; original thread history is not restored.

## Inspect a deployed test

`GET /health` is public. All other HTTP routes require `Authorization: Bearer
<ADMIN_TOKEN>`. The administrative routes are:

- `GET /api/emails/<emailId>` — bounded content, dispatch receipt and reply state.
- `GET /api/emails` — paginated admission identifiers, with a continuation cursor.
- `/agents/email/cloudflare-email:<emailId>` — Flue conversation API.

To verify actual delivery, send a uniquely titled mail from an allowed test
sender to the configured mailbox. Inspect the R2 receipt and the settled Flue
conversation, then verify the reply in the sender's inbox. A returned outbound
`messageId` proves provider acceptance, not inbox arrival. Test a duplicate
separately and confirm it reuses the submission and reply state.

R2 retains source email and operation records until the application deletes
them; choose an explicit retention/access policy before using real customer
mail. Model-visible email is untrusted content. Credentials, source bytes and
attachment content are never embedded in the dispatched signal.

## Related

- [Flue Cloudflare extensions](https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
- [Feature proposal](https://github.com/withastro/flue/discussions/864)
