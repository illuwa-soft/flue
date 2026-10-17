# @illuwa-soft/flue-cloudflare-email

Native Cloudflare email ingress and threaded conversations for Flue.

This is an **independently maintained community package**, not an official Flue
or Cloudflare integration. It uses public Flue APIs and works with the published
`@flue/runtime`; consumers do not need this repository's Flue fork.

The implementation lives only in this package. The runnable application in
[`examples/cloudflare-email`](https://github.com/illuwa-soft/flue/tree/community/examples/cloudflare-email)
imports it, rather than maintaining a second copy.

## Install

In an existing Cloudflare-target Flue application:

```sh
pnpm add @illuwa-soft/flue-cloudflare-email @flue/runtime
```

Requirements: Node **22.19 or later** for development, a supported Flue 2.x
runtime (**2.3.0 is the initial verified baseline**), and a Cloudflare Worker
configured with `nodejs_compat`. This adapter runs on Cloudflare; Node tests do
not turn it into a Node email server.

## Connect a mailbox to an existing agent

1. Add the following application-owned bindings to your Wrangler configuration.
   Replace the bucket and mailbox with your own values; create the bucket.

   ```jsonc
   {
     "r2_buckets": [{ "binding": "INBOX", "bucket_name": "your-email-inbox" }],
     "send_email": [{ "name": "EMAIL" }],
     "vars": {
       "EMAIL_RECIPIENT": "support@example.com",
       "EMAIL_REPLY_ALLOWED_SENDERS": "operator@example.net",
       "EMAIL_MODE": "live",
     },
   }
   ```

2. Generate your application's Worker types with `wrangler types`. Import your
   existing registered Flue agent and compose the handler in `src/cloudflare.ts`:

   ```ts
   import { env } from 'cloudflare:workers';
   import { dispatch } from '@flue/runtime';
   import { createCloudflareEmailChannel } from '@illuwa-soft/flue-cloudflare-email';
   import { EmailAssistant } from './agents/email-assistant.ts';

   const channel = createCloudflareEmailChannel({
     bindings: env,
     admit: dispatch.bind(null, EmailAssistant),
   });

   export default { email: channel.email };
   ```

   Merge this handler with any existing `scheduled`, `queue` or other non-HTTP
   handlers. Keep HTTP routes in `app.ts`. No webhook URL or signing secret is
   required. The factory does not register an agent or modify migrations.

3. Build and deploy the application. In Cloudflare Email Routing, route the exact
   `EMAIL_RECIPIENT` address to this Worker. Back up an existing rule before
   changing it. For arbitrary-recipient asynchronous replies, onboard the
   sending domain and use a plan that supports Cloudflare Email Sending
   (currently beta, Workers Paid).

4. Configure your agent for these inputs:

   - Creation data: `{ threadId, owner }`.
   - Delivery: `kind: 'signal'`, type `cloudflare.email.received`.
   - Delivery attributes: `emailId`, `threadId`, `from` (SMTP envelope), `to`.
   - Conversation id: `cloudflare-thread:<threadId>`.

   Read the **current delivery's** `emailId` through Flue's `useDelivery()`.
   Retrieve it with `retrieveThreadEmail(bindings, threadId, owner, emailId)`.
   Do not bind retrieval to the first message forever. See the complete
   conversational agent in the example for narrow retrieval and reply tools.

## What the adapter does

- Stores at most **1 MiB** of immutable source mail before durable admission.
- Uses a stable, envelope-scoped message identity as the dispatch idempotency key.
- Indexes incoming and sent Message-IDs. Known `In-Reply-To` / `References`
  continue the original author's conversation; subjects do not select a thread.
- Rejects another participant or conflicting known-thread references. It checks
  at most **100 combined message references**.
- Parses MIME and HTML-only bodies. Quoted HTML remains quoted. Retrieval text
  is limited to **16,000 characters**; attachment contents are not exposed.
- Replies only to an explicitly allowlisted MIME From author, not `Reply-To` or
  a model-selected recipient. SMTP envelope senders can be bounce addresses.
- Reserves one outgoing reply per incoming mail with a conditional write.

`EMAIL_REPLY_ALLOWED_SENDERS` is a comma-separated list; empty disables replies.
It is **not sender authentication**. The native email event, thread references
and a digest id do not prove the sender's identity. Use an authorization policy
appropriate to the actions your agent can perform.

An interrupted send or result write leaves the reply reserved as `sending`.
Reconcile provider delivery before clearing it. This adapter does not claim an
atomic R2/email transaction or exactly-once external delivery.

## Conversation and HITL example

The example adds ordinary conversation, persisted human approval, cancellation,
revision, a local faux model and administrative legacy import. These are
**application policies**, not implicit features enabled by installing a package.
Only the application can authorize and execute a domain action.

From a checkout of the `community` branch:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=cloudflare-email-example...
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example dev:local
```

In another terminal at the repository root:

```sh
pnpm --filter cloudflare-email-example email:local --text "Create a document for approval."
pnpm --filter cloudflare-email-example email:local --reply latest --text "approve CODE"
```

Replace `CODE` with the code printed in the simulated reply. Local mode uses
the actual built Worker and Flue Durable Object, but never calls a model or
email service. The example README describes restart, revision and cancellation.

## Independent releases and eventual upstream adoption

This package has its own version and release workflow. Upstream review is not a
prerequisite for fixes or releases. Weekly compatibility and upstream-status
checks are configured on the fork's default `community` branch; an owned
maintenance issue records actionable failures and review reminders.

**A merged PR alone does not retire this package.** Retirement requires a
published, verified successor, a migration guide and an explicit maintainer
decision. Existing published versions remain downloadable after deprecation.
No workflow automatically deletes source, unpublishes versions, replaces live
bindings, or redirects consumers to an unverified package.

- [API and storage contract](./API.md)
- [Maintainer and release runbook](./MAINTAINING.md)
- [Migration and removal runbook](./MIGRATING.md)
- [Upstream discussion](https://github.com/withastro/flue/discussions/864)

## License

Apache-2.0. Retain the included LICENSE and NOTICE when redistributing derived
code. Flue and Cloudflare names identify compatibility, not endorsement.
