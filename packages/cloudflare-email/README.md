# @illuwa-soft/flue-cloudflare-email

Connect native Cloudflare email to an existing Flue agent with one configured
channel, one Worker handler, and one consumption-only hook.

This independently maintained community package works with official
`@flue/runtime`; a forked Flue runtime is not required. Development requires
Node >=22.19.0 and a Cloudflare-target Flue application with `nodejs_compat`.

## Install

This page documents the **0.2 API**. For testing unpublished source revisions,
install the local archive produced by `pnpm pack` after building.

```sh
pnpm add @illuwa-soft/flue-cloudflare-email@^0.2.0 @flue/runtime@^2.3.0
```

## Minimum connection: three files

### 1. Configure a channel

```ts
// src/email.ts
import { env } from 'cloudflare:workers';
import { createCloudflareEmailChannel } from '@illuwa-soft/flue-cloudflare-email';

export const email = createCloudflareEmailChannel({
  bindings: { EMAIL: env.EMAIL, INBOX: env.INBOX },
  mailboxAddress: 'assistant@example.com',
  channelId: 'personal-assistant',
});
```

- `bindings` contains only the actual sending and storage resources.
- `mailboxAddress` is this channel's receiving mailbox and outgoing From address.
- `channelId` selects a fixed conversation **within the handler's agent**. Omit
  it for a separate conversation per email thread. Ordinary Flue admission creates
  a missing fixed conversation and preserves an existing one's initial data.
  Agents with required creation data must have their fixed conversation initialized
  through the application before the first email arrives.

The application owns settings storage and loading. There is no required `Env`
shape, environment-variable naming convention, `mode`, or recipient allowlist.

### 2. Consume it in the agent

```ts
// src/agents/assistant.ts
'use agent';

import { useModel } from '@flue/runtime';
import { useCloudflareEmail } from '@illuwa-soft/flue-cloudflare-email';
import { email } from '../email.ts';

/** Read and answer delivered mail. / 전달된 이메일을 읽고 답장합니다. */
export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  useCloudflareEmail(email);
  return 'Read the email and reply helpfully in the sender’s language.';
}
```

Keep your existing model and business tools. The hook registers `read_email`
and `reply_email` for matching email deliveries and adds a usage instruction.
It does not change routing, register an agent, select a model, replace creation
data, or create an approval workflow. Non-email deliveries register no email
tools. Plain assistant output is not automatically sent as email.

### 3. Connect native ingress

```ts
// src/cloudflare.ts
import { Assistant } from './agents/assistant.ts';
import { email } from './email.ts';

export default { email: email.handler(Assistant) };
```

Merge the email property with existing Worker handlers. HTTP routes stay in
`app.ts`. No HTTP webhook or signing secret is needed. The handler resolves after
Flue durably admits the mail, not after the model replies.

Configure resources in Wrangler, generate types, and route the exact mailbox
to the deployed Worker with Cloudflare Email Routing:

```jsonc
{
  "r2_buckets": [{ "binding": "INBOX", "bucket_name": "your-email-inbox" }],
  "send_email": [{ "name": "EMAIL" }],
}
```

```sh
pnpm exec wrangler types
```

Create the bucket and onboard the sending domain using a supported Cloudflare
Email Sending plan. Cloudflare's sending permissions still apply. Changing
DNS, routing, resources, or deployment is a separate operator action.

## Model tools

1. `read_email()` returns bounded mail, thread/conversation identity, attachment
   metadata, and `messageRef`.
2. `reply_email({ messageRef, text, replyAll? })` replies to that delivery.

A reference from another delivery fails explicitly instead of targeting the
latest mail by accident. Reread after the delivery cursor advances. Captured
tools stay bound to a durable delivery snapshot, not a mutable latest-mail
pointer. A reference is not an authorization capability.

Normal reply uses original `Reply-To`, falling back to `From`. `replyAll: true`
also adds original To/CC participants as CC, excluding self and case-insensitive
duplicates. It never copies BCC or accepts arbitrary model-selected recipients.
Application-specific outbound restrictions belong in the supplied sender adapter.

## Fixed conversations and independent instances

In fixed mode, independent mail threads share conversation memory but retain
separate threadId, emailId, reply reservations, and application-owned approval
state. Only combine participants whose information may be shared.

Create separate instances for other mailboxes or routing settings. Instances
can share resources; constructing one does not provision a mailbox or R2. A
Worker receiving several mailboxes must select one handler by exact envelope
recipient, never broadcast to all handlers. Hook tool names are fixed; configure
only one matching instance per mailbox in an agent.

Persisted routing keeps redeliveries and known-thread replies on their original
destination after configuration changes. Pre-0.2 threads retain their original
`cloudflare-thread:<threadId>` destination. No automatic movement or replay occurs.

## Storage and delivery guarantees

- Store at most **1 MiB** of immutable raw mail before admission.
- Stable envelope-scoped message identities deduplicate redelivery.
- Known `In-Reply-To`/`References` continue a thread only for its original author;
  subjects never select a thread. Reply-all does not enable multi-party thread
  continuation. At most **100 combined references** are checked.
- Retrieval contains at most **16,000 characters** and attachment metadata only.
  HTML quotes remain quoted.
- Automated/list messages cannot receive automatic replies. One outgoing reply
  is reserved per incoming mail. Interrupted sends remain uncertain and require
  reconciliation; R2 and email are not an atomic transaction.

Headers and thread ids do not authenticate people or authorize actions. Domain
authorization and human approval belong to the application.

## Local demo and optional HITL recipe

The [runnable example](https://github.com/illuwa-soft/flue/tree/community/examples/cloudflare-email)
adds document approval, cancellation, revision, and explicit legacy history import.
These are optional policies, not required setup. Its injected local sender records
mail in R2 without calling the real email service.

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=cloudflare-email-example...
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example dev:local
```

In another terminal:

```sh
pnpm --filter cloudflare-email-example email:local --text "Hello"
pnpm --filter cloudflare-email-example outbox:local
```

The packed-consumer check also builds a hook-only agent against public Flue and
tests two independent authors in a fixed room, restart, and replay:

```sh
pnpm --filter @illuwa-soft/flue-cloudflare-email test:consumer
```

## References

- [API and storage contract](./API.md)
- [Maintainer and release runbook](./MAINTAINING.md)
- [0.1 and official-successor migration](./MIGRATING.md)
- [Upstream discussion](https://github.com/withastro/flue/discussions/864)

This package has its own release lane and weekly compatibility/upstream checks.
Stable package version bumps pushed to `community` run full verification and
publish to npm through Trusted Publishing. Already-published versions are skipped.
An upstream merge alone never triggers deprecation, deletion, or unpublishing.
License: Apache-2.0; retain LICENSE and NOTICE. Compatibility does not imply
Flue or Cloudflare endorsement.
