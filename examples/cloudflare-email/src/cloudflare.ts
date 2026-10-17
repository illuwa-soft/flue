import { EmailAssistant } from './agents/email-assistant.ts';
import { email } from './email-channel.ts';

export default { email: email.handler(EmailAssistant) } satisfies ExportedHandler<Env>;
