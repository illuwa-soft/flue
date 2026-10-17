import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	receiveEmail as receive,
	replyToEmail as reply,
	retrieveEmail as retrieve,
} from '@illuwa-soft/flue-cloudflare-email';
import { emailContext } from '../src/email.ts';
import { importLegacyThread, readThreadHistory } from '../src/history.ts';
import { handleHumanReply, parseDecision, proposeApproval, readHitlState } from '../src/hitl.ts';

// Exercise the example's explicit context and sending policy, not a package-owned Env.
const receiveEmail = (message, env, admit) => receive(message, emailContext(env), admit);
const replyToEmail = (env, id, text) => reply(emailContext(env), id, text);
const retrieveEmail = (env, id) => retrieve(emailContext(env), id);

test('fixed conversation keeps independent thread approvals isolated', async () => {
	let sent = 0;
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<fixed-${++sent}@example.com>` };
			},
		},
	};
	const context = { ...emailContext(env), channelId: 'shared-room' };
	const requests = [];
	const admit = async (request) => {
		requests.push(request);
		return { submissionId: request.idempotencyKey };
	};
	const first = await receive(humanMail('fixed-a', 'Document A'), context, admit);
	const second = await receive(humanMail('fixed-b', 'Document B'), context, admit);
	assert.equal(requests[0].id, requests[1].id);
	assert.notEqual(first.threadId, second.threadId);
	await proposeApproval(
		env,
		first.threadId,
		'sender@example.net',
		first.emailId,
		{ title: 'A', content: 'A' },
		'tool-a',
	);
	await proposeApproval(
		env,
		second.threadId,
		'sender@example.net',
		second.emailId,
		{ title: 'B', content: 'B' },
		'tool-b',
	);
	const firstState = await readHitlState(env, first.threadId);
	const secondState = await readHitlState(env, second.threadId);
	const wrong = await receive(
		humanMail('fixed-wrong', `approve ${secondState.pending.token}`, '<fixed-a@example.net>'),
		context,
		admit,
	);
	await handleHumanReply(env, first.threadId, 'sender@example.net', wrong.emailId);
	assert.equal((await readHitlState(env, first.threadId)).pending.token, firstState.pending.token);
	assert.equal(
		(await readHitlState(env, second.threadId)).pending.token,
		secondState.pending.token,
	);
	assert.equal(
		[...env.INBOX.objects.keys()].some((key) => key.startsWith('artifacts/')),
		false,
	);
	const correct = await receive(
		humanMail('fixed-correct', `approve ${secondState.pending.token}`, '<fixed-b@example.net>'),
		context,
		admit,
	);
	await handleHumanReply(env, second.threadId, 'sender@example.net', correct.emailId);
	assert.equal((await readHitlState(env, second.threadId)).phase, 'completed');
	assert.equal((await readHitlState(env, first.threadId)).phase, 'waiting');
});

/** Keep R2 conditional writes observable without contacting Cloudflare. / R2 조건부 쓰기를 오프라인에서 검증합니다. */
class MemoryBucket {
	objects = new Map();
	version = 0;
	async put(key, value, options = {}) {
		if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
		if (options.onlyIf?.etagMatches && this.objects.get(key)?.etag !== options.onlyIf.etagMatches)
			return null;
		const etag = String(++this.version);
		this.objects.set(key, { value, customMetadata: options.customMetadata, etag });
		return { key, etag };
	}
	async get(key) {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			etag: object.etag,
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
		'Reply-To: sender@example.net',
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
		assert.ok(await env.INBOX.get(`inbound/${request.message.attributes.emailId}.eml`));
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

/** Make human replies without silently inheriting a session from the subject. / 제목으로 세션을 추측하지 않는 사람의 답장을 만듭니다. */
function humanMail(
	id,
	body,
	parent = '',
	author = 'sender@example.net',
	contentType = 'text/plain',
) {
	const headers = new Headers({ subject: 'Task', 'message-id': `<${id}@example.net>` });
	if (parent) headers.set('in-reply-to', parent);
	const raw = [
		`From: ${author}`,
		'To: support@example.com',
		'Subject: Task',
		`Message-ID: <${id}@example.net>`,
		`In-Reply-To: ${parent}`,
		`Content-Type: ${contentType}; charset=utf-8`,
		'',
		body,
	].join('\r\n');
	return message({ from: author, headers, raw: new Blob([raw]).stream(), rawSize: raw.length });
}

test('threaded HITL revises, rejects stale and quoted approvals, then executes the stored plan exactly once', async () => {
	let sent = 0;
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<out-${++sent}@example.com>` };
			},
		},
	};
	const admitted = [];
	const admit = async (request) => {
		admitted.push(request);
		return { submissionId: `sub-${admitted.length}` };
	};
	const root = await receiveEmail(humanMail('root', 'Write the first draft.'), env, admit);
	const owner = 'sender@example.net';
	await handleHumanReply(env, root.threadId, owner, root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		owner,
		root.emailId,
		{ title: 'Draft', content: 'Original' },
		'tool-1',
	);
	const first = await readHitlState(env, root.threadId);
	assert.equal(first.phase, 'waiting');
	const revision = await receiveEmail(
		humanMail(
			'revision',
			`수정 ${first.pending.token}: Change the content.`,
			'<out-1@example.com>',
		),
		env,
		admit,
	);
	assert.equal(revision.threadId, root.threadId);
	assert.equal(admitted[0].id, admitted[1].id);
	await handleHumanReply(env, root.threadId, owner, revision.emailId);
	await proposeApproval(
		env,
		root.threadId,
		owner,
		revision.emailId,
		{ title: 'Draft v2', content: 'Revised' },
		'tool-2',
	);
	const second = await readHitlState(env, root.threadId);
	assert.notEqual(second.pending.token, first.pending.token);
	const stale = await receiveEmail(
		humanMail('stale', `승인 ${first.pending.token}`, '<out-2@example.com>'),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, owner, stale.emailId);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'waiting');
	const quoted = await receiveEmail(
		humanMail('quoted', `> 승인 ${second.pending.token}`, '<out-2@example.com>'),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, owner, quoted.emailId);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'waiting');
	const approval = await receiveEmail(
		humanMail('approve', `승인 ${second.pending.token}\n\n> old email`, '<out-2@example.com>'),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, owner, approval.emailId);
	await handleHumanReply(env, root.threadId, owner, approval.emailId);
	const done = await readHitlState(env, root.threadId);
	assert.equal(done.phase, 'completed');
	const artifact = await env.INBOX.get(done.artifactKey);
	assert.equal((await artifact.json()).content, 'Revised');
	assert.equal(
		[...env.INBOX.objects.keys()].filter((key) => key.startsWith('artifacts/')).length,
		1,
	);
	await assert.rejects(
		() =>
			receiveEmail(
				humanMail(
					'intruder',
					`승인 ${second.pending.token}`,
					'<out-2@example.com>',
					'intruder@example.net',
				),
				env,
				admit,
			),
		/participant/,
	);
});

