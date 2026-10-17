import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { unstable_dev } from 'wrangler';

async function until(read) {
	for (let attempt = 0; attempt < 120; attempt++) {
		const result = await read();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Minimal consumer timed out.');
}

test(
	'minimal hook handles distinct authors in a fixed room, survives restart and deduplicates replay',
	{ timeout: 90_000 },
	async () => {
		await mkdir('.wrangler', { recursive: true });
		const persistTo = await mkdtemp('.wrangler/minimal-test-');
		const options = {
			config: 'dist/flue_cloudflare_email/wrangler.json',
			local: true,
			persist: true,
			persistTo,
			ip: '127.0.0.1',
			port: 0,
			inspectorPort: 0,
			logLevel: 'error',
			vars: {
				ADMIN_TOKEN: 'offline-test-token',
				EMAIL_MODE: 'local',
				EMAIL_RECIPIENT: 'support@example.com',
				EMAIL_REPLY_ALLOWED_SENDERS: '',
			},
			experimental: { disableExperimentalWarning: true, watch: false, forceLocal: true },
		};
		let worker = await unstable_dev('dist/flue_cloudflare_email/index.js', options);
		const headers = { authorization: 'Bearer offline-test-token' };
		const read = async (path) => (await worker.fetch(path, { headers })).json();
		const send = async (id, from, body) => {
			const to = 'support@example.com';
			const messageId = `<${id}@example.net>`;
			const raw = `From: ${from}\r\nTo: ${to}\r\nMessage-ID: ${messageId}\r\nSubject: Minimal\r\n\r\n${body}`;
			const response = await fetch(
				`http://${worker.address}:${worker.port}/cdn-cgi/handler/email?${new URLSearchParams({ from, to })}`,
				{ method: 'POST', body: raw },
			);
			assert.equal(response.status, 200, await response.text());
			const emailId = createHash('sha256')
				.update(JSON.stringify([from, to, messageId]))
				.digest('hex');
			return read(`/api/emails/${emailId}`);
		};
		const outbox = () => read('/api/local/outbox');
		try {
			const first = await send('minimal-one', 'first@example.net', 'First independent email');
			await until(async () => (await outbox()).messages.length === 1);
			const second = await send('minimal-two', 'second@example.net', 'Second independent email');
			await until(async () => (await outbox()).messages.length === 2);
			assert.notEqual(first.receipt.threadId, second.receipt.threadId);
			assert.equal(first.receipt.conversationId, 'personal-assistant');
			assert.equal(second.receipt.conversationId, 'personal-assistant');
			const conversation = '/agents/email/personal-assistant?view=history';
			await until(
				async () =>
					(await read(conversation)).settlements?.filter((item) => item.outcome === 'completed')
						.length === 2,
			);
			const history = await read(conversation);
			assert.match(JSON.stringify(history), /First independent email/);
			assert.match(JSON.stringify(history), /Second independent email/);
			const messages = (await outbox()).messages;
			assert.equal(
				messages.find((mail) => mail.to === 'first@example.net').text.trim(),
				'Minimal reply: First independent email',
			);
			assert.equal(
				messages.find((mail) => mail.to === 'second@example.net').text.trim(),
				'Minimal reply: Second independent email',
			);
			await worker.stop();
			worker = await unstable_dev('dist/flue_cloudflare_email/index.js', options);
			const replay = await send('minimal-one', 'first@example.net', 'First independent email');
			assert.equal(replay.receipt.submissionId, first.receipt.submissionId);
			assert.equal((await outbox()).messages.length, 2);
			assert.equal((await read(conversation)).conversationId, history.conversationId);
		} finally {
			await worker.stop();
			await rm(persistTo, { recursive: true, force: true });
		}
	},
);
