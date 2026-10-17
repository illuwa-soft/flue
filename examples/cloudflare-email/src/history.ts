import { indexThreadMessage, readableEmailText } from '@illuwa-soft/flue-cloudflare-email';
import PostalMime from 'postal-mime';
import { emailContext } from './email.ts';

type PriorMail = { emailId: string; subject: string; text: string; receivedAt: string };
type History = { owner: string; emailIds: string[]; messages: PriorMail[] };

/** Recover bounded prior human context without replaying old mail as actions. / 이전 메일을 작업으로 재실행하지 않고 제한된 사람의 대화 맥락만 복원합니다. */
export async function readThreadHistory(env: Env, threadId: string, owner: string) {
	if (!/^[a-f0-9]{64}$/.test(threadId)) throw new Error('Invalid thread id.');
	const history = await (await env.INBOX.get(`thread-history/${threadId}.json`))?.json<History>();
	if (!history) return [];
	if (history.owner !== owner) throw new Error('History owner does not match.');
	const messages: PriorMail[] = [];
	let remaining = 16_000;
	for (const mail of history.messages.slice(-20).reverse()) {
		if (mail.text.length > remaining) break;
		messages.unshift(mail);
		remaining -= mail.text.length;
	}
	return messages;
}

/** Read only explicitly selected v1 mail and its known sent Message-ID. / 명시적으로 선택한 v1 메일과 알려진 발신 Message-ID만 읽습니다. */
async function legacyMail(env: Env, emailId: string) {
	const raw = await env.INBOX.get(`inbound/${emailId}.eml`);
	if (!raw || raw.customMetadata?.threadId) throw new Error('Expected existing legacy mail.');
	if (raw.customMetadata?.to !== env.EMAIL_RECIPIENT) throw new Error('Legacy recipient mismatch.');
	const email = await PostalMime.parse(await raw.arrayBuffer());
	const owner = email.from?.address;
	if (
		!owner ||
		!env.EMAIL_REPLY_ALLOWED_SENDERS.split(',')
			.map((value) => value.trim())
			.includes(owner)
	)
		throw new Error('Legacy owner is not allowed.');
	const receipt = await (
		await env.INBOX.get(`receipts/${emailId}.json`)
	)?.json<{ acceptedAt?: string }>();
	const reply = await (
		await env.INBOX.get(`replies/${emailId}.json`)
	)?.json<{ state: string; messageId?: string }>();
	const incomingId = email.headers.find((header) => header.key === 'message-id')?.value ?? '';
	const references = email.headers
		.filter((header) => ['in-reply-to', 'references'].includes(header.key))
		.map((header) => header.value)
		.join(' ');
	const ids = [incomingId];
	if (reply?.state === 'sent' && reply.messageId) ids.push(reply.messageId);
	return {
		emailId,
		owner,
		ids: ids.filter((id) => /^<[^<>\s]+>$/.test(id)),
		parents: references.match(/<[^<>\s]+>/g) ?? [],
		subject: (email.subject ?? '').slice(0, 200),
		text: readableEmailText(email).slice(0, 3000),
		receivedAt: receipt?.acceptedAt ?? '',
	};
}

/** Extend reference reachability without mixing it with storage mutations. / 저장소 변경과 분리하여 참조 연결 범위를 확장합니다. */
function includeLinkedMail(
	records: Awaited<ReturnType<typeof legacyMail>>[],
	connected: Set<string>,
	known: Set<string>,
) {
	for (const mail of records) {
		if (connected.has(mail.emailId) || !mail.parents.some((id) => known.has(id))) continue;
		connected.add(mail.emailId);
		for (const id of mail.ids) known.add(id);
	}
}

/** Import one operator-selected, connected legacy thread; do not change bytes or approval state. / 운영자가 선택한 연결된 기존 스레드만 가져오며 원문과 승인 상태는 변경하지 않습니다. */
export async function importLegacyThread(env: Env, rootEmailId: string, emailIds: string[]) {
	if (
		!Array.isArray(emailIds) ||
		emailIds.length < 1 ||
		emailIds.length > 50 ||
		!emailIds.includes(rootEmailId)
	)
		throw new Error('Select 1–50 legacy emails including the root.');
	if (emailIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))
		throw new Error('Invalid legacy email id.');
	const records = await Promise.all([...new Set(emailIds)].map((id) => legacyMail(env, id)));
	const root = records.find((mail) => mail.emailId === rootEmailId);
	if (!root) throw new Error('Legacy root is missing.');
	if (records.some((mail) => mail.owner !== root.owner))
		throw new Error('Legacy emails must have the same author.');
	const connected = new Set([rootEmailId]);
	const known = new Set(root.ids);
	for (let pass = 0; pass < records.length; pass++) {
		includeLinkedMail(records, connected, known);
	}
	if (connected.size !== records.length)
		throw new Error('Legacy messages are not a connected reference chain.');
	for (const mail of records) {
		for (const id of mail.ids)
			await indexThreadMessage(emailContext(env), id, rootEmailId, root.owner);
		const key = `legacy-links/${mail.emailId}.json`;
		const value = { threadId: rootEmailId, owner: root.owner };
		const written = await env.INBOX.put(key, JSON.stringify(value), {
			onlyIf: { etagDoesNotMatch: '*' },
		});
		if (written) continue;
		const prior = await (await env.INBOX.get(key))?.json<typeof value>();
		if (prior?.threadId !== rootEmailId || prior.owner !== root.owner)
			throw new Error('Legacy link conflict.');
	}
	const messages = records
		.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
		.map(({ emailId, subject, text, receivedAt }) => ({ emailId, subject, text, receivedAt }));
	const key = `thread-history/${rootEmailId}.json`;
	const history: History = {
		owner: root.owner,
		emailIds: records.map((mail) => mail.emailId).sort(),
		messages,
	};
	const written = await env.INBOX.put(key, JSON.stringify(history), {
		onlyIf: { etagDoesNotMatch: '*' },
	});
	if (!written) {
		const previous = await (await env.INBOX.get(key))?.json<History>();
		if (
			previous?.owner !== history.owner ||
			JSON.stringify(previous.emailIds) !== JSON.stringify(history.emailIds)
		)
			throw new Error('Legacy history conflict.');
	}
	return { threadId: rootEmailId, owner: root.owner, imported: messages.length };
}
