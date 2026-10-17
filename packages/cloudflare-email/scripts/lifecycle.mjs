import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const directory = path.resolve(import.meta.dirname, '..');
const issueTitle = '[cloudflare-email] Maintenance and upstream adoption';

/** Keep registry names as data, not arbitrary credential-bearing URLs. */
function registryUrl(name) {
	assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
	return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
}

/** Treat only a real 404 as absence; outages and permission failures remain failures. */
async function jsonRequest(url, { fetchImpl = fetch, ...options } = {}) {
	const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(30_000) });
	if (response.status === 404) return null;
	if (!response.ok)
		throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname}: HTTP ${response.status}`);
	const value = await response.json();
	if (value.errors?.length) throw new Error(`API query failed at ${new URL(url).pathname}`);
	return value;
}

/** Report evidence and reminders without deciding that merge means a safe replacement. */
export async function inspectLifecycle(
	config,
	manifest,
	{ fetchImpl = fetch, now = Date.now(), verification = 'not-run' } = {},
) {
	assert.equal(config.repository, 'illuwa-soft/flue');
	assert.equal(manifest.name, '@illuwa-soft/flue-cloudflare-email');
	if (config.status === 'retired') return { status: 'retired', attention: [], verification };
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	const headers = { Accept: 'application/vnd.github+json' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const [owner, repo] = config.upstream.repository.split('/');
	const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){url closed author{login} answer{url} comments(last:50){nodes{id url author{login}} pageInfo{hasPreviousPage}}}}}`;
	const discussionResult = await jsonRequest('https://api.github.com/graphql', {
		fetchImpl,
		method: 'POST',
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables: { owner, repo, number: config.upstream.discussion } }),
	});
	const discussion = discussionResult?.data?.repository?.discussion;
	if (!discussion) throw new Error('Upstream discussion could not be read.');
	const blueprint = await jsonRequest(
		`https://api.github.com/repos/${config.upstream.repository}/contents/${config.upstream.blueprint}?ref=main`,
		{ headers, fetchImpl },
	);
	let pullRequest = null;
	if (config.upstream.pullRequest)
		pullRequest = await jsonRequest(
			`https://api.github.com/repos/${config.upstream.repository}/pulls/${config.upstream.pullRequest}`,
			{ headers, fetchImpl },
		);
	const published = await jsonRequest(registryUrl(manifest.name), { fetchImpl });
	const flue = await jsonRequest(registryUrl('@flue/runtime'), { fetchImpl });
	const latestFlue = flue?.['dist-tags']?.latest;
	if (!latestFlue) throw new Error('Published Flue runtime metadata could not be read.');
	const supportedMajor = /^\^(\d+)\./.exec(manifest.peerDependencies?.['@flue/runtime'] ?? '')?.[1];
	if (!supportedMajor)
		throw new Error('Review the peer-range monitor before using a non-caret major range.');
	const attention = [];
	if (latestFlue.split('.')[0] !== supportedMajor)
		attention.push(
			`A new Flue major (${latestFlue}) is outside the declared peer range; review compatibility without silently widening it.`,
		);
	if (['failure', 'cancelled', 'skipped'].includes(verification))
		attention.push('Compatibility/build checks did not pass; inspect the linked workflow run.');
	if (!published?.versions?.[manifest.version])
		attention.push(
			`Release bootstrap/review needed: ${manifest.name}@${manifest.version} is not published.`,
		);
	const reviewed = Date.parse(`${config.reviewedAt}T00:00:00Z`);
	if (!Number.isFinite(reviewed)) throw new Error('Invalid reviewedAt date.');
	if (now - reviewed >= config.reviewAfterDays * 86400_000)
		attention.push(
			`Maintainer review is due (last reviewed ${config.reviewedAt}; interval ${config.reviewAfterDays} days).`,
		);
	const reply = discussion.comments.nodes
		.filter((comment) => comment.author?.login && comment.author.login !== discussion.author?.login)
		.at(-1);
	if (reply && reply.id !== config.upstream.acknowledgedReplyId)
		attention.push(`Upstream discussion has external feedback: ${reply.url}`);
	if (discussion.comments.pageInfo.hasPreviousPage)
		attention.push('Review older upstream comments as well; the report covers the latest 50.');
	const discussionState = `${discussion.closed}:${discussion.answer?.url ?? ''}`;
	if (
		(discussion.closed || discussion.answer) &&
		discussionState !== config.upstream.acknowledgedDiscussionState
	)
		attention.push(`Upstream discussion was closed/answered: ${discussion.url}`);
	if (
		pullRequest?.merged_at &&
		(pullRequest.merge_commit_sha ?? pullRequest.merged_at) !== config.upstream.acknowledgedMergeSha
	)
		attention.push(
			`Upstream PR merged: ${pullRequest.html_url}. Verify a released successor; do not delete or deprecate automatically.`,
		);
	if (config.upstream.pullRequest && !pullRequest)
		throw new Error('Configured upstream PR was not found.');
	if (blueprint && blueprint.sha !== config.upstream.acknowledgedBlueprintSha)
		attention.push(
			'An upstream Cloudflare email blueprint exists. Assess migration; source presence is not release compatibility.',
		);
	return {
		status: config.status,
		verification,
		attention,
		discussion: discussion.url,
		latestExternalReply: reply?.url ?? null,
		upstreamBlueprint: Boolean(blueprint),
		pullRequest: pullRequest?.html_url ?? null,
		mergedAt: pullRequest?.merged_at ?? null,
		publishedVersion: published?.['dist-tags']?.latest ?? null,
		latestFlue,
		evidence: {
			replyId: reply?.id ?? null,
			blueprintSha: blueprint?.sha ?? null,
			mergeSha: pullRequest?.merge_commit_sha ?? pullRequest?.merged_at ?? null,
			discussionState,
		},
	};
}

