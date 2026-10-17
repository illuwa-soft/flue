import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const example = path.join(root, 'examples/cloudflare-email');
const baseline = '90f3b6c27eeaef217bd59883e58bdd822d4398f8';
const files = [
	'src/history.ts',
	'src/hitl.ts',
	'src/local-model.ts',
	'src/agents/email-assistant.ts',
	'src/cloudflare.ts',
];

/** Read the frozen previous contract rather than reconstructing upgrade history. / 업그레이드 이력을 재구성하지 않고 고정된 이전 계약을 읽습니다. */
function previous(file) {
	try {
		return execFileSync('git', ['show', `${baseline}:examples/cloudflare-email/${file}`], {
			cwd: root,
			encoding: 'utf8',
			stdio: 'pipe',
		});
	} catch (error) {
		if (error.status === 128) return '';
		throw error;
	}
}

/** Emit a complete replacement hunk, including newly introduced modules. / 새 모듈을 포함한 완전한 교체 diff를 생성합니다. */
function diff(file, before, after) {
	const oldLines = before.trimEnd().split('\n');
	if (!before) oldLines.length = 0;
	const newLines = after.trimEnd().split('\n');
	if (!after) newLines.length = 0;
	let from = `a/${file}`;
	if (!before) from = '/dev/null';
	let to = `b/${file}`;
	if (!after) to = '/dev/null';
	let oldStart = 1;
	if (!before) oldStart = 0;
	let newStart = 1;
	if (!after) newStart = 0;
	return [
		`--- ${from}`,
		`+++ ${to}`,
		`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join('\n');
}

let modules = '';
const changes = [];
for (const file of files) {
	const source = await readFile(path.join(example, file), 'utf8');
	modules += `\n### ${file}\n\n\`\`\`ts\n${source.trimEnd()}\n\`\`\`\n`;
	changes.push(diff(file, previous(file), source));
}
changes.push(diff('src/channels/email.ts', previous('src/channels/email.ts'), ''));
const oldPackage = JSON.parse(previous('package.json'));
const newPackage = JSON.parse(await readFile(path.join(example, 'package.json'), 'utf8'));

/** Keep published consumer instructions independent of workspace protocols. */
function publicDependencies(dependencies) {
	const versions = {
		'@flue/runtime': '^2.3.0',
		'@flue/vite': '^2.3.0',
		'@illuwa-soft/flue-cloudflare-email': '^0.1.0',
	};
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, specifier]) => {
			if (!specifier.startsWith('workspace:')) return [name, specifier];
			if (!versions[name]) throw new Error(`Unmapped workspace dependency: ${name}`);
			return [name, versions[name]];
		}),
	);
}
changes.push(
	diff(
		'package.json',
		JSON.stringify(
			{ dependencies: oldPackage.dependencies, devDependencies: oldPackage.devDependencies },
			null,
			2,
		),
		JSON.stringify(
			{
				dependencies: publicDependencies(newPackage.dependencies),
				devDependencies: publicDependencies(newPackage.devDependencies),
			},
			null,
			2,
		),
	),
);
changes.push(
	diff(
		'wrangler.jsonc',
		previous('wrangler.jsonc'),
		await readFile(path.join(example, 'wrangler.jsonc'), 'utf8'),
	),
);

const previousGuide = execFileSync(
	'git',
	['show', `${baseline}:blueprints/channel--cloudflare-email.md`],
	{ cwd: root, encoding: 'utf8' },
).split('\n## Upgrade Guide\n')[1];
if (!previousGuide) throw new Error('Previous upgrade history is missing.');

const introduction = `---
{ "kind": "channel", "version": 4, "website": "https://developers.cloudflare.com/email-service/" }
---

# Cloudflare Email Service and threaded HITL

## Goal and boundaries

Add Cloudflare-only native email ingress and an application-owned approval
example. One known email thread maps to one Flue conversation. Each incoming
mail retains its own immutable source, retrieval target and idempotency key.
There is no HTTP webhook, new runtime approval API, or provider-agnostic client.

Ordinary email questions get conversational replies with thread history. Only
requested document artifacts use the approval gate. The example proposes exact
contents, ends the response while waiting, and writes an R2 document artifact
only after a later valid human email. Adapt
the artifact operation to a real domain action only with the user's approval
and an idempotent external execution contract.

## Inspect and install

Read project instructions. Select the first existing source root from .flue/,
src/, or the root. Confirm the Cloudflare target and inspect agents, app.ts,
cloudflare.ts, Wrangler resources, migrations, environment and sender policies.
Preserve existing Worker handlers and application customizations.

Install @illuwa-soft/flue-cloudflare-email@^0.1.0 and compatible published
@flue/runtime. Install postal-mime and valibot for the optional application
history/HITL example, and @earendil-works/pi-ai for its local faux model.
The reusable email implementation lives only in the npm package; do not copy a
channels/email.ts implementation into the consumer. Pi provides the same faux
provider mechanism already used by Flue's offline examples. Keep the installed
Flue/Vite toolchain. Add EMAIL_MODE: "live" to Wrangler vars, plus INBOX (R2),
EMAIL (send_email), EMAIL_RECIPIENT and EMAIL_REPLY_ALLOWED_SENDERS. An empty
allowlist disables replies. Generate package-local Worker Env types with
wrangler types; do not hand-author Env or generated FLUE_* bindings.

The complete generated modules below are relative to the selected source root.
This package-backed guide has no generated primary-file marker; compare the
dependency version and application wiring during updates. Merge the default
email handler with existing non-HTTP handlers; keep HTTP composition in app.ts.
The dispatch-only agent needs no HTTP mount. If HTTP conversation/state routes
are exposed, authenticate them: email ids and thread ids are not capabilities.

## Complete source modules
`;

