# Maintain and release the community package

Run these commands from the repository root on `community`. The package has its
own SemVer and release lane; never run the upstream monorepo's recursive publish
commands to release this one integration.

## Ownership and reminders

- Implementation: `packages/cloudflare-email/src/channel.ts` only.
- Consumer policy/example: `examples/cloudflare-email` imports the package.
- Review checkpoint: `packages/cloudflare-email/lifecycle.json`.
- Upstream request: [Discussion #864](https://github.com/withastro/flue/discussions/864).
- Tracking issue: `[cloudflare-email] Maintenance and upstream adoption`, assigned
  to the configured maintainer in **illuwa-soft/flue**, never upstream.

The weekly workflow checks the packed package against public Flue, inspects
upstream discussion/PR/blueprint state and raises or updates one deduplicated
issue when attention is needed. It also reminds the maintainer after **30 days**
without a recorded review. `pullRequest` is initially null because no upstream
PR exists; fill it in when a real PR is opened.

After review, update `reviewedAt`, acknowledge reviewed upstream evidence in
the config when applicable, and close the issue after resolving its reasons.
Copy reviewed `evidence.replyId`, `blueprintSha`, `mergeSha` or `discussionState`
from the report into the corresponding `upstream.acknowledged*` field. New
evidence produces a new reminder; reviewed evidence does not repeatedly reopen
an otherwise resolved issue.
Watch this repository's Issues and Actions notifications. GitHub schedules run
only on the default branch, require Actions to be enabled on forks, and may be
disabled after **60 days of repository inactivity**. A scheduled job is not a
guarantee of permanent unattended operation; the review issue is the handoff.

To inspect without writing a GitHub issue:

```sh
GH_TOKEN="$(gh auth token)" pnpm --filter @illuwa-soft/flue-cloudflare-email maintenance
```

The CI job supplies its repository-scoped token. Do not paste tokens into code,
release notes, workflow inputs or issue bodies. API errors fail the job rather
than being classified as “no upstream changes.”

## Verify a release

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=cloudflare-email-example...
pnpm --filter @illuwa-soft/flue-cloudflare-email check:types
pnpm --filter @illuwa-soft/flue-cloudflare-email test
pnpm --filter cloudflare-email-example cf-typegen
pnpm --filter cloudflare-email-example check:types
pnpm --filter cloudflare-email-example test
pnpm --filter cloudflare-email-example test:workerd
pnpm --filter @illuwa-soft/flue-cloudflare-email test:consumer
pnpm --filter @illuwa-soft/flue-cloudflare-email release:check
```

The consumer check packs the real distribution, installs it **outside this
workspace** with published `@flue/runtime` and `@flue/vite`, generates Env,
typechecks, runs assertions, builds the Worker, and runs the full local
conversation/HITL test. It never substitutes the fork runtime. The initial
baseline is `2.3.0`; set `FLUE_CONSUMER_VERSION='^2.3.0'` to test the latest
supported minor. Installing public dependencies needs registry access; the
model/email tests themselves are offline.

Add an English changelog entry and bump only this package when publishing a
change. Regenerate the lockfile and inspect the actual tarball. Preserve storage
keys and conversation identities unless a versioned migration explicitly
changes them. Update the tested peer range only with consumer evidence.

## First package publication

The npm organization and package are separate from GitHub. Creating a GitHub
repository or an npm organization does not authenticate this workstation.

1. Log in to npm using the organization's authorized personal account:

   ```sh
   npm login --auth-type=web --registry=https://registry.npmjs.org
   npm whoami --registry=https://registry.npmjs.org
   npm org ls illuwa-soft --json
   ```

2. Complete release verification above, then pack **only this package**:

   ```sh
   pnpm --filter @illuwa-soft/flue-cloudflare-email pack --pack-destination /absolute/path/to/release
   ```

3. Stage the resulting tarball, review it, and approve with the owner's 2FA:

   ```sh
   npm stage publish /absolute/path/to/release/illuwa-soft-flue-cloudflare-email-0.1.0.tgz --access public
   npm stage list @illuwa-soft/flue-cloudflare-email
   npm stage approve STAGE_ID
   npm view @illuwa-soft/flue-cloudflare-email@0.1.0 version dist.integrity
   ```

   Use the tarball filename printed by `pack`. A staged candidate is **not a
   published package**. If staging/approval has an uncertain outcome, inspect
   stages and registry state before retrying. Never republish the same version.

## Subsequent releases from GitHub Actions

Configure npm Trusted Publishing for this package and the exact repository
`illuwa-soft/flue`, workflow `cloudflare-email-release.yml`. Use a GitHub-hosted
runner, Node >=22.14 and npm >=11.5.1 (the workflow pins a tested newer CLI).
The package's repository URL must match the fork, not `withastro/flue`.

Select stage-only permission when you want owner review for every release.
The release workflow is **manual**, runs verification before staging, and does
not publish on a branch push or deploy the example Worker. OIDC removes the need
for a long-lived npm token or a separate bot npm account. Approving a stage
still requires human presence; OIDC is not an approval credential.

After staging, approve the candidate on npm, verify the public version, and
record the version/tag and release notes. GitHub OIDC configuration may need
renewal if its first successful publish does not occur within npm's current
validation window; see the [live trusted-publisher guide](https://docs.npmjs.com/trusted-publishers).

## If upstream does not merge

Continue independent releases. The package never depends on a maintainer reply
or on running a forked Flue runtime. Keep discussion feedback in the tracking
config, maintain the verified Flue range and address compatibility failures.
Do not delete the integration or stop verification solely because a PR closes.

## If upstream merges

Follow [MIGRATING.md](./MIGRATING.md). Merge/source detection opens a review task;
it does not silently swap package names, deprecate, delete, or unpublish anything.