/** Require concrete release and storage-migration evidence before suggesting deprecation. */
export async function checkRetirement(config, manifest, { fetchImpl = fetch } = {}) {
	assert.equal(
		config.status,
		'migration-ready',
		'Set status to migration-ready only after a human-reviewed migration.',
	);
	const next = config.successor;
	assert.ok(next?.verifiedAt, 'A published successor and dated verification are required.');
	assert.equal(next.consumerTested, true, 'Install/build the successor in a real consumer first.');
	assert.equal(
		next.storageReviewed,
		true,
		'Review bindings, persisted keys, approvals and thread identity first.',
	);
	if (next.kind === 'blueprint') {
		assert.equal(next.url, 'https://flueframework.com/cli/blueprints/cloudflare-email.md');
		assert.ok(next.cliVersion, 'A tested released CLI version is required.');
		const cli = await jsonRequest(registryUrl('@flue/cli'), { fetchImpl });
		assert.ok(
			cli?.versions?.[next.cliVersion],
			'The tested official CLI version is not published.',
		);
		const guide = await fetchImpl(next.url, { signal: AbortSignal.timeout(30_000) });
		assert.ok(guide.ok && (await guide.text()).trim(), 'The official blueprint is not available.');
		return {
			successor: `@flue/cli@${next.cliVersion} / channel cloudflare-email`,
			command: `npm deprecate '${manifest.name}' 'Use the official Cloudflare email blueprint with @flue/cli@${next.cliVersion}; follow the repository migration guide.'`,
			automatic: false,
		};
	}
	assert.ok(next.name && next.version, 'A published successor package/version is required.');
	assert.notEqual(next.name, manifest.name);
	const published = await jsonRequest(registryUrl(next.name), { fetchImpl });
	assert.ok(
		published?.versions?.[next.version],
		'The selected successor version is not published.',
	);
	return {
		successor: `${next.name}@${next.version}`,
		command: `npm deprecate '${manifest.name}' 'Use ${next.name}@${next.version}; follow the migration guide in the repository.'`,
		automatic: false,
	};
}