const ending = `
## Domain and deployment

Configure the exact receiving address in Email Routing to send to the deployed
Worker. Preserve/back up existing routing and do not mutate resources without
user authorization. Arbitrary-recipient Email Sending currently requires
Workers Paid, beta access and a sending domain. Keep nodejs_compat and a
compatibility date supported by the installed workerd. Append a new SQLite
migration only if adding a new agent identity; never rewrite deployed history.

## Approval protocol and security

HTML-only bodies are parsed into readable text, with blockquotes kept quoted.
Ordinary conversation is allowed while an approval is waiting and cannot
change that pending plan. A plain answer does not require a document approval.

The first new, unquoted plain-text line must contain one exact command:

- 승인 <32-character code> or approve <code>
- 수정 <code>: replacement instruction or revise <code>: instruction
- 취소 <code> or cancel <code>

Each request stores exact title/content, a fresh 128-bit bearer code, revision
and a 24-hour expiry. A revision consumes the old request and requires a new
code. The application checks the persisted participant and current request,
uses conditional R2 writes to select one decision, and executes stored
arguments without asking the model to reinterpret approval. Thread references
are correlation only. A From allowlist is not sender authentication: the code
is a secret bearer capability delivered to the authorized mailbox. Do not leak
it through public state endpoints, logs or untrusted tools.

Known In-Reply-To and References (including sent Message-IDs) restore a thread
only for its original author. Subjects never select a conversation. Unknown
references start a new thread; conflicting references or another participant
are rejected. Forwarding and multi-party approval are not supported.

The source limit is 1 MiB; retrieval text is capped at 16,000 characters. MIME
From is allowlisted for reply destinations (the SMTP envelope may be a bounce
address); Reply-To and model-selected recipients are ignored. Automated/list
mail cannot receive replies. Attachment content is not exposed.

The final artifact uses the approval id as a deterministic key and a
conditional create. Local and live transports retain one reply per incoming
mail. Interrupted sends remain uncertain and require reconciliation before
retry: no R2/email cross-service exactly-once guarantee is claimed.

## Local verification

Use the complete runnable examples/cloudflare-email project for dev:local,
email:local, outbox:local and test:workerd. Its local server binds 127.0.0.1,
overrides EMAIL_MODE to local in the process, uses a faux model, simulates
outgoing email in R2 and persists state under .wrangler/local-hitl. It never
calls a model or email service. Restart the process while waiting, then approve
the same request and verify the result. The committed deployment default is
live; a local-mode build alone does not select simulation.

Generate Env, typecheck and build; run assertions for duplicate mail,
cross-thread/participant access, exact approvals, quoted/stale/expired codes,
revision, cancellation, concurrent decisions and idempotent artifacts. Run
the built Worker through the native email simulator, actual Flue Durable Object
and faux model; verify all turns settle completed, including after restart.
Test actual domain routing and mailbox delivery separately when authorized.

## Updating existing integrations

Inspect an unmarked implementation and compare it with the complete current
guide. Preserve sender policy, existing handlers, resource identities and
migrations. Update the dependency instead of maintaining a copied email
adapter; remove the old source copy after its callers use the package. Initial creation
data changes from emailId to threadId/owner: old v1 per-mail conversations are
not resumed as v2 tasks. New ingress uses the cloudflare-thread: prefix; do not
replay old mail or migrate an uncertain operation into an approved state.

For an explicitly selected old v1 thread, the runnable example provides an
administrator-only POST /api/admin/legacy-thread with rootEmailId and emailIds.
It accepts at most 50 allowlisted-author messages connected by known reply
references, indexes old incoming/sent Message-IDs and supplies bounded prior
human text to the new conversation. It never modifies original bytes, reruns
old mail or imports an approval. Do not expose this function without operator
authentication and do not join threads by subject.

For a clean consumer, copy the complete modules, merge bindings/dependencies,
and build. For an existing consumer, compare against its previous version and
apply the same contract without overwriting unrelated application code. The
upgrade diff uses the example's baseline configuration/dependency fragments;
merge those additions into the consumer's actual manifests.

## Upgrade Guide

${previousGuide.trim()}

### Version 4 — 2026-10-17

Use the independently released community package as the sole email
implementation. Remove the copied adapter, import the public package in
application-owned code and keep HITL/history policy in the application. Consumers
can use published Flue without this fork. The full v3-to-v4 source/configuration
delta follows.

\`\`\`diff
${changes.join('\n')}
\`\`\`
`;

await writeFile(
	path.join(root, 'blueprints/channel--cloudflare-email.md'),
	introduction + modules + ending,
);
console.log(
	'Regenerated package-backed Cloudflare Email Blueprint v4 from the executable example and frozen v3 baseline.',
);
