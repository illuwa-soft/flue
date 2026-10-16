import { dispatch } from '@flue/runtime';
import { EmailAssistant } from './agents/email-assistant.ts';
import { receiveEmail } from './channels/email.ts';

export default {
	/** Admit email through the native Worker event rather than an HTTP webhook. / HTTP 웹훅 대신 네이티브 Worker 이벤트로 이메일을 접수합니다. */
	async email(message, env) {
		const admitted = await receiveEmail(message, env, (request) =>
			dispatch(EmailAssistant, request),
		);
		console.log('email.admitted', admitted);
	},
} satisfies ExportedHandler<Env>;
