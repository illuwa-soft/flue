import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const directory = path.resolve(import.meta.dirname, '..');
const root = path.resolve(directory, '../..');
const example = path.join(root, 'examples/cloudflare-email');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'flue-email-consumer-'));
const packDirectory = path.join(temporary, 'packed');
const consumer = path.join(temporary, 'app');
const version = process.env.FLUE_CONSUMER_VERSION ?? '2.3.0';

/** Exercise the packed distribution outside the workspace, with public Flue packages. */
async function verify() {
	await mkdir(packDirectory);
	await mkdir(consumer);
	const packed = await run('pnpm', ['pack', '--json', '--pack-destination', packDirectory], {
		cwd: directory,
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	const result = JSON.parse(packed.stdout);
	assert.ok(JSON.stringify(result).includes('channel.mjs'), 'The packed build entry is missing.');
	const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
	assert.equal(tarballs.length, 1);
	const tarball = path.join(packDirectory, tarballs[0]);
	const fileList = await run('tar', ['-tzf', tarball]);
	for (const file of [
		'package/dist/channel.mjs',
		'package/dist/channel.d.mts',
		'package/README.md',
		'package/LICENSE',
		'package/NOTICE',
	])
		assert.ok(fileList.stdout.includes(file), `Missing ${file}`);
	assert.doesNotMatch(
		fileList.stdout,
		/\.dev\.vars|\.env|node_modules|worker-configuration|\.wrangler|test\/|src\//,
	);
	const manifestResult = await run('tar', ['-xOf', tarball, 'package/package.json']);
	const manifest = JSON.parse(manifestResult.stdout);
	assert.equal(manifest.name, '@illuwa-soft/flue-cloudflare-email');
	assert.doesNotMatch(
		manifestResult.stdout,
		/workspace:/,
		'Publishable metadata must not require this workspace.',
	);
	await writeFile(
		path.join(consumer, 'package.json'),
		JSON.stringify(
			{
				name: 'isolated-email-consumer',
				private: true,
				type: 'module',
				dependencies: {
					'@illuwa-soft/flue-cloudflare-email': `file:${tarball}`,
					'@flue/runtime': version,
					'@flue/vite': version,
					'@earendil-works/pi-ai': '^1.1.0',
					hono: '^4.12.32',
					'postal-mime': '^2.6.0',
					valibot: '^1.1.0',
				},
				devDependencies: {
					'@cloudflare/vite-plugin': '1.49.0',
					wrangler: '4.116.0',
					vite: '8.1.5',
					typescript: '7.0.2',
					'@types/node': '^26.1.1',
				},
			},
			null,
			2,
		),
	);
	await writeFile(
		path.join(consumer, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					allowImportingTsExtensions: true,
					noEmit: true,
					strict: true,
					skipLibCheck: true,
					lib: ['ESNext', 'DOM'],
					types: ['node'],
				},
				include: ['src', 'worker-configuration.d.ts', '*.ts'],
			},
			null,
			2,
		),
	);
	await cp(path.join(example, 'src'), path.join(consumer, 'src'), { recursive: true });
	await cp(path.join(example, 'test'), path.join(consumer, 'test'), { recursive: true });
	for (const file of ['vite.config.ts', 'wrangler.jsonc'])
		await cp(path.join(example, file), path.join(consumer, file));
	const options = { cwd: consumer, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 };
	await run(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--registry=https://registry.npmjs.org',
		],
		options,
	);
	const installed = JSON.parse(
		await readFile(path.join(consumer, 'node_modules/@flue/runtime/package.json'), 'utf8'),
	);
	const resolved = await run(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			'console.log(import.meta.resolve("@illuwa-soft/flue-cloudflare-email"))',
		],
		options,
	);
	assert.ok(
		resolved.stdout.includes(path.join(consumer, 'node_modules')),
		'The consumer resolved workspace code.',
	);
	await run('npm', ['exec', '--', 'wrangler', 'types'], options);
	await run('npm', ['exec', '--', 'tsc', '--noEmit'], options);
	await run(process.execPath, ['--test', 'test/email.test.mjs'], options);
	await run('npm', ['exec', '--', 'vite', 'build', '--logLevel', 'warn'], options);
	await run(process.execPath, ['--test', 'test/worker.test.mjs'], options);
	await cp(
		path.join(consumer, 'test/fixtures/minimal-agent.ts.txt'),
		path.join(consumer, 'src/agents/email-assistant.ts'),
	);
	await writeFile(
		path.join(consumer, 'src/email-channel.ts'),
		"import { env } from 'cloudflare:workers';\nimport { createEmailChannel } from './email.ts';\nexport const email = createEmailChannel(env, 'personal-assistant');\n",
	);
	await run('npm', ['exec', '--', 'tsc', '--noEmit'], options);
	await run('npm', ['exec', '--', 'vite', 'build', '--logLevel', 'warn'], options);
	await run(process.execPath, ['--test', 'test/minimal-worker.test.mjs'], options);
	console.log(
		JSON.stringify({
			status: 'passed',
			package: `${manifest.name}@${manifest.version}`,
			flue: installed.version,
			isolated: true,
			worker: 'full conversational/HITL flow',
			minimal: 'hook-only fixed-room delivery, two authors, restart and replay',
		}),
	);
}

try {
	await verify();
} catch (error) {
	console.error(error.message);
	if (error.stdout) console.error(error.stdout);
	if (error.stderr) console.error(error.stderr);
	process.exitCode = 1;
} finally {
	await rm(temporary, { recursive: true, force: true });
}
