// flue-blueprint: channel/cloudflare-email@1
import type { AgentDispatchRequest, DispatchReceipt } from '@flue/runtime';
import PostalMime from 'postal-mime';

const MAX_EMAIL_BYTES = 1024 * 1024;
const MAX_CONTEXT_CHARACTERS = 16_000;

/** Hash envelope-scoped identities without putting email addresses in object keys. / 주소가 객체 키에 드러나지 않도록 봉투 범위 식별자를 해시합니다. */
async function digest(value: string | ArrayBuffer): Promise<string> {
	let bytes = value;
	if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes).buffer;

	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Limit R2 access to a server-created email identity. / 서버가 생성한 이메일 식별자 범위로 R2 접근을 제한합니다. */
function emailKey(emailId: string): string {
	if (!/^[a-f0-9]{64}$/.test(emailId)) throw new TypeError('Invalid email id.');
	return `inbound/${emailId}.eml`;
}

/** Persist original bytes before durable admission; retry the same delivery with the same key. / 원문 저장 후 영속 접수하며 재전달에는 동일 키를 사용합니다. */
export async function receiveEmail(
	message: ForwardableEmailMessage,
	env: Env,
	admit: (request: AgentDispatchRequest) => Promise<DispatchReceipt>,
) {
	if (message.to !== env.EMAIL_RECIPIENT) {
		message.setReject('Recipient is not configured.');
		return;
	}
	if (message.rawSize > MAX_EMAIL_BYTES) {
		message.setReject('Email is too large; maximum is 1 MiB.');
		return;
	}

	const raw = await new Response(message.raw).arrayBuffer();
	if (raw.byteLength > MAX_EMAIL_BYTES) {
		message.setReject('Email is too large; maximum is 1 MiB.');
		return;
	}

	const rawHash = await digest(raw);
	const messageId = message.headers.get('message-id') ?? '';
	const identity = messageId || rawHash;
	const emailId = await digest(JSON.stringify([message.from, message.to, identity]));
	const key = emailKey(emailId);
	const customMetadata = {
		from: message.from,
		to: message.to,
		messageId,
		rawHash,
		subject: message.headers.get('subject') ?? '',
		autoSubmitted: message.headers.get('auto-submitted') ?? 'no',
		listId: message.headers.get('list-id') ?? '',
	};
	const stored = await env.INBOX.put(key, raw, {
		onlyIf: { etagDoesNotMatch: '*' },
		customMetadata,
		httpMetadata: { contentType: 'message/rfc822' },
	});
	if (!stored) {
		const existing = await env.INBOX.get(key);
		if (existing?.customMetadata?.rawHash !== rawHash) {
			throw new Error('Email identity conflict: existing message has different bytes.');
		}
	}

	const receipt = await admit({
		id: `cloudflare-email:${emailId}`,
		idempotencyKey: emailId,
		initialData: { emailId },
		message: {
			kind: 'signal',
			type: 'cloudflare.email.received',
			body: customMetadata.subject,
			attributes: { emailId, from: message.from, to: message.to },
		},
	});
	await env.INBOX.put(`receipts/${emailId}.json`, JSON.stringify(receipt));
	return { emailId, receipt };
}

/** Load only the email bound to this instance; attachments remain metadata-only. / 인스턴스에 연결된 메일만 읽고 첨부파일은 메타데이터만 제공합니다. */
export async function retrieveEmail(env: Env, emailId: string) {
	const stored = await env.INBOX.get(emailKey(emailId));
	if (!stored) throw new Error('Inbound email not found.');

	const email = await PostalMime.parse(await stored.arrayBuffer());
	return {
		from: email.from?.address,
		envelopeFrom: stored.customMetadata?.from,
		to: stored.customMetadata?.to,
		subject: email.subject ?? '',
		text: (email.text ?? email.html ?? '').slice(0, MAX_CONTEXT_CHARACTERS),
		truncated: (email.text ?? email.html ?? '').length > MAX_CONTEXT_CHARACTERS,
		attachments: email.attachments.map(({ filename, mimeType }) => ({ filename, mimeType })),
	};
}

/** Reserve a reply before sending; an uncertain outcome requires operator reconciliation. / 발송 전 답장을 선점하고 불확실한 결과는 운영자 확인 대상으로 남깁니다. */
export async function replyToEmail(env: Env, emailId: string, text: string) {
	if (!text.trim() || text.length > MAX_CONTEXT_CHARACTERS) throw new Error('Invalid reply text.');

	const stored = await env.INBOX.get(emailKey(emailId));
	if (!stored?.customMetadata) throw new Error('Inbound email not found.');

	const metadata = stored.customMetadata;
	const email = await PostalMime.parse(await stored.arrayBuffer());
	const replyTo = email.from?.address;
	if (!replyTo || !metadata.from) throw new Error('Reply sender is missing.');
	const allowedSenders = env.EMAIL_REPLY_ALLOWED_SENDERS.split(',').map((value) => value.trim());
	if (!allowedSenders.includes(replyTo)) throw new Error('Sender is not allowed for replies.');
	if (metadata.to !== env.EMAIL_RECIPIENT || replyTo === metadata.to) {
		throw new Error('Reply destination is invalid.');
	}
	if (metadata.autoSubmitted !== 'no' || metadata.listId)
		throw new Error('Automated email cannot be replied to.');

	const replyKey = `replies/${emailId}.json`;
	const reserved = await env.INBOX.put(replyKey, JSON.stringify({ state: 'sending' }), {
		onlyIf: { etagDoesNotMatch: '*' },
	});
	if (!reserved) {
		const previous = await env.INBOX.get(replyKey);
		const result = await previous?.json<{ state: string; messageId?: string }>();
		if (result?.state === 'sent') return { messageId: result.messageId, deduplicated: true };
		throw new Error('Reply outcome is uncertain; reconcile before retrying.');
	}

	const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
	if (/^<[^<>\s]+>$/.test(metadata.messageId ?? '')) {
		headers['In-Reply-To'] = metadata.messageId as string;
		headers.References = metadata.messageId as string;
	}
	const result = await env.EMAIL.send({
		from: env.EMAIL_RECIPIENT,
		to: replyTo,
		subject: `Re: ${email.subject ?? ''}`.slice(0, 200),
		text,
		headers,
	});
	await env.INBOX.put(replyKey, JSON.stringify({ state: 'sent', messageId: result.messageId }));
	return { messageId: result.messageId };
}
