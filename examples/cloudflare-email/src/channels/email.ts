// flue-blueprint: channel/cloudflare-email@3
import type { AgentDispatchRequest, DispatchReceipt } from '@flue/runtime';
import { convert } from 'html-to-text';
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

/** Parse bounded RFC message references, never a subject-based conversation guess. / 제목 대신 제한된 RFC 메시지 참조로 대화를 연결합니다. */
function messageIds(value: string): string[] {
	const ids = value.match(/<[^<>\s]+>/g) ?? [];
	if (ids.length > 100) throw new Error('Too many email references.');
	return ids;
}

/** Index both incoming and sent Message-IDs under the receiving mailbox. / 수신함 범위에서 수신·발신 Message-ID를 모두 인덱싱합니다. */
export async function indexThreadMessage(
	env: Env,
	messageId: string,
	threadId: string,
	owner: string,
) {
	if (!messageId) return;
	const key = `message-index/${await digest(JSON.stringify([env.EMAIL_RECIPIENT, messageId]))}.json`;
	const indexed = await env.INBOX.put(key, JSON.stringify({ threadId, owner }), {
		onlyIf: { etagDoesNotMatch: '*' },
	});
	if (indexed) return;
	const existing = await (await env.INBOX.get(key))?.json<{ threadId: string; owner: string }>();
	if (existing?.threadId !== threadId || existing.owner !== owner)
		throw new Error('Message reference conflict.');
}

/** Resolve a known thread only for its original participant. / 원래 참여자에게만 기존 스레드를 연결합니다. */
async function resolveThread(env: Env, headers: Headers, emailId: string, owner: string) {
	const candidates = messageIds(
		[
			headers.get('in-reply-to') ?? '',
			headers.get('references') ?? '',
			headers.get('message-id') ?? '',
		].join(' '),
	);
	let threadId: string | undefined;
	for (const candidate of candidates) {
		const key = `message-index/${await digest(JSON.stringify([env.EMAIL_RECIPIENT, candidate]))}.json`;
		const found = await (await env.INBOX.get(key))?.json<{ threadId: string; owner: string }>();
		if (!found) continue;
		if (found.owner !== owner) throw new Error('Thread participant does not match.');
		if (threadId && threadId !== found.threadId)
			throw new Error('Ambiguous email thread references.');
		threadId = found.threadId;
	}
	return threadId ?? emailId;
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
	const existing = await env.INBOX.get(key);
	if (existing && existing.customMetadata?.rawHash !== rawHash) {
		throw new Error('Email identity conflict: existing message has different bytes.');
	}
	const parsed = await PostalMime.parse(raw);
	const owner = parsed.from?.address;
	if (!owner) throw new Error('Email author is missing.');
	const threadId = await resolveThread(env, message.headers, emailId, owner);
	const customMetadata = {
		from: message.from,
		to: message.to,
		messageId,
		rawHash,
		threadId,
		owner,
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
	await indexThreadMessage(env, messageIds(messageId)[0] ?? '', threadId, owner);

	const receipt = await admit({
		id: `cloudflare-thread:${threadId}`,
		idempotencyKey: emailId,
		initialData: { threadId, owner },
		message: {
			kind: 'signal',
			type: 'cloudflare.email.received',
			body: customMetadata.subject,
			attributes: { emailId, threadId, from: message.from, to: message.to },
		},
	});
	await env.INBOX.put(`receipts/${emailId}.json`, JSON.stringify({ ...receipt, threadId }));
	return { emailId, threadId, receipt };
}

/** Decode HTML-only mail with a parser and keep quoted approval commands visibly quoted. / HTML 전용 메일을 파서로 변환하고 인용된 승인 명령은 인용 상태를 유지합니다. */
export function readableEmailText(email: { text?: string; html?: string }) {
	if (email.text?.trim()) return email.text;
	return convert(email.html ?? '', {
		wordwrap: false,
		selectors: [
			{ selector: 'a', options: { ignoreHref: true } },
			{ selector: 'div.gmail_quote', format: 'blockquote' },
			{ selector: 'div.yahoo_quoted', format: 'blockquote' },
		],
	});
}

/** Load only the email bound to this instance; attachments remain metadata-only. / 인스턴스에 연결된 메일만 읽고 첨부파일은 메타데이터만 제공합니다. */
export async function retrieveEmail(env: Env, emailId: string) {
	const stored = await env.INBOX.get(emailKey(emailId));
	if (!stored) throw new Error('Inbound email not found.');

	const email = await PostalMime.parse(await stored.arrayBuffer());
	let threadId = stored.customMetadata?.threadId;
	if (!threadId) {
		const link = await (
			await env.INBOX.get(`legacy-links/${emailId}.json`)
		)?.json<{ threadId: string }>();
		threadId = link?.threadId;
	}
	const text = readableEmailText(email);
	return {
		threadId,
		from: email.from?.address,
		envelopeFrom: stored.customMetadata?.from,
		to: stored.customMetadata?.to,
		subject: email.subject ?? '',
		text: text.slice(0, MAX_CONTEXT_CHARACTERS),
		truncated: text.length > MAX_CONTEXT_CHARACTERS,
		attachments: email.attachments.map(({ filename, mimeType }) => ({ filename, mimeType })),
	};
}

/** Require the current delivery to belong to this thread and participant. / 현재 전달된 메일이 이 스레드와 참여자에게 속하는지 확인합니다. */
export async function retrieveThreadEmail(
	env: Env,
	threadId: string,
	owner: string,
	emailId: string,
) {
	const email = await retrieveEmail(env, emailId);
	if (email.threadId !== threadId || email.from !== owner)
		throw new Error('Email is outside this thread.');
	return email;
}

/** Local mode records a simulated outbox; live mode uses the native binding. / 로컬 모드는 가상 발신함에 기록하고 실환경은 네이티브 바인딩을 사용합니다. */
async function sendMail(
	env: Env,
	mail: {
		from: string;
		to: string;
		subject: string;
		text: string;
		headers: Record<string, string>;
	},
) {
	if (String(env.EMAIL_MODE) !== 'local') return env.EMAIL.send(mail);
	const messageId = `<local-${crypto.randomUUID()}@example.invalid>`;
	await env.INBOX.put(
		`outbox/${Date.now()}-${crypto.randomUUID()}.json`,
		JSON.stringify({ ...mail, messageId }),
	);
	return { messageId };
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
	const mail = {
		from: env.EMAIL_RECIPIENT,
		to: replyTo,
		subject: `Re: ${(email.subject ?? '').replace(/^(?:\s*re:\s*)+/i, '')}`.slice(0, 200),
		text,
		headers,
	};
	const result = await sendMail(env, mail);
	let threadId = metadata.threadId;
	if (!threadId) threadId = (await retrieveEmail(env, emailId)).threadId;
	if (!threadId) throw new Error('Reply thread is missing.');
	await indexThreadMessage(env, result.messageId, threadId, replyTo);
	await env.INBOX.put(replyKey, JSON.stringify({ state: 'sent', messageId: result.messageId }));
	return { messageId: result.messageId };
}