test('approval expiry and cancellation do not execute an artifact', async () => {
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<${crypto.randomUUID()}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'sub' });
	const owner = 'sender@example.net';
	const root = await receiveEmail(humanMail('expiry-root', 'Test expiry.'), env, admit);
	await handleHumanReply(env, root.threadId, owner, root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		owner,
		root.emailId,
		{ title: 'Draft', content: 'Do not execute' },
		'expiry-tool',
		1000,
	);
	const waiting = await readHitlState(env, root.threadId);
	const late = await receiveEmail(
		humanMail('late', `승인 ${waiting.pending.token}`, '<expiry-root@example.net>'),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, owner, late.emailId, waiting.pending.expiresAt + 1);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'expired');
	const other = await receiveEmail(humanMail('cancel-root', 'Test cancel.'), env, admit);
	assert.notEqual(other.threadId, root.threadId);
	await handleHumanReply(env, other.threadId, owner, other.emailId);
	await proposeApproval(
		env,
		other.threadId,
		owner,
		other.emailId,
		{ title: 'Draft', content: 'Do not execute' },
		'cancel-tool',
	);
	const cancelState = await readHitlState(env, other.threadId);
	const cancel = await receiveEmail(
		humanMail('cancel', `취소 ${cancelState.pending.token}`, '<cancel-root@example.net>'),
		env,
		admit,
	);
	await handleHumanReply(env, other.threadId, owner, cancel.emailId);
	assert.equal((await readHitlState(env, other.threadId)).phase, 'cancelled');
	assert.equal(
		[...env.INBOX.objects.keys()].filter((key) => key.startsWith('artifacts/')).length,
		0,
	);
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
	assert.equal((await (await env.INBOX.get(`replies/${emailId}.json`)).json()).state, 'sending');
});

