import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check one stable package release; only a real registry 404 means unpublished. */
export async function releaseDecision(
	manifest,
	lifecycle,
	{ fetchImpl = fetch, requestedVersion = '' } = {},
) {
	assert.equal(manifest.name, '@illuwa-soft/flue-cloudflare-email');
	assert.equal(manifest.repository.url, 'git+https://github.com/illuwa-soft/flue.git');
	assert.equal(lifecycle.status, 'active', 'Publication requires active maintenance.');
	assert.match(
		manifest.version,
		/^\d+\.\d+\.\d+$/,
		'This lane publishes stable SemVer versions only.',
	);
	if (requestedVersion)
		assert.equal(
			manifest.version,
			requestedVersion,
			'Requested version differs from the checkout.',
		);
	const response = await fetchImpl(
		`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (response.status === 404) return { version: manifest.version, publish: true };
	if (!response.ok) throw new Error(`Registry preflight failed: HTTP ${response.status}`);
	const metadata = await response.json();
	assert.ok(metadata.versions && metadata['dist-tags'], 'Incomplete registry metadata.');
	if (metadata.versions[manifest.version]) return { version: manifest.version, publish: false };
	const latest = metadata['dist-tags'].latest;
	if (latest) {
		const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(latest);
		assert.ok(parsed, 'Review an invalid latest tag before publishing.');
		const proposed = manifest.version.split('.').map(Number);
		const current = parsed.slice(1, 4).map(Number);
		const difference = proposed
			.map((part, index) => part - current[index])
			.find((part) => part !== 0);
		assert.ok(
			difference > 0 || (difference === undefined && parsed[4]),
			'Refusing to move latest backwards.',
		);
	}
	return { version: manifest.version, publish: true };
}

/** Poll only public reads while npm processes an accepted publish; never retry the write. */
export async function verifyPublishedRelease(
	manifest,
	{
		fetchImpl = fetch,
		attempts = 60,
		wait = () => new Promise((resolve) => setTimeout(resolve, 5000)),
	} = {},
) {
	const url = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const response = await fetchImpl(url, {
			signal: AbortSignal.timeout(10_000),
			cache: 'no-store',
		});
		if (response.ok) {
			const metadata = await response.json();
			assert.equal(metadata.name, manifest.name);
			assert.equal(metadata.version, manifest.version);
			assert.match(metadata.dist?.integrity ?? '', /^sha512-/);
			return {
				version: metadata.version,
				integrity: metadata.dist.integrity,
				attestations: metadata.dist.attestations ?? null,
			};
		}
		if (response.status !== 404 && response.status !== 429 && response.status < 500)
			throw new Error(`Registry verification failed: HTTP ${response.status}`);
		if (attempt + 1 < attempts) await wait();
	}
	throw new Error(
		'Accepted publish is not publicly visible yet. Inspect npm processing; do not repeat the publish write.',
	);
}

/** Export validated data to GitHub outputs without invoking a publishing write. */
async function main() {
	const directory = path.resolve(import.meta.dirname, '..');
	const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
	const lifecycle = JSON.parse(await readFile(path.join(directory, 'lifecycle.json'), 'utf8'));
	if (process.argv[2] === 'verify') {
		console.log(JSON.stringify(await verifyPublishedRelease(manifest)));
		return;
	}
	const decision = await releaseDecision(manifest, lifecycle, {
		requestedVersion: process.env.RELEASE_VERSION,
	});
	console.log(JSON.stringify(decision));
	if (process.env.GITHUB_OUTPUT)
		await appendFile(
			process.env.GITHUB_OUTPUT,
			`version=${decision.version}\nshould_publish=${decision.publish}\n`,
		);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
