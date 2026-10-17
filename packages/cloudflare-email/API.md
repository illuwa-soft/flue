# API reference — 0.2

Import ESM functions and TypeScript types from `@illuwa-soft/flue-cloudflare-email`.
There are no deep imports or runtime imports of `cloudflare:workers`.

## Configuration

`createCloudflareEmailChannel(options)` accepts `CloudflareEmailOptions`:

| Option           | Contract                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| `bindings.EMAIL` | Native-compatible send(OutgoingEmail): Promise<{ messageId: string }>       |
| `bindings.INBOX` | R2-compatible get and conditional put subset (EmailStore)                   |
| `mailboxAddress` | Required receiving mailbox and outgoing From address                        |
| `channelId`      | Optional non-empty Flue instance id; omitted means per-thread conversations |

EmailBindings contains only EMAIL and INBOX. Application-generated Env types
remain in the app. Invalid addresses and empty channel ids fail at construction.
Instances capture configuration without a mutable shared admission callback.

## Channel instance

| Member                                 | Contract                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| mailboxAddress, channelId              | Read-only configured values                                                                       |
| handler(agent)                         | Native handler for a registered Flue agent; resolves void after admission                         |
| receive(message, admit)                | Explicit admission; returns emailId, threadId, conversationId, receipt, or undefined on rejection |
| retrieve(emailId)                      | Bounded mail in this mailbox; rejects cross-mailbox access                                        |
| reply(emailId, text, replyAll = false) | Header-selected recipients; one reservation per mail                                              |
| tools(delivery)                        | Advanced delivery-scoped Flue tool definitions; empty for unrelated input                         |

`useCloudflareEmail(channel)` registers the tools and a usage instruction during
agent render. It accepts no overrides and owns neither model selection nor
application approval. Use only one matching channel per mailbox in an agent.

## Model tools

| Tool        | Input and result                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| read_email  | No arguments; bounded email plus messageRef                                                             |
| reply_email | messageRef, text (1–16,000 characters), optional replyAll (false); send result and response termination |

Tools verify stored mailbox, thread, author, and conversation against their
delivery snapshot. A stale messageRef fails before reservation or sending. When
Flue's cursor advances, reread and use the new delivery's reference. Captured
tools never silently retarget to another mail.

Reply uses original Reply-To or falls back to From. Reply-all adds original To/CC
as CC, removing self and duplicates. BCC is never copied. OutgoingEmail contains
to (string or string array), optional cc (string array), from, subject, text, and
threading headers. The model cannot select arbitrary recipients. The package
requires no allowlist; consumer sender adapters can enforce application policy.

## Delivery contract

Ingress emits a signal of type `cloudflare.email.received`, with string attributes
emailId, threadId, owner (MIME From), conversationId, from (SMTP envelope), and to
(mailbox). Headers are not authenticated identities.

Ingress does not set initialData. Existing seeds remain unchanged. If the agent
requires creation data, initialize its fixed conversation through the app first.
Otherwise ordinary Flue admission creates/continues the target.

Destination snapshots persist with inbound metadata and reference indexes.
Retries and known replies retain their original destination after configuration
changes. Unknown references start a new thread. Original-author checks remain;
reply-all does not grant multi-party thread or approval membership.

## Low-level functions

EmailContext explicitly contains INBOX, EMAIL, mailboxAddress, and optional
channelId. It is not an Env alias. These primitives share the factory's implementation:

- receiveEmail(message, context, admit).
- retrieveEmail(context, emailId).
- retrieveThreadEmail(context, threadId, owner, emailId).
- replyToEmail(context, emailId, text, replyAll?).
- indexThreadMessage(context, messageId, threadId, owner, conversationId?).
- readableEmailText({ text?, html? }).

Callers own authentication when exposing advanced primitives. Use the hook for
model access instead of exposing arbitrary storage ids.

## Persisted format

| Prefix                      | Contents                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| inbound/<emailId>.eml       | Immutable RFC bytes; envelope/thread metadata and additive conversationId |
| message-index/<digest>.json | Mailbox-scoped Message-ID → thread, owner, additive conversationId        |
| receipts/<emailId>.json     | Dispatch receipt, threadId, conversationId                                |
| replies/<emailId>.json      | Sending reservation or sent provider message id                           |
| legacy-links/<emailId>.json | Optional application migration link                                       |

Missing conversationId means the original `cloudflare-thread:<threadId>` target.
Hashes and key prefixes are unchanged. No automatic rewrite, replay, or deletion
occurs. Local outbox, HITL, artifacts, and imported history belong to the example.
