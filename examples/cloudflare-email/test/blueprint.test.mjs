import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const example = path.resolve(import.meta.dirname, '..');
const root = path.resolve(example, '../..');

test(
	'actual CLI add/update resolve the fork blueprint; its complete source builds in a clean consumer',
	{ timeout: 90_000 },
	async () => {
		const source = await readFile(
			path.join(root, 'blueprints/channel--cloudflare-email.md'),
			'utf8',
		);
		const guide = source.replace(/^---\n[\s\S]*?\n---\n/, '');
		const previousDirectory = process.cwd();
		process.chdir(path.join(root, 'apps/www'));
		const route = await import(
			pathToFileURL(path.join(root, 'apps/www/src/pages/cli/blueprints/[name].md.ts'))
		);
		process.chdir(previousDirectory);
		const paths = await route.getStaticPaths();
		assert.ok(paths.some(({ params }) => params.name === 'cloudflare-email'));
		const served = await route.GET({ params: { name: 'cloudflare-email' } });
		assert.equal(served.status, 200);
		const servedGuide = await served.text();
		assert.equal(servedGuide.trim(), guide.trim());
		const server = createServer((_request, response) => response.end(servedGuide));
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		await mkdir(path.join(example, '.wrangler'), { recursive: true });
		const consumer = await mkdtemp(path.join(example, '.wrangler/blueprint-consumer-'));
		try {
			const env = {
				...process.env,
				FLUE_REGISTRY_URL: `http://127.0.0.1:${server.address().port}`,
			};
			const cli = path.join(root, 'packages/cli/bin/flue.mjs');
			const add = await execute(
				process.execPath,
				[cli, 'add', 'channel', 'cloudflare-email', '--print'],
				{ env },
			);
			const update = await execute(
				process.execPath,
				[cli, 'update', 'channel', 'cloudflare-email', '--print'],
				{ env },
			);
			assert.equal(add.stdout, update.stdout);
			assert.ok(add.stdout.includes('@illuwa-soft/flue-cloudflare-email'));
			const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1]);
			assert.equal(blocks.length, 5);
			const destinations = [
				'src/history.ts',
				'src/hitl.ts',
				'src/local-model.ts',
				'src/agents/email-assistant.ts',
				'src/cloudflare.ts',
			];
			for (const [index, destination] of destinations.entries()) {
				const target = path.join(consumer, destination);
				await mkdir(path.dirname(target), { recursive: true });
				await writeFile(target, blocks[index]);
			}
			await writeFile(
				path.join(consumer, 'src/app.ts'),
				"import { Hono } from 'hono';\nexport default new Hono();\n",
			);
			await writeFile(
				path.join(consumer, 'package.json'),
				JSON.stringify({ name: 'blueprint-consumer', type: 'module', private: true }),
			);
			await writeFile(
				path.join(consumer, 'tsconfig.json'),
				JSON.stringify({
					extends: path.join(root, 'tsconfig.base.json'),
					compilerOptions: { lib: ['ESNext', 'DOM'] },
					include: ['src', '*.ts'],
				}),
			);
			await writeFile(
				path.join(consumer, 'worker-configuration.d.ts'),
				await readFile(path.join(example, 'worker-configuration.d.ts')),
			);
			await writeFile(
				path.join(consumer, 'vite.config.ts'),
				await readFile(path.join(example, 'vite.config.ts')),
			);
			await writeFile(
				path.join(consumer, 'wrangler.jsonc'),
				await readFile(path.join(example, 'wrangler.jsonc')),
			);
			await mkdir(path.join(consumer, 'test'));
			await writeFile(
				path.join(consumer, 'test/email.test.mjs'),
				await readFile(path.join(example, 'test/email.test.mjs')),
			);
			const options = { cwd: consumer, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
			await execute('pnpm', ['exec', 'tsc', '--noEmit'], options);
			await execute(process.execPath, ['--test', 'test/email.test.mjs'], options);
			await execute('pnpm', ['exec', 'vite', 'build'], options);
			const upgrade = path.join(consumer, 'upgrade');
			const baseline = '90f3b6c27eeaef217bd59883e58bdd822d4398f8';
			for (const destination of [...destinations, 'src/channels/email.ts', 'wrangler.jsonc']) {
				const result = await execute(
					'git',
					['show', `${baseline}:examples/cloudflare-email/${destination}`],
					{ cwd: root },
				).catch((error) => {
					if (error.code === 128) return { stdout: '' };
					throw error;
				});
				if (!result.stdout) continue;
				await mkdir(path.dirname(path.join(upgrade, destination)), { recursive: true });
				await writeFile(path.join(upgrade, destination), result.stdout);
			}
			const oldPackage = await execute(
				'git',
				['show', `${baseline}:examples/cloudflare-email/package.json`],
				{ cwd: root },
			);
			await writeFile(
				path.join(upgrade, 'package.json'),
				`${JSON.stringify({ dependencies: JSON.parse(oldPackage.stdout).dependencies, devDependencies: JSON.parse(oldPackage.stdout).devDependencies }, null, 2)}\n`,
			);
			const upgradeDiff = [...guide.matchAll(/```diff\n([\s\S]*?)\n```/g)].at(-1)?.[1];
			assert.ok(upgradeDiff);
			const diffFile = path.join(consumer, 'v4.patch');
			await writeFile(diffFile, `${upgradeDiff}\n`);
			const directory = `--directory=${path.relative(root, upgrade)}`;
			await execute('git', ['apply', '--check', directory, diffFile], { cwd: root });
			await execute('git', ['apply', directory, diffFile], { cwd: root });
			for (const [index, destination] of destinations.entries()) {
				assert.equal(
					(await readFile(path.join(upgrade, destination), 'utf8')).trim(),
					blocks[index].trim(),
				);
			}
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await rm(consumer, { recursive: true, force: true });
		}
	},
);
