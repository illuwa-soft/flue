import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseDecision, verifyPublishedRelease } from '../scripts/release.mjs';

const manifest = {
	name: '@illuwa-soft/flue-cloudflare-email',
	version: '0.2.0',
	repository: { url: 'git+https://github.com/illuwa-soft/flue.git' },
};
const lifecycle = { status: 'active' };

test('accepted publish waits for public visibility without repeating publication', async () => {
	let reads = 0;
	const result = await verifyPublishedRelease(manifest, {
		attempts: 3,
		wait: async () => {},
		fetchImpl: async () => {
			reads++;
			if (reads < 3) return new Response(null, { status: 404 });
			return Response.json({
				name: manifest.name,
				version: manifest.version,
				dist: { integrity: 'sha512-test' },
			});
		},
	});
	assert.equal(reads, 3);
	assert.equal(result.version, '0.2.0');
	await assert.rejects(
		() =>
			verifyPublishedRelease(manifest, {
				attempts: 1,
				fetchImpl: async () => new Response(null, { status: 404 }),
			}),
		/do not repeat/,
	);
});
const registry = (versions, latest) => async () =>
	Response.json({ versions, 'dist-tags': { latest } });

test('new versions publish and already-published versions skip without another write', async () => {
	assert.deepEqual(
		await releaseDecision(manifest, lifecycle, { fetchImpl: registry({ '0.1.0': {} }, '0.1.0') }),
		{ version: '0.2.0', publish: true },
	);
	assert.deepEqual(
		await releaseDecision(manifest, lifecycle, { fetchImpl: registry({ '0.2.0': {} }, '0.2.0') }),
		{ version: '0.2.0', publish: false },
	);
	assert.equal(
		(
			await releaseDecision(manifest, lifecycle, {
				fetchImpl: async () => new Response(null, { status: 404 }),
			})
		).publish,
		true,
	);
});

test('registry outages and malformed responses fail instead of triggering a publish', async () => {
	await assert.rejects(
		() =>
			releaseDecision(manifest, lifecycle, {
				fetchImpl: async () => new Response(null, { status: 503 }),
			}),
		/503/,
	);
	await assert.rejects(
		() => releaseDecision(manifest, lifecycle, { fetchImpl: async () => Response.json({}) }),
		/Incomplete/,
	);
});

test('npm staging placeholder and lower prerelease tags do not block the first stable release', async () => {
	assert.equal(
		(
			await releaseDecision(manifest, lifecycle, {
				fetchImpl: registry({ '0.0.0-stage': {} }, '0.0.0-stage'),
			})
		).publish,
		true,
	);
	assert.equal(
		(
			await releaseDecision(manifest, lifecycle, {
				fetchImpl: registry({ '0.2.0-beta.1': {} }, '0.2.0-beta.1'),
			})
		).publish,
		true,
	);
	await assert.rejects(
		() =>
			releaseDecision(manifest, lifecycle, {
				fetchImpl: registry({ '0.3.0-beta.1': {} }, '0.3.0-beta.1'),
			}),
		/backwards/,
	);
});

test('wrong versions, inactive lifecycle and latest downgrade fail before publication', async () => {
	await assert.rejects(
		() => releaseDecision(manifest, lifecycle, { requestedVersion: '0.3.0' }),
		/Requested version/,
	);
	await assert.rejects(
		() => releaseDecision(manifest, { status: 'migration-ready' }),
		/active maintenance/,
	);
	await assert.rejects(
		() => releaseDecision(manifest, lifecycle, { fetchImpl: registry({ '0.3.0': {} }, '0.3.0') }),
		/backwards/,
	);
	await assert.rejects(
		() => releaseDecision({ ...manifest, version: '0.2.0\ninjected=true' }, lifecycle),
		/stable SemVer/,
	);
});