/** Keep one assigned, deduplicated issue in the owned fork; never post to upstream automatically. */
async function reportIssue(config, report) {
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!token) throw new Error('GH_TOKEN is required for --write.');
	assert.equal(config.repository, 'illuwa-soft/flue');
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'Content-Type': 'application/json',
	};
	const base = `https://api.github.com/repos/${config.repository}`;
	let existing;
	for (let page = 1; ; page++) {
		const issues = await jsonRequest(`${base}/issues?state=all&per_page=100&page=${page}`, {
			headers,
		});
		if (!issues) throw new Error('Enable Issues on the community repository.');
		existing = issues.find((issue) => !issue.pull_request && issue.title === issueTitle);
		if (existing || issues.length < 100) break;
	}
	if (!report.attention.length) return { action: 'no-action', issue: existing?.html_url ?? null };
	const fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
	const marker = `<!-- cloudflare-email:${fingerprint} -->`;
	if (existing?.state === 'open' && existing.body?.includes(marker))
		return { action: 'unchanged', issue: existing.html_url };
	const run = process.env.GITHUB_RUN_ID;
	let runLink = 'Manual status check';
	if (run) runLink = `https://github.com/${config.repository}/actions/runs/${run}`;
	const body = [
		marker,
		'# Community email package maintenance',
		...report.attention.map((item) => `- ${item}`),
		`\nVerification: **${report.verification}**. Run: ${runLink}`,
		'\nSee packages/cloudflare-email/MAINTAINING.md and MIGRATING.md. Record completed review in lifecycle.json before closing a recurring review reminder.',
		'\nMerge alone is not a retirement signal. This job never publishes, deprecates, deletes, rewrites live storage, or opens upstream PRs.',
	].join('\n');
	let issue;
	if (existing)
		issue = await jsonRequest(`${base}/issues/${existing.number}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ state: 'open', body }),
		});
	if (!existing)
		issue = await jsonRequest(`${base}/issues`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ title: issueTitle, body, assignees: [config.maintainer] }),
		});
	return { action: 'reported', issue: issue.html_url };
}

/** Validate the intended release boundary without publishing or staging a write. */
async function releaseCheck(config, manifest) {
	assert.equal(
		config.status,
		'active',
		'Independent publication is disabled outside active maintenance.',
	);
	assert.equal(manifest.name, '@illuwa-soft/flue-cloudflare-email');
	if (process.env.RELEASE_VERSION)
		assert.equal(
			manifest.version,
			process.env.RELEASE_VERSION,
			'The requested version must match the checked-out manifest.',
		);
	assert.equal(manifest.repository.url, 'git+https://github.com/illuwa-soft/flue.git');
	for (const file of [
		'dist/channel.mjs',
		'dist/channel.d.mts',
		'README.md',
		'API.md',
		'MAINTAINING.md',
		'MIGRATING.md',
		'LICENSE',
		'NOTICE',
	])
		await readFile(path.join(directory, file));
	const metadata = await jsonRequest(registryUrl(manifest.name));
	assert.ok(
		!metadata?.versions?.[manifest.version],
		'This version already exists; do not retry or overwrite it.',
	);
	return {
		name: manifest.name,
		version: manifest.version,
		status: 'ready-for-authorized-stage-or-publish',
	};
}

/** Run source-checkout maintenance commands; publishing remains an explicit separate operation. */
async function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: { write: { type: 'boolean' }, verification: { type: 'string', default: 'not-run' } },
	});
	const config = JSON.parse(await readFile(path.join(directory, 'lifecycle.json'), 'utf8'));
	const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
	const command = positionals[0] ?? 'status';
	if (command === 'release-check')
		return console.log(JSON.stringify(await releaseCheck(config, manifest), null, 2));
	if (command === 'retirement-check')
		return console.log(JSON.stringify(await checkRetirement(config, manifest), null, 2));
	assert.equal(command, 'status');
	const report = await inspectLifecycle(config, manifest, { verification: values.verification });
	console.log(JSON.stringify(report, null, 2));
	if (values.write) console.log(JSON.stringify(await reportIssue(config, report)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
