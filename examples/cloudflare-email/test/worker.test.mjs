import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { unstable_dev } from 'wrangler';

/** Wait for asynchronous Durable Object processing, with a bounded deadline. / 비동기 Durable Object 처리를 제한된 시간 동안 확인합니다. */
async function until(read) {
	for (let attempt = 0; attempt < 120; attempt++) {
		const result = await read();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('Local HITL processing timed out.');
}

test(
	'real local Flue thread: request → revise → restart → approve → replay → cancel, without model or email network',
	{ timeout: 90_000 },
	async () => {
		await mkdir('.wrangler', { recursive: true });
		const persistTo = await mkdtemp('.wrangler/hitl-test-');
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
				EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
			},
			experimental: { disableExperimentalWarning: true, watch: false, forceLocal: true },
		};
		let worker = await unstable_dev('dist/flue_cloudflare_email/index.js', options);
		const headers = { authorization: 'Bearer offline-test-token' };
		const read = async (path) => (await worker.fetch(path, { headers })).json();
		const send = async (id, text, parent = '') => {
			const from = 'sender@example.net';
			const to = 'support@example.com';
			const messageId = `<${id}@example.net>`;
			const emailId = createHash('sha256')
				.update(JSON.stringify([from, to, messageId]))
				.digest('hex');
			const raw = `From: ${from}\r\nTo: ${to}\r\nMessage-ID: ${messageId}\r\nIn-Reply-To: ${parent}\r\nSubject: Native HITL test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
			const endpoint = `http://${worker.address}:${worker.port}/cdn-cgi/handler/email?${new URLSearchParams({ from, to })}`;
			const response = await fetch(endpoint, { method: 'POST', body: raw });
			assert.equal(response.status, 200, await response.text());
			return { emailId, ...(await read(`/api/emails/${emailId}`)) };
		};
		const sentFor = async (id) =>
			until(async () =>
				(await read('/api/local/outbox')).messages.find(
					(mail) => mail.headers['In-Reply-To'] === `<${id}@example.net>`,
				),
			);
		try {
			assert.equal((await worker.fetch('/health')).status, 200);
			assert.equal((await worker.fetch('/api/local/outbox')).status, 401);
			const root = await send('root', 'Write a document for approval.');
			const threadId = root.receipt.threadId;
			const conversation = `/agents/email/${encodeURIComponent(`cloudflare-thread:${threadId}`)}?view=history`;
			const firstMail = await sentFor('root');
			const first = await read(`/api/threads/${threadId}`);
			assert.equal(first.phase, 'waiting');
			assert.equal(first.artifactKey, undefined);
			await until(async () =>
				(await read(conversation)).settlements?.some((item) => item.outcome === 'completed'),
			);
			const originalConversationId = (await read(conversation)).conversationId;
			const revision = await send(
				'revision',
				`수정 ${first.pending.token}: Revised exact contents.`,
				firstMail.messageId,
			);
			assert.equal(revision.receipt.threadId, threadId);
			const revisedMail = await sentFor('revision');
			const revised = await read(`/api/threads/${threadId}`);
			assert.equal(revised.revision, 2);
			assert.equal(revised.pending.plan.content, 'Revised exact contents.');
			await until(
				async () =>
					(await read(conversation)).settlements?.filter((item) => item.outcome === 'completed')
						.length >= 2,
			);
			await worker.stop();
			worker = await unstable_dev('dist/flue_cloudflare_email/index.js', options);
			assert.equal((await read(`/api/threads/${threadId}`)).pending.token, revised.pending.token);
			assert.equal((await read(conversation)).conversationId, originalConversationId);
			const approvedText = `승인 ${revised.pending.token}\n\n> 승인 ${first.pending.token}`;
			const approved = await send('approve', approvedText, revisedMail.messageId);
			await sentFor('approve');
			const done = await read(`/api/threads/${threadId}`);
			assert.equal(done.phase, 'completed');
			const artifact = await read(`/api/artifacts/${threadId}/${done.pending.id}`);
			assert.equal(artifact.content, 'Revised exact contents.');
			const beforeReplay = (await read('/api/local/outbox')).messages.length;
			const replay = await send('approve', approvedText, revisedMail.messageId);
			assert.equal(replay.receipt.submissionId, approved.receipt.submissionId);
			assert.equal((await read('/api/local/outbox')).messages.length, beforeReplay);
			const other = await send('cancel-root', 'A separate cancellable task.');
			const otherMail = await sentFor('cancel-root');
			const cancelState = await read(`/api/threads/${other.receipt.threadId}`);
			await send('cancel', `취소 ${cancelState.pending.token}`, otherMail.messageId);
			await sentFor('cancel');
			assert.equal((await read(`/api/threads/${other.receipt.threadId}`)).phase, 'cancelled');
			await until(async () => {
				const settlements = (await read(conversation)).settlements ?? [];
				return settlements.length >= 3 && settlements.every((item) => item.outcome === 'completed');
			});
			const otherConversation = `/agents/email/${encodeURIComponent(`cloudflare-thread:${other.receipt.threadId}`)}?view=history`;
			await until(async () => {
				const settlements = (await read(otherConversation)).settlements ?? [];
				return settlements.length >= 2 && settlements.every((item) => item.outcome === 'completed');
			});
		} finally {
			await worker.stop();
			await rm(persistTo, { recursive: true, force: true });
		}
	},
);
