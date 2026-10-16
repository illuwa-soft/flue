# Prototype validation

## Conversational HTML mail v3

The current implementation adds normal conversational replies, retained
in-thread context, HTML-only text conversion and an explicit, authenticated
legacy-thread reference/history importer. The importer preserves original
bytes and does not replay old messages or approvals.

Local checks cover HTML/blockquoted approvals, ordinary questions during a
pending review, connected legacy import and prior-author access. The full
workerd flow also checks HTML-only conversational recall in one Flue thread.
Real deployment observations are recorded after the live verification below.

Validated on 2026-10-16: **12/12** Node assertions, **1/1** full local workerd
flow and **1/1** Blueprint v3 consumer/upgrade check. Worker typecheck/build and
the actual site's CLI guide route passed. The workerd flow includes HTML-only
ordinary conversation with retained context, chat during pending approval,
HTML approval and restart recovery.

### Authorized v3 live deployment

The live Worker was updated to version
`9ce0dfc0-571b-4bb8-82c1-069abe717612`. Five explicitly selected, connected v1
human messages were indexed as prior context without replaying them or
rewriting their source bytes.

Observed live behavior:

1. A new HTML-only reply in that existing thread correctly recalled the name
   supplied in an earlier v1 email.
2. A fresh document request created a pending plan. A later ordinary HTML-only
   question recalled its earlier marker in the **same Flue conversation id**,
   while the approval stayed pending and no artifact existed.
3. An actual HTML email containing the current approval code (with an HTML
   non-breaking space) completed the workflow. The resulting artifact exactly
   matched the previously stored plan.
4. All four outbound responses were found in the receiving mailbox application's
   actual inbox records, with DKIM and DMARC passing. This was not inferred from
   provider acceptance alone.

Private mailbox ids, approval codes, admin credentials and deployment overrides
are not part of this repository. The migration is an explicit admin operation;
ordinary fresh threads use Flue's own conversation history directly.

## Threaded HITL v2 — local validation

The current local example adds thread correlation, 24-hour one-time approvals,
revision/cancellation and an idempotent document artifact. Its workerd test runs
the actual Flue conversation and a faux model through request → revision →
process restart → approval → duplicate email → cancellation, forcing all
bindings local. No model or email network service is contacted.

Run `dev:local` / `email:local` as described in README for an interactive manual
check. The v2 source is checked by the Node assertions, Worker typecheck/build,
full local workerd flow and v2 Blueprint consumer test. Live v2 mailbox behavior
has not been claimed by these checks; the deployment observations below apply
to the previously validated **v1** prototype.

Results: **9/9** Node assertion tests, **1/1** complete workerd flow (including
successful settlements after restart), and **1/1** Blueprint consumer test. The
latter also checks/applies the complete v1 → v2 upgrade diff and compares its
modules with the current guide. A manual run of the documented `email:local`
CLI completed request → revision → approval and retrieved the exact approved
artifact from the local server. Typecheck, Worker/docs build and scoped
lint/format checks complete the verification.

## Message-scoped v1 — historical live validation

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
