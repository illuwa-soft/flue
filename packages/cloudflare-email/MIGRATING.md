# Package migration and eventual official adoption

## Upgrade from 0.1 to 0.2

0.2 changes the public configuration and reply policy. Review before updating
a live consumer; this is not a transparent patch release.

1. Replace the Env-shaped bindings/admit factory with actual
   `bindings: { EMAIL, INBOX }`, `mailboxAddress`, and optional `channelId`.
2. Register `email.handler(Agent)` on the native Worker entrypoint. Consume the
   same instance with `useCloudflareEmail(email)` in the agent. Remove duplicate
   model reply tools when adopting the hook.
3. Move local simulation and any required outbound allowlist into an injected
   EMAIL sender adapter. The package no longer reads EMAIL_MODE or requires
   EMAIL_REPLY_ALLOWED_SENDERS. Reply now honors Reply-To; reply-all can send to
   original To/CC participants. Review the application's intended send scope.
4. For low-level functions, pass explicit EmailContext (EMAIL, INBOX,
   mailboxAddress, optional channelId) rather than the old Env-shaped object.
   Pass custom admission to `receive(message, admit)` at the call site.
5. Read threadId/owner from each delivery, not useInitialData. The package does
   not write initialData; initialize a fixed target first if its agent requires
   creation data. Drain old queued deliveries before changing to the new signal
   attribute contract. Do not replay settled messages to make new attributes.
6. Preserve resource identities and all existing R2 keys. conversationId is
   additive metadata. Existing records/indexes without it retain their original
   cloudflare-thread target. Known threads do not move merely because channelId
   changes; explicitly plan a separate migration if moving them is required.
7. Run tests, a Worker build, and the packed-consumer check against public Flue.
   Verify both per-thread and fixed routing before deployment.

Rollback requires the old configuration and sender policy as well as the old
package version. Reconcile pending or uncertain sends before changing versions;
do not clear reservations or rewrite inbound bytes. New fixed-room conversations
are not understood as fixed routing by 0.1, so drain them before rollback.

## Adopt an official successor

**Current state: active community maintenance. No successor has been selected.**
Do not replace this sentence with an assumed `@flue/*` name until a real package
or supported source integration has been released and tested.

## Prepare migration

1. Confirm what upstream actually shipped. A merged PR, a closed discussion or
   a source file is not proof of a released, compatible replacement.
2. Install the exact successor release in a clean consumer and run the same
   typecheck, Worker build, threaded conversation and reply tests.
3. Compare mailbox/sender authorization, creation data, conversation ids, MIME
   handling, reference indexes, reply reservations and failure semantics.
4. Review persisted storage. Retain the original R2 bucket, source mail,
   thread/message indexes, receipts and uncertain-send records. The app-owned
   HITL/history/artifact state may require its own migration. Do not treat a
   library rename as permission to replay mail, execute approvals or reset data.
5. Write the concrete import/configuration and rollback instructions below.
   Switch the example to the successor and prove that the old package is no
   longer needed before removing its source.

## Record an explicit readiness decision

Change `lifecycle.json` only after those checks pass:

```json
{
  "status": "migration-ready",
  "successor": {
    "name": "ACTUAL_RELEASED_PACKAGE",
    "version": "EXACT_VERIFIED_VERSION",
    "verifiedAt": "YYYY-MM-DD",
    "consumerTested": true,
    "storageReviewed": true
  }
}
```

Merge these fields into the existing file. The values above are placeholders,
not a usable successor. Run:

```sh
pnpm --filter @illuwa-soft/flue-cloudflare-email retirement:check
```

The check verifies the successor version exists in the public registry and
requires the human-recorded consumer/storage evidence. It prints a deprecation
command; **it does not execute it**. npm OIDC publishing credentials do not
authorize `npm deprecate`; use an authorized owner's interactive authentication.

## Deprecate without breaking existing installs

After the successor is available and the migration guide is concrete, run the
reviewed `npm deprecate` command and verify the registry's `deprecated` field.
Use a message naming the real successor and migration guide URL. Deprecation
adds installation guidance while keeping historical versions downloadable.
**Do not unpublish** the package as a cleanup shortcut.

Record status `retired` in the source checkpoint after verification. Maintain a
short, linked migration notice even if source is archived. If upstream ships a
source blueprint instead of a separate package, record `kind: "blueprint"`,
the actual tested `cliVersion`, and
`url: "https://flueframework.com/cli/blueprints/cloudflare-email.md"`, plus the
same verification fields. The check requires that CLI version to be published
and the official guide to be available. Human consumer/storage verification is
still required; a source file in main is insufficient.

## Remove the owned implementation cleanly

Only after consumers have moved:

1. Replace the example's dependency/imports and update its tests and lockfile.
2. Remove this package directory (or retain only a documentation tombstone with
   no publishable `package.json`).
3. Remove `.github/workflows/cloudflare-email-ci.yml`,
   `cloudflare-email-maintenance.yml` and `cloudflare-email-release.yml` once
   no community release/maintenance lane is needed.
4. Remove the community-only root README/AGENTS links and generated catalog
   references if upstream now owns them. Keep upstream contributions that were
   accepted; do not delete an official integration as part of fork cleanup.
5. Search for `@illuwa-soft/flue-cloudflare-email` and the removed package path,
   regenerate the workspace lockfile, and rerun the successor consumer tests.
6. Close the owned maintenance issue with the official release and migration
   links. Archive the fork only if it has no remaining responsibilities.

There is one implementation to remove, not a second copied email adapter. No
release or monitoring workflow automatically performs these destructive steps.

## Concrete successor instructions

Not selected yet. This section must name the tested release, exact import and
configuration changes, persisted-format compatibility, validation evidence and
rollback procedure before deprecation is recommended.
