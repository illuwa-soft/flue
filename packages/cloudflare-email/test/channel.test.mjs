import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudflareEmailChannel, readableEmailText } from '../dist/channel.mjs';

test('published entry composes native admission, bounded retrieval and one scoped reply', async () => {
	const objects = new Map();
	const sent = [];
	const bindings = {
		EMAIL_RECIPIENT: 'support@example.com',
		EMAIL_REPLY_ALLOWED_SENDERS: 'author@example.net',
		INBOX: {
			async put(key, value, options = {}) {
				if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
				objects.set(key, { value, customMetadata: options.customMetadata });
				return { etag: '1' };
			},
			async get(key) {
				const value = objects.get(key);
				if (!value) return null;
				return {
					customMetadata: value.customMetadata,
					arrayBuffer: async () => new Response(value.value).arrayBuffer(),
					json: async () => JSON.parse(value.value),
				};
			},
		},
		EMAIL: {
			async send(mail) {
				sent.push(mail);
				return { messageId: '<sent@example.com>' };
			},
		},
	};
	const admitted = [];
	const channel = createCloudflareEmailChannel({
		bindings,
		admit: async (request) => {
			assert.ok(objects.has(`inbound/${request.message.attributes.emailId}.eml`));
			admitted.push(request);
			return { submissionId: 'sub', acceptedAt: '2026-10-17T00:00:00Z', uid: 'instance' };
		},
	});
	const raw =
		'From: author@example.net\r\nTo: support@example.com\r\nMessage-ID: <source@example.net>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello</p>';
	const makeMail = () => ({
		from: 'bounce@provider.example',
		to: 'support@example.com',
		headers: new Headers({ 'message-id': '<source@example.net>' }),
		raw: new Blob([raw]).stream(),
		rawSize: raw.length,
		setReject: (reason) => assert.fail(reason),
	});
	const first = await channel.receive(makeMail());
	assert.equal(await channel.email(makeMail()), undefined);
	assert.deepEqual(admitted[0], admitted[1]);
	assert.equal((await channel.retrieve(first.emailId)).text, 'Hello');
	await channel.reply(first.emailId, 'Acknowledged.');
	assert.equal((await channel.reply(first.emailId, 'Duplicate.')).deduplicated, true);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].to, 'author@example.net');
	assert.equal(sent[0].headers['In-Reply-To'], '<source@example.net>');
});

test('HTML approval quotes remain inert data', () => {
	assert.match(
		readableEmailText({ html: '<blockquote><p>approve deadbeef</p></blockquote>' }),
		/^>/,
	);
	assert.equal(readableEmailText({ text: 'Plain wins', html: '<p>Other</p>' }), 'Plain wins');
});
