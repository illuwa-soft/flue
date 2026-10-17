# Maintain and release the community package

Run these commands from the repository root on `community`. The package has its
own SemVer and release lane; never run the upstream monorepo's recursive publish
commands to release this one integration.

## Ownership and reminders

- Implementation: `packages/cloudflare-email/src/` only (channel composition and mail primitives).
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
   npm stage publish /absolute/path/to/release/illuwa-soft-flue-cloudflare-email-0.2.0.tgz --access public --registry=https://registry.npmjs.org --@illuwa-soft:registry=https://registry.npmjs.org
   npm stage list @illuwa-soft/flue-cloudflare-email
   npm stage approve STAGE_ID
   npm view @illuwa-soft/flue-cloudflare-email@0.2.0 version dist.integrity --registry=https://registry.npmjs.org --@illuwa-soft:registry=https://registry.npmjs.org
   ```

   Use the tarball filename printed by `pack`. A staged candidate is **not a
   published package**. If staging/approval has an uncertain outcome, inspect
   stages and registry state before retrying. Never republish the same version.

## Automatic releases from GitHub Actions

Configure npm Trusted Publishing for this package and the exact repository
`illuwa-soft/flue`, workflow `cloudflare-email-release.yml`. Use a GitHub-hosted
runner, Node >=22.14 and npm >=11.5.1 (the workflow pins a tested newer CLI).
The package's repository URL must match the fork, not `withastro/flue`.

The configured publisher must allow **npm publish**, not only staging. An owner
can establish that relationship with interactive npm 2FA:

```sh
npm trust github @illuwa-soft/flue-cloudflare-email --file cloudflare-email-release.yml --repository illuwa-soft/flue --allow-publish --yes --registry=https://registry.npmjs.org
```

Update the package's stable SemVer and changelog, then push to `community`.
Changes to `packages/cloudflare-email/package.json` trigger the release lane.
It checks registry metadata, runs the complete compatibility matrix, packs only
this package, publishes through OIDC, and reads back its version and integrity.
Ordinary source changes without a version bump are checks, not a new npm release.
An already-published version skips the release; registry outages fail rather than
being classified as an unpublished version. The lane rejects a latest downgrade
and serializes publishing runs. It never deploys the example Worker.

To retry after resolving authentication or CI failure, dispatch
`cloudflare-email-release.yml` on `community`; optional version input asserts the
checkout version. Inspect registry and workflow state before retrying an
uncertain publish. Published versions are immutable and must not be republished.
An accepted npm publish can take several minutes to become publicly visible.
The workflow polls public metadata for that propagation; it never retries the
publish write. If visibility times out, inspect registry processing before any retry.

OIDC uses no stored npm write token. Public source and package support provenance.
The first successful publish must occur within **2 days** of registering the
trusted publisher; otherwise recreate that relationship. See the
[live trusted-publisher guide](https://docs.npmjs.com/trusted-publishers).

## If upstream does not merge

Continue independent releases. The package never depends on a maintainer reply
or on running a forked Flue runtime. Keep discussion feedback in the tracking
config, maintain the verified Flue range and address compatibility failures.
Do not delete the integration or stop verification solely because a PR closes.

## If upstream merges

Follow [MIGRATING.md](./MIGRATING.md). Merge/source detection opens a review task;
it does not silently swap package names, deprecate, delete, or unpublish anything.
