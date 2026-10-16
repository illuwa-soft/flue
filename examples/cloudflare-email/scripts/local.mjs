import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { unstable_dev } from 'wrangler';

const command = process.argv[2] ?? 'serve';
const { values } = parseArgs({
	args: process.argv.slice(3),
	options: {
		text: { type: 'string' },
		reply: { type: 'string' },
		from: { type: 'string', default: 'tester@example.net' },
	},
});
const base = 'http://127.0.0.1:8787';
const headers = { authorization: 'Bearer local-demo-only' };

/** Read the complete simulated outbox, following R2 pagination. / R2 페이지를 따라 로컬 가상 발신함을 조회합니다. */
async function outbox() {
	const messages = [];
	let cursor = '';
	for (;;) {
		const response = await fetch(`${base}/api/local/outbox?${new URLSearchParams({ cursor })}`, {
			headers,
		});
		if (!response.ok)
			throw new Error(`Local server returned ${response.status}; run dev:local first.`);
		const page = await response.json();
		messages.push(...page.messages);
		if (!page.truncated) return messages;
		cursor = page.cursor;
	}
}

if (command === 'serve') {
	const worker = await unstable_dev('dist/flue_cloudflare_email/index.js', {
		config: 'dist/flue_cloudflare_email/wrangler.json',
		local: true,
		persist: true,
		persistTo: '.wrangler/local-hitl',
		ip: '127.0.0.1',
		port: 8787,
		inspectorPort: 0,
		vars: {
			EMAIL_MODE: 'local',
			ADMIN_TOKEN: 'local-demo-only',
			EMAIL_RECIPIENT: 'support@example.com',
			EMAIL_REPLY_ALLOWED_SENDERS: 'tester@example.net',
		},
		logLevel: 'error',
		experimental: { disableExperimentalWarning: true, watch: false, forceLocal: true },
	});
	console.log(
		`이메일 HITL 로컬 서버: ${base}\n외부 모델·실제 이메일 발송 없음. 상태는 .wrangler/local-hitl에 유지됩니다.\n다른 터미널에서 pnpm --filter cloudflare-email-example email:local --text "작성할 문서 내용" 을 실행하세요.`,
	);
	process.once('SIGINT', () => void worker.stop());
	process.once('SIGTERM', () => void worker.stop());
	await worker.waitUntilExit();
}

if (command === 'outbox') console.log(JSON.stringify(await outbox(), null, 2));

if (command === 'send') {
	if (!values.text) throw new Error('--text is required.');
	let parent = values.reply ?? '';
	if (parent === 'latest') parent = (await outbox()).at(-1)?.messageId ?? '';
	if (values.reply && !parent) throw new Error('No outgoing message to reply to.');
	if (/[\r\n]/.test(parent + values.from)) throw new Error('Invalid header value.');
	const messageId = `<${randomUUID()}@local.example.net>`;
	const to = 'support@example.com';
	const raw = [
		`From: ${values.from}`,
		`To: ${to}`,
		`Message-ID: ${messageId}`,
		`In-Reply-To: ${parent}`,
		'Subject: Local HITL',
		'Content-Type: text/plain; charset=utf-8',
		'',
		values.text,
	].join('\r\n');
	const emailId = createHash('sha256')
		.update(JSON.stringify([values.from, to, messageId]))
		.digest('hex');
	const response = await fetch(
		`${base}/cdn-cgi/handler/email?${new URLSearchParams({ from: values.from, to })}`,
		{ method: 'POST', body: raw },
	);
	if (!response.ok) throw new Error(await response.text());
	const admitted = await (await fetch(`${base}/api/emails/${emailId}`, { headers })).json();
	console.log(`접수: ${emailId}\n스레드: ${admitted.receipt.threadId}`);
	for (let attempt = 0; attempt < 120; attempt++) {
		const found = (await outbox()).find((mail) => mail.headers['In-Reply-To'] === messageId);
		if (found) {
			console.log(`\n가상 답장 ${found.messageId}\n\n${found.text}`);
			console.log(
				`\n상태 조회: ${base}/api/threads/${admitted.receipt.threadId} (Bearer local-demo-only)`,
			);
			process.exit(0);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error('No simulated reply within 12 seconds; inspect server output.');
}
