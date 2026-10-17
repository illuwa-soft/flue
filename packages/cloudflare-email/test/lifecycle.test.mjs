import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRetirement, inspectLifecycle } from '../scripts/lifecycle.mjs';

const config = {
	status: 'active',
	repository: 'illuwa-soft/flue',
	reviewedAt: '2026-10-17',
	reviewAfterDays: 30,
	upstream: {
		repository: 'withastro/flue',
		discussion: 864,
		pullRequest: 999,
		blueprint: 'blueprints/channel--cloudflare-email.md',
	},
	successor: null,
};
const manifest = {
	name: '@illuwa-soft/flue-cloudflare-email',
	version: '0.1.0',
	peerDependencies: { '@flue/runtime': '^2.3.0' },
};
const fetchImpl = async (url) => {
	if (url.includes('runtime')) return Response.json({ 'dist-tags': { latest: '2.3.0' } });
	if (url.endsWith('/graphql'))
		return Response.json({
			data: {
				repository: {
					discussion: {
						url: 'https://github.com/withastro/flue/discussions/864',
						closed: false,
						author: { login: 'owner' },
						comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
					},
				},
			},
		});
	if (url.includes('/contents/'))
		return Response.json({ name: 'channel--cloudflare-email.md', sha: 'official-sha' });
	if (url.includes('/pulls/'))
		return Response.json({
			merged_at: '2026-10-17T00:00:00Z',
			html_url: 'https://github.com/withastro/flue/pull/999',
		});
	return Response.json({
		versions: { '0.1.0': {}, '1.0.0': {} },
		'dist-tags': { latest: '0.1.0' },
	});
};

test('merge/official source detection requests review and never authorizes automatic retirement', async () => {
	const report = await inspectLifecycle(config, manifest, {
		fetchImpl,
		now: Date.parse('2026-10-18'),
		verification: 'success',
	});
	assert.equal(report.status, 'active');
	assert.ok(report.attention.some((item) => item.includes('Verify a released successor')));
	assert.ok(report.attention.some((item) => item.includes('source presence')));
	await assert.rejects(() => checkRetirement(config, manifest, { fetchImpl }), /migration-ready/);
});

test('a reviewed, published and consumer-tested successor is required before deprecation advice', async () => {
	const next = {
		...config,
		status: 'migration-ready',
		successor: {
			name: '@flue/cloudflare-email',
			version: '1.0.0',
			verifiedAt: '2026-10-18',
			consumerTested: true,
			storageReviewed: true,
		},
	};
	const result = await checkRetirement(next, manifest, { fetchImpl });
	assert.equal(result.automatic, false);
	assert.match(result.command, /^npm deprecate/);
	await assert.rejects(
		() =>
			checkRetirement(
				{ ...next, successor: { ...next.successor, consumerTested: false } },
				manifest,
				{ fetchImpl },
			),
		/real consumer/,
	);
	await assert.rejects(
		() =>
			checkRetirement(next, manifest, { fetchImpl: async () => new Response('', { status: 404 }) }),
		/not published/,
	);
});

test('outages fail the monitor instead of being reported as an absent upstream integration', async () => {
	await assert.rejects(
		() =>
			inspectLifecycle(config, manifest, {
				fetchImpl: async () => new Response('', { status: 503 }),
			}),
		/HTTP 503/,
	);
	const retired = await inspectLifecycle({ ...config, status: 'retired' }, manifest, {
		fetchImpl: async () => assert.fail('must not fetch'),
	});
	assert.deepEqual(retired.attention, []);
});

test('an official source blueprint requires a published CLI and explicitly verified consumer', async () => {
	const ready = {
		...config,
		status: 'migration-ready',
		successor: {
			kind: 'blueprint',
			url: 'https://flueframework.com/cli/blueprints/cloudflare-email.md',
			cliVersion: '3.0.0',
			verifiedAt: '2026-10-18',
			consumerTested: true,
			storageReviewed: true,
		},
	};
	const remote = async (url) => {
		if (url.startsWith('https://registry.npmjs.org/'))
			return Response.json({ versions: { '3.0.0': {} } });
		return new Response('# Official verified blueprint');
	};
	assert.equal((await checkRetirement(ready, manifest, { fetchImpl: remote })).automatic, false);
	await assert.rejects(
		() =>
			checkRetirement(ready, manifest, {
				fetchImpl: async () => new Response('', { status: 404 }),
			}),
		/not published/,
	);
});

test('overdue reviews and a new unsupported Flue major remain visible maintenance work', async () => {
	const remote = async (url) => {
		if (url.includes('runtime')) return Response.json({ 'dist-tags': { latest: '3.0.0' } });
		return fetchImpl(url);
	};
	const report = await inspectLifecycle(config, manifest, {
		fetchImpl: remote,
		now: Date.parse('2026-12-17'),
		verification: 'success',
	});
	assert.ok(report.attention.some((item) => item.includes('review is due')));
	assert.ok(report.attention.some((item) => item.includes('outside the declared peer range')));
});
