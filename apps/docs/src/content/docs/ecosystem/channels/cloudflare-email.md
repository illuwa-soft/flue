---
title: Cloudflare Email
description: Receive native Cloudflare Email Routing events and connect them to Flue agents.
lastReviewedAt: 2026-10-16
---

## Quickstart

This fork provides a Cloudflare-only source blueprint:

```sh
flue add channel cloudflare-email
```

Use a CLI built from this fork and its matching blueprint registry. This guide
and command are a prototype, not an announced upstream Flue integration.

## Native ingress

Cloudflare Email Routing invokes the Worker's `email()` event. The blueprint
composes that handler through the existing source-root `cloudflare.ts` extension
and admits an email signal with `dispatch()`. There is no HTTP webhook to mount
and no webhook signing secret. Inbound email content and sender headers remain
untrusted input; the native event is not proof of sender identity.

The integration is project source, not a new `@flue/cloudflare-email` package.
See the complete runnable `examples/cloudflare-email` application in this fork.

## Configuration

| Binding / variable            | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `INBOX`                       | Application-owned R2 bucket for raw mail, admission receipts and reply reservations. |
| `EMAIL`                       | Cloudflare `send_email` binding.                                                     |
| `EMAIL_MODE`                  | `live` by default; the local runner overrides this to `local` for simulation.        |
| `EMAIL_RECIPIENT`             | Exact envelope recipient accepted by this Worker.                                    |
| `EMAIL_REPLY_ALLOWED_SENDERS` | Explicit comma-separated automatic-reply recipients; empty denies all.               |
| `ADMIN_TOKEN`                 | Secret protecting the example's administrative HTTP routes.                          |

Configure Email Routing to send the chosen mailbox to the deployed Worker.
Native `email()` ingress does not use `app.route()`. Existing HTTP routes and
other non-HTTP handlers remain application-owned.

Email Sending is currently beta. Arbitrary-recipient sending requires Workers
Paid and an onboarded sending domain. Verified-destination sending and the
event-scoped `message.reply()` API have different capabilities and restrictions;
the asynchronous agent reply uses `env.EMAIL.send()`.

## Threaded human approval

Version 2 adds an application-owned HITL example: one known email thread maps
to one Flue conversation, while each mail keeps its own source id and current
retrieval target. Known incoming and outgoing Message-IDs connect replies;
subjects do not select a conversation and other authors cannot join it by
copying references.

The model proposes exact document contents and ends its response. The
application stores a pending plan and sends a fresh 128-bit approval code,
valid for 24 hours. Reply on the first new plain-text line with `승인 CODE`,
`수정 CODE: instruction` or `취소 CODE` (English equivalents also work).
Quoted commands, bare approval words, old codes and expired codes cannot
execute the plan. A revision requires a new approval. Application code saves
the approved document artifact using the approval id as an idempotency key.

The code is a bearer secret delivered to the allowlisted author. The From
allowlist itself is not identity authentication. Real operation authorization,
retention and external effects remain application-owned.

The runnable example's `dev:local` and `email:local` commands reproduce the
entire flow with a faux model and a local outbox, including restart while
waiting. They require no Cloudflare login or live model/email credentials.

## Persistence and delivery

The example stores at most **1 MiB** of raw mail before dispatch. A digest of the
envelope and Message-ID identifies one incoming message; absent Message-ID, the
raw digest is used. Conflicting bytes are rejected. The identity is supplied as
Flue's dispatch `idempotencyKey`. It is not a provider-issued delivery id or a
stable cross-message thread root. Separate persisted reference indexes map
known replies to a thread; unknown references create a new thread.

The bound retrieval tool parses MIME with `postal-mime`, returns at most
**16,000 characters**, and exposes only attachment metadata. Bind all source
identifiers and reply recipients in trusted application code. The SMTP envelope
can be a provider bounce address: the example replies only to an explicitly
allowlisted parsed `From` author, ignoring `Reply-To`. This allowlist is not
sender authentication.

An atomic reply reservation prevents concurrent duplicate sends. A pending
reservation after an error represents an uncertain outcome and requires
operator reconciliation, rather than blind retry. Provider acceptance does not
prove inbox delivery. Threading headers are set on the asynchronous reply.

Storage retention, sender authorization, loop prevention, domain configuration,
DNS, outbound policy, and attachment processing belong to the application.

## Verify and update

Run the example's generated Env check, typecheck, offline assertion tests,
Worker build and full workerd HITL test. The latter exercises real Flue turns
with a deterministic faux model, a restart and a simulated outbox. Verify real
Email Routing, live model work and recipient-inbox arrival separately using
test addresses.

```sh
flue update channel cloudflare-email
```

The update guide preserves project-specific handlers, routing, sender policy,
resource names and migration history. Compare an unmarked implementation with
the complete current guide before adding its primary-file version marker.
