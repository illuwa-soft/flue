import { env } from 'cloudflare:workers';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { EmailAssistant } from './agents/email-assistant.ts';
import { retrieveEmail } from './channels/email.ts';

const app = new Hono<{ Bindings: Env }>();

/** Expose liveness without exposing inbox data. / 메일 데이터 없이 서비스 상태만 공개합니다. */
app.get('/health', (c) => c.json({ status: 'ok' }));

/** Protect conversation reads and creation-time email bindings. / 대화 조회 및 생성 시 메일 연결을 인증으로 보호합니다. */
app.use('*', async (c, next) => {
	if (c.req.path === '/health') return next();
	if (!env.ADMIN_TOKEN) return c.body(null, 401);
	return bearerAuth<{ Bindings: Env }>({ token: env.ADMIN_TOKEN })(c, next);
});
app.route('/agents/email', createAgentRouter(EmailAssistant));

/** List admission identifiers for authenticated operational checks. / 인증된 운영 검증을 위해 접수 식별자를 나열합니다. */
app.get('/api/emails', async (c) => {
	const listed = await env.INBOX.list({
		prefix: 'receipts/',
		limit: 20,
		cursor: c.req.query('cursor'),
	});
	let cursor: string | undefined;
	if (listed.truncated) cursor = listed.cursor;
	return c.json({
		emailIds: listed.objects.map(({ key }) => key.slice('receipts/'.length, -'.json'.length)),
		truncated: listed.truncated,
		cursor,
	});
});

/** Inspect a known email receipt without adding an HTTP email-ingress route. / HTTP 메일 접수 경로 없이 알려진 이메일의 처리 기록을 확인합니다. */
app.get('/api/emails/:id', async (c) => {
	const emailId = c.req.param('id');
	if (!/^[a-f0-9]{64}$/.test(emailId)) return c.body(null, 400);
	if (!(await env.INBOX.head(`inbound/${emailId}.eml`))) return c.body(null, 404);
	const receipt = await env.INBOX.get(`receipts/${emailId}.json`);
	const reply = await env.INBOX.get(`replies/${emailId}.json`);
	return c.json({
		email: await retrieveEmail(env, emailId),
		receipt: await receipt?.json(),
		reply: await reply?.json(),
	});
});

export default app;