test('reply to the message reply address rather than a provider bounce envelope', async () => {
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

test('competing approval and cancellation select one durable outcome', async () => {
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<${crypto.randomUUID()}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'sub' });
	const owner = 'sender@example.net';
	const root = await receiveEmail(humanMail('race-root', 'Race test.'), env, admit);
	await handleHumanReply(env, root.threadId, owner, root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		owner,
		root.emailId,
		{ title: 'Race', content: 'Stored arguments' },
		'race-tool',
	);
	const { pending } = await readHitlState(env, root.threadId);
	const approval = await receiveEmail(
		humanMail('race-approve', `승인 ${pending.token}`, '<race-root@example.net>'),
		env,
		admit,
	);
	const cancel = await receiveEmail(
		humanMail('race-cancel', `취소 ${pending.token}`, '<race-root@example.net>'),
		env,
		admit,
	);
	await Promise.allSettled([
		handleHumanReply(env, root.threadId, owner, approval.emailId),
		handleHumanReply(env, root.threadId, owner, cancel.emailId),
	]);
	const state = await readHitlState(env, root.threadId);
	assert.ok(['completed', 'cancelled'].includes(state.phase));
	const artifacts = [...env.INBOX.objects.keys()].filter((key) =>
		key.startsWith('artifacts/'),
	).length;
	assert.equal(artifacts, { completed: 1, cancelled: 0 }[state.phase]);
});

test('an interrupted approved artifact write resumes from stored arguments on the same delivery', async () => {
	const bucket = new MemoryBucket();
	const put = bucket.put.bind(bucket);
	let interrupt = true;
	bucket.put = async (key, value, options) => {
		if (key.startsWith('artifacts/') && interrupt) {
			interrupt = false;
			throw new Error('simulated artifact interruption');
		}
		return put(key, value, options);
	};
	const env = {
		INBOX: bucket,
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<${crypto.randomUUID()}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'sub' });
	const owner = 'sender@example.net';
	const root = await receiveEmail(humanMail('recovery-root', 'Recovery test.'), env, admit);
	await handleHumanReply(env, root.threadId, owner, root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		owner,
		root.emailId,
		{ title: 'Recovery', content: 'Exact approved contents' },
		'recovery-tool',
	);
	const { pending } = await readHitlState(env, root.threadId);
	const approval = await receiveEmail(
		humanMail('recovery-approval', `승인 ${pending.token}`, '<recovery-root@example.net>'),
		env,
		admit,
	);
	await assert.rejects(
		() => handleHumanReply(env, root.threadId, owner, approval.emailId),
		/artifact interruption/,
	);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'executing');
	await handleHumanReply(env, root.threadId, owner, approval.emailId);
	const complete = await readHitlState(env, root.threadId);
	assert.equal(complete.phase, 'completed');
	assert.equal(
		(await (await bucket.get(complete.artifactKey)).json()).content,
		'Exact approved contents',
	);
});

test('HTML-only mail becomes readable text and quoted HTML never grants approval', async () => {
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<${crypto.randomUUID()}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'html-sub' });
	const root = await receiveEmail(
		humanMail(
			'html-root',
			'<p>이름은 푸른달입니다.&nbsp;기억해 주세요.</p><script>bad()</script>',
			'',
			'sender@example.net',
			'text/html',
		),
		env,
		admit,
	);
	assert.match((await retrieveEmail(env, root.emailId)).text, /^이름은 푸른달입니다\./);
	assert.doesNotMatch((await retrieveEmail(env, root.emailId)).text, /<p>|bad\(\)/);
	await handleHumanReply(env, root.threadId, 'sender@example.net', root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		'sender@example.net',
		root.emailId,
		{ title: 'HTML', content: 'Approved only' },
		'html-tool',
	);
	const waiting = await readHitlState(env, root.threadId);
	const quote = await receiveEmail(
		humanMail(
			'html-quote',
			`<blockquote><p>승인 ${waiting.pending.token}</p></blockquote>`,
			'<html-root@example.net>',
			'sender@example.net',
			'text/html',
		),
		env,
		admit,
	);
	const quotedText = (await retrieveEmail(env, quote.emailId)).text;
	assert.match(quotedText, /^>/);
	assert.equal(parseDecision(quotedText), undefined);
	await handleHumanReply(env, root.threadId, 'sender@example.net', quote.emailId);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'waiting');
	const approval = await receiveEmail(
		humanMail(
			'html-approve',
			`<p>승인&nbsp;${waiting.pending.token}</p><blockquote>old text</blockquote>`,
			'<html-root@example.net>',
			'sender@example.net',
			'text/html',
		),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, 'sender@example.net', approval.emailId);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'completed');
});

