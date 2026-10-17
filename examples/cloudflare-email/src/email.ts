import {
	createCloudflareEmailChannel,
	type EmailContext,
} from '@illuwa-soft/flue-cloudflare-email';

/** Keep simulation and operator policy in the consuming application. / 시뮬레이션과 운영자 정책을 소비 앱에 둡니다. */
export function emailContext(env: Env): EmailContext {
	return {
		INBOX: env.INBOX,
		mailboxAddress: env.EMAIL_RECIPIENT,
		EMAIL: {
			/** Inject a simulated sender locally and retain the demo's live policy. / 로컬 대체 발송을 주입하고 데모의 실발송 정책을 유지합니다. */
			async send(mail) {
				if (String(env.EMAIL_MODE) !== 'local') {
					const allowed = env.EMAIL_REPLY_ALLOWED_SENDERS.split(',').map((address) =>
						address.trim(),
					);
					const recipients = [mail.to].flat().concat(mail.cc ?? []);
					if (recipients.some((address) => !allowed.includes(address)))
						throw new Error('Demo recipient is not allowed.');
					return env.EMAIL.send(mail);
				}
				const messageId = `<local-${crypto.randomUUID()}@example.invalid>`;
				await env.INBOX.put(
					`outbox/${Date.now()}-${crypto.randomUUID()}.json`,
					JSON.stringify({ ...mail, messageId }),
				);
				return { messageId };
			},
		},
	};
}

/** Configure a channel without importing the agent or mutating shared admission. / 에이전트 import와 공유 접수 변경 없이 채널을 설정합니다. */
export function createEmailChannel(env: Env, channelId?: string) {
	const context = emailContext(env);
	return createCloudflareEmailChannel({
		bindings: { EMAIL: context.EMAIL, INBOX: context.INBOX },
		mailboxAddress: context.mailboxAddress,
		channelId,
	});
}
