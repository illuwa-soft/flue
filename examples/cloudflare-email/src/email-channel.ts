import { env } from 'cloudflare:workers';
import { createEmailChannel } from './email.ts';

export const email = createEmailChannel(env);
