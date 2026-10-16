import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { unstable_dev } from 'wrangler';

test(
	'built Worker accepts native email, persists admission, deduplicates and protects inbox HTTP access',
	{ timeout: 90_000 },
	async () => {
		const worker = await unstable_dev('dist/flue_cloudflare_email/index.js', {
			config: 'dist/flue_cloudflare_email/wrangler.json',
			local: true,
			persist: false,
			port: 0,
			inspectorPort: 0,
			vars: { ADMIN_TOKEN: 'offline-test-token', EMAIL_RECIPIENT: 'support@example.com' },
			logLevel: 'error',
			experimental: { disableExperimentalWarning: true, watch: false, forceLocal: true },
		});
		try {
			assert.equal((await worker.fetch('/health')).status, 200);
			assert.equal((await worker.fetch('/agents/email/protected')).status, 401);
			const from = 'sender@example.net';
			const to = 'support@example.com';
			const messageId = '<workerd-native@example.net>';
			const emailId = createHash('sha256')
				.update(JSON.stringify([from, to, messageId]))
				.digest('hex');
			const raw = `From: ${from}\r\nTo: ${to}\r\nMessage-ID: ${messageId}\r\nSubject: Native Worker test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOffline test body.`;
			const endpoint = `http://${worker.address}:${worker.port}/cdn-cgi/handler/email?${new URLSearchParams({ from, to })}`;
			const response = await fetch(endpoint, { method: 'POST', body: raw });
			assert.equal(response.status, 200, await response.text());
			const headers = { authorization: 'Bearer offline-test-token' };
			const first = await (await worker.fetch(`/api/emails/${emailId}`, { headers })).json();
			assert.equal(first.email.text.trim(), 'Offline test body.');
			assert.ok(first.receipt.submissionId);
			const replay = await fetch(endpoint, { method: 'POST', body: raw });
			assert.equal(replay.status, 200, await replay.text());
			const second = await (await worker.fetch(`/api/emails/${emailId}`, { headers })).json();
			assert.equal(second.receipt.submissionId, first.receipt.submissionId);
		} finally {
			await worker.stop();
		}
	},
);
