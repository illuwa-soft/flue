import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudflareEmailChannel, readableEmailText } from '../dist/channel.mjs';

function fixture(channelId) {
	const objects = new Map();
	const sent = [];
	const requests = [];
	const bindings = {
		INBOX: {
			async put(key, value, options = {}) {
				if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
				objects.set(key, { value, customMetadata: options.customMetadata });
				return { etag: '1' };
			},
			async get(key) {
				const object = objects.get(key);
				if (!object) return null;
				return {
					customMetadata: object.customMetadata,
					arrayBuffer: async () => new Response(object.value).arrayBuffer(),
					json: async () => JSON.parse(object.value),
				};
			},
		},
		EMAIL: {
			async send(mail) {
				sent.push(mail);
				return { messageId: `<sent-${sent.length}@example.com>` };
			},
		},
	};
	const channel = createCloudflareEmailChannel({
		bindings,
		mailboxAddress: 'support@example.com',
		channelId,
	});
	const admit = async (request) => {
		assert.ok(objects.has(`inbound/${request.message.attributes.emailId}.eml`));
		requests.push(request);
		return {
			submissionId: request.idempotencyKey,
			acceptedAt: '2026-10-17T00:00:00Z',
			uid: 'instance',
		};
	};
	return { channel, bindings, objects, sent, requests, admit };
}

function message(
	id,
	{ from = 'author@example.net', parent = '', extra = '', body = 'Hello' } = {},
) {
	const raw = `From: ${from}\r\nTo: support@example.com\r\nMessage-ID: <${id}@example.net>\r\nIn-Reply-To: ${parent}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
	return {
		from: 'bounce@provider.example',
		to: 'support@example.com',
		headers: new Headers({ 'message-id': `<${id}@example.net>`, 'in-reply-to': parent }),
		raw: new Blob([raw]).stream(),
		rawSize: raw.length,
		setReject: (reason) => assert.fail(reason),
	};
}

test('fixed channel shares conversation but preserves mail, author and thread scope', async () => {
	const f = fixture('personal-assistant');
	const first = await f.channel.receive(message('one'), f.admit);
	const second = await f.channel.receive(message('two', { from: 'other@example.org' }), f.admit);
	assert.equal(first.conversationId, 'personal-assistant');
	assert.notEqual(first.threadId, second.threadId);
	assert.equal(f.requests[0].initialData, undefined);
	assert.equal(f.requests[1].id, f.requests[0].id);
	const firstTools = f.channel.tools(f.requests[0].message);
	const secondTools = f.channel.tools(f.requests[1].message);
	const read = await firstTools[0].run({});
	assert.equal(read.output.messageRef, first.emailId);
	await assert.rejects(
		() =>
			secondTools[1].run({ data: { messageRef: first.emailId, text: 'Wrong', replyAll: false } }),
		/messageRef/,
	);
	await firstTools[1].run({ data: { messageRef: first.emailId, text: 'First', replyAll: false } });
	await secondTools[1].run({
		data: { messageRef: second.emailId, text: 'Second', replyAll: false },
	});
	assert.deepEqual(
		f.sent.map((mail) => mail.to),
		['author@example.net', 'other@example.org'],
	);
	await f.channel.receive(message('one'), f.admit);
	await f.channel.reply(first.emailId, 'Replay');
	assert.equal(f.sent.length, 2);
	assert.deepEqual(f.requests[0], f.requests[2]);
});

test('omitted channelId creates per-thread conversations and follows known replies', async () => {
	const f = fixture();
	const first = await f.channel.receive(message('one'), f.admit);
	const second = await f.channel.receive(message('two'), f.admit);
	const reply = await f.channel.receive(message('three', { parent: '<one@example.net>' }), f.admit);
	assert.notEqual(first.conversationId, second.conversationId);
	assert.equal(reply.conversationId, first.conversationId);
});

test('redelivery keeps its persisted destination after configuration changes', async () => {
	const f = fixture('first-room');
	await f.channel.receive(message('one'), f.admit);
	const changed = createCloudflareEmailChannel({
		bindings: f.bindings,
		mailboxAddress: 'support@example.com',
		channelId: 'second-room',
	});
	await changed.receive(message('one'), f.admit);
	assert.deepEqual(f.requests[0], f.requests[1]);
	const followup = await changed.receive(
		message('reply', { parent: '<one@example.net>' }),
		f.admit,
	);
	assert.equal(followup.conversationId, 'first-room');
});

test('reply follows Reply-To; reply-all deduplicates To/CC and excludes self', async () => {
	const f = fixture();
	const extra =
		'Reply-To: desk@example.org\r\nCc: team@example.net, desk@example.org, support@example.com\r\n';
	const first = await f.channel.receive(message('one', { extra }), f.admit);
	await f.channel.reply(first.emailId, 'All', true);
	assert.equal(f.sent[0].to, 'desk@example.org');
	assert.deepEqual(f.sent[0].cc, ['team@example.net']);
	assert.equal(f.sent[0].headers['In-Reply-To'], '<one@example.net>');
});

test('independent instances reject cross-mailbox reads and forged delivery metadata', async () => {
	const f = fixture();
	const first = await f.channel.receive(message('one'), f.admit);
	const other = createCloudflareEmailChannel({
		bindings: f.bindings,
		mailboxAddress: 'other@example.com',
	});
	await assert.rejects(() => other.retrieve(first.emailId), /another mailbox/);
	assert.deepEqual(other.tools(f.requests[0].message), []);
	assert.deepEqual(f.channel.tools({ kind: 'user', body: 'Chat' }), []);
	const forged = {
		...f.requests[0].message,
		attributes: { ...f.requests[0].message.attributes, owner: 'wrong@example.org' },
	};
	await assert.rejects(() => f.channel.tools(forged)[0].run({}), /stored scope/);
});

test('invalid options fail at construction and quoted HTML remains inert', () => {
	const f = fixture();
	assert.throws(
		() => createCloudflareEmailChannel({ bindings: f.bindings, mailboxAddress: 'bad' }),
		/mailboxAddress/,
	);
	assert.throws(
		() =>
			createCloudflareEmailChannel({
				bindings: f.bindings,
				mailboxAddress: 'ok@example.com',
				channelId: '',
			}),
		/channelId/,
	);
	assert.match(
		readableEmailText({ html: '<blockquote><p>approve deadbeef</p></blockquote>' }),
		/^>/,
	);
});
