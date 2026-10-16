import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

/** Use Flue's existing faux-provider mechanism to exercise real tool turns with zero network calls. / 네트워크 없이 실제 도구 턴을 실행하도록 기존 faux provider를 사용합니다. */
export function installLocalModel() {
	const faux = fauxProvider({
		api: 'email-local',
		provider: 'email-local',
		models: [{ id: 'assistant' }],
	});
	const respond: Parameters<typeof faux.setResponses>[0][number] = (context) => {
		faux.appendResponses([respond]);
		const latest = context.messages.at(-1);
		if (latest?.role !== 'toolResult' || latest.toolName !== 'retrieve_cloudflare_email') {
			return fauxAssistantMessage(fauxToolCall('retrieve_cloudflare_email', {}), {
				stopReason: 'toolUse',
			});
		}
		const payload = latest.content
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join('');
		const result = JSON.parse(payload) as {
			email: { text: string };
			hitl: { phase: string; feedback: string };
			replySent: boolean;
			priorEmails: { text: string }[];
		};
		if (result.replySent) return fauxAssistantMessage(fauxText(`HITL: ${result.hitl.phase}`));
		if (
			result.hitl.phase === 'drafting' &&
			(result.hitl.feedback || /문서|document|draft|approval|저장/i.test(result.email.text))
		) {
			return fauxAssistantMessage(
				fauxToolCall('request_email_approval', {
					title: '로컬 검증 문서',
					content: (result.hitl.feedback || result.email.text).slice(0, 12_000),
				}),
				{ stopReason: 'toolUse' },
			);
		}
		const previous = context.messages.flatMap((message) => {
			if (message.role !== 'toolResult' || message.toolName !== 'retrieve_cloudflare_email')
				return [];
			const text = message.content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('');
			return [(JSON.parse(text) as { email: { text: string } }).email.text];
		});
		const text = [...result.priorEmails.map((mail) => mail.text), ...previous]
			.join('\n')
			.slice(-4000);
		return fauxAssistantMessage(
			fauxToolCall('reply_to_cloudflare_email', { text: `로컬 대화 기록:\n${text}` }),
			{ stopReason: 'toolUse' },
		);
	};
	faux.setResponses([respond]);
	setProvider(faux.provider);
}
