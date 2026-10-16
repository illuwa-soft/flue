import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiveEmail, replyToEmail, retrieveEmail } from '../src/channels/email.ts';

/** Keep R2 conditional writes observable without contacting Cloudflare. / R2 조건부 쓰기를 오프라인에서 검증합니다. */
class MemoryBucket {
	objects = new Map();
	async put(key, value, options = {}) {
		if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
		this.objects.set(key, { value, customMetadata: options.customMetadata });
		return { key };
	}
	async get(key) {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			customMetadata: object.customMetadata,
			arrayBuffer: async () => new Response(object.value).arrayBuffer(),
			json: async () => JSON.parse(object.value),
		};
	}
}

/** Construct independent raw streams for SMTP redeliveries. / SMTP 재전달마다 독립 스트림을 생성합니다. */
function message(overrides = {}) {
	const raw = [
		'From: sender@example.net',
		'To: support@example.com',
		'Subject: Hello',
		'Message-ID: <one@example.net>',
		'Reply-To: attacker@example.org',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Hello from a test.',
	].join('\r\n');
	return {
		from: 'sender@example.net',
		to: 'support@example.com',
		headers: new Headers({ subject: 'Hello', 'message-id': '<one@example.net>' }),
		raw: new Blob([raw]).stream(),
		rawSize: raw.length,
		setReject(reason) {
			throw new Error(reason);
		},
		...overrides,
	};
}

test('store before admission; stable replay; scoped retrieval; one reply with threading', async () => {
	const sent = [];
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send(mail) {
				sent.push(mail);
				return { messageId: 'outbound-1' };
			},
		},
	};
	const requests = [];
	const admit = async (request) => {
		assert.ok(await env.INBOX.get(`inbound/${request.initialData.emailId}.eml`));
		requests.push(request);
		return { submissionId: 'sub-1', acceptedAt: '2026-10-16T00:00:00Z', uid: 'uid-1' };
	};
	const first = await receiveEmail(message(), env, admit);
	const replay = await receiveEmail(message(), env, admit);
	assert.equal(replay.emailId, first.emailId);
	assert.deepEqual(requests[0], requests[1]);
	assert.equal(requests[0].idempotencyKey, first.emailId);
	const email = await retrieveEmail(env, first.emailId);
	assert.equal(email.text.trim(), 'Hello from a test.');
	await replyToEmail(env, first.emailId, 'Thanks.');
	await replyToEmail(env, first.emailId, 'Thanks again.');
	assert.equal(sent.length, 1);
	assert.equal(sent[0].to, 'sender@example.net');
	assert.equal(sent[0].from, 'support@example.com');
	assert.equal(sent[0].headers['In-Reply-To'], '<one@example.net>');
	await assert.rejects(() => retrieveEmail(env, '../other'), /Invalid email id/);
});

test('reject invalid recipients and oversized mail before storage or dispatch', async () => {
	const env = { INBOX: new MemoryBucket(), EMAIL_RECIPIENT: 'support@example.com' };
	const admit = async () => assert.fail('must not admit');
	await assert.rejects(
		() => receiveEmail(message({ to: 'other@example.com' }), env, admit),
		/Recipient/,
	);
	await assert.rejects(() => receiveEmail(message({ rawSize: 2 ** 21 }), env, admit), /too large/);
	assert.equal(env.INBOX.objects.size, 0);
});

test('failed admission remains retryable, and ambiguous sending is never blindly repeated', async () => {
	let sends = 0;
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				sends++;
				throw new Error('transport interrupted');
			},
		},
	};
	await assert.rejects(() =>
		receiveEmail(message(), env, async () => {
			throw new Error('admission failed');
		}),
	);
	const { emailId } = await receiveEmail(message(), env, async () => ({ submissionId: 'sub-2' }));
	await assert.rejects(() => replyToEmail(env, emailId, 'Reply'), /transport interrupted/);
	await assert.rejects(() => replyToEmail(env, emailId, 'Reply'), /uncertain/);
	assert.equal(sends, 1);
});

test('identity conflicts, automated mail and non-allowlisted senders cannot cause a reply', async () => {
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: '',
		EMAIL: {
			async send() {
				assert.fail('must not send');
			},
		},
	};
	const admit = async () => ({ submissionId: 'sub-3' });
	const { emailId } = await receiveEmail(message(), env, admit);
	await assert.rejects(() => replyToEmail(env, emailId, 'Hello'), /not allowed/);
	await assert.rejects(
		() => receiveEmail(message({ raw: new Blob(['different']).stream() }), env, admit),
		/identity conflict/,
	);
	env.EMAIL_REPLY_ALLOWED_SENDERS = 'sender@example.net';
	const key = `inbound/${emailId}.eml`;
	env.INBOX.objects.get(key).customMetadata.autoSubmitted = 'auto-replied';
	await assert.rejects(() => replyToEmail(env, emailId, 'Hello'), /Automated/);
	assert.equal(env.INBOX.objects.has(`replies/${emailId}.json`), false);
});

test('reply to the allowlisted author rather than a provider bounce envelope or Reply-To header', async () => {
	const sent = [];
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send(mail) {
				sent.push(mail);
				return { messageId: 'outbound-2' };
			},
		},
	};
	const { emailId } = await receiveEmail(
		message({ from: 'bounce@provider.example' }),
		env,
		async () => ({ submissionId: 'sub-4' }),
	);
	await replyToEmail(env, emailId, 'Acknowledged.');
	assert.equal(sent[0].to, 'sender@example.net');
	assert.equal((await retrieveEmail(env, emailId)).envelopeFrom, 'bounce@provider.example');
});
