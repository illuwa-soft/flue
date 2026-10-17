import { dispatch } from '@flue/runtime';
import { createCloudflareEmailChannel } from '@illuwa-soft/flue-cloudflare-email';
import { EmailAssistant } from './agents/email-assistant.ts';

export default {
	/** Admit email through the native Worker event rather than an HTTP webhook. / HTTP 웹훅 대신 네이티브 Worker 이벤트로 이메일을 접수합니다. */
	async email(message, env) {
		const channel = createCloudflareEmailChannel({
			bindings: env,
			admit: (request) => dispatch(EmailAssistant, request),
		});
		const admitted = await channel.receive(message);
		console.log('email.admitted', admitted);
	},
} satisfies ExportedHandler<Env>;