test('ordinary conversation during pending approval is left to the model without consuming its reply', async () => {
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<${crypto.randomUUID()}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'chat-sub' });
	const root = await receiveEmail(humanMail('chat-root', 'Document for review.'), env, admit);
	await handleHumanReply(env, root.threadId, 'sender@example.net', root.emailId);
	await proposeApproval(
		env,
		root.threadId,
		'sender@example.net',
		root.emailId,
		{ title: 'Pending', content: 'Unchanged' },
		'chat-tool',
	);
	const question = await receiveEmail(
		humanMail('chat-question', '앞에서 알려준 내 이름이 무엇인가요?', '<chat-root@example.net>'),
		env,
		admit,
	);
	await handleHumanReply(env, root.threadId, 'sender@example.net', question.emailId);
	assert.equal((await readHitlState(env, root.threadId)).phase, 'waiting');
	assert.equal(await env.INBOX.get(`replies/${question.emailId}.json`), null);
});

test('explicit legacy import preserves bytes, validates reference connectivity and supplies prior human context', async () => {
	let sent = 0;
	const env = {
		INBOX: new MemoryBucket(),
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'sender@example.net',
		EMAIL: {
			async send() {
				return { messageId: `<legacy-out-${++sent}@example.com>` };
			},
		},
	};
	const admit = async () => ({ submissionId: 'legacy-sub' });
	const root = await receiveEmail(
		humanMail(
			'legacy-root',
			'<p>내 이름은 푸른달입니다.</p>',
			'',
			'sender@example.net',
			'text/html',
		),
		env,
		admit,
	);
	await replyToEmail(env, root.emailId, 'Acknowledged.');
	const second = await receiveEmail(
		humanMail(
			'legacy-second',
			'<p>이름을 기억해 주세요.</p>',
			'<legacy-out-1@example.com>',
			'sender@example.net',
			'text/html',
		),
		env,
		admit,
	);
	await replyToEmail(env, second.emailId, 'Acknowledged again.');
	for (const key of [...env.INBOX.objects.keys()]) {
		if (key.startsWith('message-index/')) env.INBOX.objects.delete(key);
		if (key.startsWith('inbound/')) {
			delete env.INBOX.objects.get(key).customMetadata.threadId;
			delete env.INBOX.objects.get(key).customMetadata.owner;
		}
	}
	const rawBefore = await (await env.INBOX.get(`inbound/${root.emailId}.eml`)).arrayBuffer();
	await importLegacyThread(env, root.emailId, [second.emailId, root.emailId]);
	const rawAfter = await (await env.INBOX.get(`inbound/${root.emailId}.eml`)).arrayBuffer();
	assert.deepEqual(Buffer.from(rawAfter), Buffer.from(rawBefore));
	const history = await readThreadHistory(env, root.threadId, 'sender@example.net');
	assert.equal(history.length, 2);
	assert.ok(history.some((mail) => mail.text.includes('푸른달')));
	const next = await receiveEmail(
		humanMail('legacy-next', '내 이름이 뭐죠?', '<legacy-out-2@example.com>'),
		env,
		admit,
	);
	assert.equal(next.threadId, root.threadId);
	await assert.rejects(
		() => readThreadHistory(env, root.threadId, 'intruder@example.net'),
		/owner/,
	);
	const unrelated = await receiveEmail(humanMail('legacy-unrelated', 'Independent.'), env, admit);
	await assert.rejects(
		() => importLegacyThread(env, root.emailId, [root.emailId, unrelated.emailId]),
		/connected|legacy/,
	);
});
