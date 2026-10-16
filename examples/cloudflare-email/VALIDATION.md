# Prototype validation

Validated on 2026-10-16 against Flue 2.3.0, Node 26.5.0, pnpm 11.1.1,
Wrangler 4.116.0 and Vite 8.1.5.

## Reproducible local checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@flue/cli...
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example check:types
pnpm --filter cloudflare-email-example test
pnpm --filter cloudflare-email-example build
pnpm --filter cloudflare-email-example test:workerd
pnpm --filter cloudflare-email-example test:blueprint
pnpm --filter apps-docs check:types
pnpm --filter @flue/cli check:types
pnpm --filter apps-docs build
pnpm exec biome check examples/cloudflare-email apps/docs/src/lib/docs-navigation.ts apps/ecosystem-catalog.ts
pnpm exec prettier --check examples/cloudflare-email apps/docs/src/content/docs/ecosystem/channels/cloudflare-email.md apps/docs/src/lib/docs-navigation.ts apps/ecosystem-catalog.ts
git diff --check
```

Results:

- **5/5 Node assertion tests**: immutable storage before admission, replay
  identity, scoped retrieval, threading, one reply, invalid recipients and
  size, retry after admission failure, conflicting Message-ID bytes, automated
  mail rejection, uncertain-send suppression, and provider bounce envelopes.
- **1/1 workerd integration test**: native `email()` reaches the built Worker,
  writes real local R2, durably admits to a generated Flue Durable Object,
  reuses the submission id on replay, and protects inbox HTTP access.
- **1/1 Blueprint consumer test**: the actual website route discovers and
  serves the blueprint, the fork CLI resolves `add` and `update`, both return
  the same guide, and its complete TypeScript examples pass the same five
  assertions, typecheck and Worker build in a disposable consumer.
- Example/generated Env, docs and CLI type checks pass. Docs build includes
  `/docs/ecosystem/channels/cloudflare-email/`; scoped lint/format checks pass.

The local workerd check deliberately forces local bindings. Its model operation
reports `Binding AI needs to be run remotely`; the assertion covers durable
admission, not successful LLM work. Live model work is covered separately below.
The Blueprint consumer test is a deterministic extraction of guide examples,
not an evaluation of every coding agent's ability to preserve custom code.

## Authorized live check

A test mailbox on a user-owned Cloudflare domain was routed to the deployed
example Worker. A separate existing mailbox received the reply.

Observed, rather than inferred from a successful send call:

1. A real Email Sending message reached the native Worker `email()` handler.
2. R2 contained the original MIME email and its admission receipt.
3. The generated Flue agent retrieved the mail, ran a Workers AI model, invoked
   the bound reply tool and settled `completed`.
4. The outbound message id matched the reply stored by the receiving mailbox's
   existing application. DKIM and DMARC passed.
5. A second reply-tool invocation returned the same message id with
   `deduplicated: true` instead of sending a second email.

Live testing exposed a provider-envelope distinction: Email Sending used a
`cf-bounce` address as SMTP MAIL FROM. The implementation therefore retains the
envelope for identity/audit and selects a reply author from parsed MIME `From`
only after explicit application allowlisting, never from model arguments or
`Reply-To`. The allowlist does not replace sender authentication.

Private deployment overrides, token, routing rollback data and exact test
identifiers are kept outside the repository. The committed configuration uses
example addresses. Running the example's default deploy without setting the
real mailbox/allowlist intentionally does not reproduce those private overrides.

This validates this prototype and its scoped checks, not all packages or
missing test suites in the upstream monorepo. No upstream PR is implied.
