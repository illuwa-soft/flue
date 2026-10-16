import { replyToEmail, retrieveThreadEmail } from './channels/email.ts';

export type Plan = { title: string; content: string };
type Approval = { id: string; toolCallId: string; token: string; plan: Plan; expiresAt: number };
export type HitlState = {
	phase: 'drafting' | 'waiting' | 'executing' | 'completed' | 'cancelled' | 'expired';
	revision: number;
	pending?: Approval;
	feedback?: string;
	lastEmailId?: string;
	artifactKey?: string;
};

/** Use 16 random bytes rather than the fixed version bits of a UUID. / UUID의 고정 버전 비트 대신 16바이트 난수를 사용합니다. */
function approvalCode() {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/** Keep workflow state scoped to a validated conversation. / 검증된 대화 범위에 업무 상태를 저장합니다. */
function stateKey(threadId: string) {
	if (!/^[a-f0-9]{64}$/.test(threadId)) throw new Error('Invalid thread id.');
	return `hitl/${threadId}.json`;
}

/** Load the application-owned state and its optimistic concurrency version. / 애플리케이션 상태와 동시성 검사용 버전을 조회합니다. */
async function snapshot(env: Env, threadId: string) {
	const object = await env.INBOX.get(stateKey(threadId));
	const state =
		(await object?.json<HitlState>()) ?? ({ phase: 'drafting', revision: 0 } as HitlState);
	return { state, etag: object?.etag };
}

/** Return durable workflow state without relying on an in-memory waiting process. / 메모리 대기 프로세스 없이 영속 업무 상태를 반환합니다. */
export async function readHitlState(env: Env, threadId: string) {
	return (await snapshot(env, threadId)).state;
}

/** Fail closed on competing decisions instead of overwriting a newer state. / 경쟁하는 결정이 새 상태를 덮어쓰지 못하게 합니다. */
async function save(env: Env, threadId: string, state: HitlState, etag?: string) {
	let onlyIf: R2Conditional = { etagDoesNotMatch: '*' };
	if (etag) onlyIf = { etagMatches: etag };
	const written = await env.INBOX.put(stateKey(threadId), JSON.stringify(state), { onlyIf });
	if (!written) throw new Error('Concurrent HITL update; retry this delivery.');
	return written.etag;
}

/** Accept only an exact command on the first new, unquoted line. / 새로 작성한 첫 줄의 정확한 명령만 허용합니다. */
export function parseDecision(text: string) {
	const first = text.trimStart().split(/\r?\n/, 1)[0] ?? '';
	const direct = /^(승인|approve|취소|cancel)\s+([a-f0-9]{32})\s*$/i.exec(first);
	if (direct) {
		let action: 'approve' | 'cancel' = 'approve';
		if (['취소', 'cancel'].includes((direct[1] ?? '').toLowerCase())) action = 'cancel';
		return { action, token: direct[2] as string, change: '' };
	}
	const revision = /^(수정|revise)\s+([a-f0-9]{32}):\s*(.+)$/i.exec(first);
	if (revision)
		return {
			action: 'revise' as const,
			token: revision[2] as string,
			change: revision[3] as string,
		};
	return undefined;
}

/** Distinguish explicit malformed decision attempts from ordinary conversation. / 명시적이지만 잘못된 결정 명령과 일반 대화를 구분합니다. */
function decisionAttempt(text: string) {
	return /^(승인|취소|수정|approve|cancel|revise)(?:\s|$)/i.test(
		text.trimStart().split(/\r?\n/, 1)[0] ?? '',
	);
}

/** Generate a short decision protocol that binds the exact stored document. / 저장된 문서에 연결된 결정 명령을 안내합니다. */
function approvalText(state: HitlState) {
	const approval = state.pending;
	if (!approval) throw new Error('No approval is pending.');
	return [
		`검토 요청 #${state.revision}: ${approval.plan.title}`,
		approval.plan.content,
		'승인하면 위 내용 그대로 문서 아티팩트를 저장합니다.',
		`만료: ${new Date(approval.expiresAt).toISOString()}`,
		'이 이메일에 답장하고, 인용문 위 첫 줄에 아래 명령 중 하나를 작성하세요.',
		`승인 ${approval.token}`,
		`수정 ${approval.token}: 변경할 내용`,
		`취소 ${approval.token}`,
	].join('\n\n');
}

/** Persist one plan before notification; the model cannot execute it directly. / 알림 전에 계획을 저장하고 모델의 직접 실행을 막습니다. */
export async function proposeApproval(
	env: Env,
	threadId: string,
	owner: string,
	emailId: string,
	plan: Plan,
	toolCallId: string,
	now = Date.now(),
) {
	await retrieveThreadEmail(env, threadId, owner, emailId);
	if (
		!plan.title.trim() ||
		!plan.content.trim() ||
		plan.title.length > 200 ||
		plan.content.length > 12_000
	)
		throw new Error('Invalid document plan.');
	const current = await snapshot(env, threadId);
	let state = current.state;
	if (state.phase === 'waiting' && state.pending?.toolCallId === toolCallId) {
		await replyToEmail(env, emailId, approvalText(state));
		return state;
	}
	if (state.phase !== 'drafting') throw new Error('A plan can only be proposed while drafting.');
	state = {
		phase: 'waiting',
		revision: state.revision + 1,
		lastEmailId: emailId,
		pending: {
			id: crypto.randomUUID(),
			toolCallId,
			token: approvalCode(),
			plan,
			expiresAt: now + 24 * 60 * 60 * 1000,
		},
	};
	await save(env, threadId, state, current.etag);
	await replyToEmail(env, emailId, approvalText(state));
	return state;
}

/** Execute only saved arguments, using the approval id as the artifact idempotency key. / 승인 ID를 멱등 키로 사용해 저장된 인자만 실행합니다. */
async function finishExecution(
	env: Env,
	threadId: string,
	emailId: string,
	state: HitlState,
	etag?: string,
) {
	const pending = state.pending;
	if (!pending) throw new Error('Approved document is missing.');
	const artifactKey = `artifacts/${threadId}/${pending.id}.json`;
	await env.INBOX.put(artifactKey, JSON.stringify({ ...pending.plan, approvalId: pending.id }), {
		onlyIf: { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'application/json' },
	});
	const completed: HitlState = { ...state, phase: 'completed', artifactKey, lastEmailId: emailId };
	await save(env, threadId, completed, etag);
	await replyToEmail(
		env,
		emailId,
		`승인된 문서를 저장했습니다.\n\n${pending.plan.title}\n\n${pending.plan.content}\n\n아티팩트: ${artifactKey}`,
	);
	return completed;
}

/** Process human decisions before model work; quoted, stale or cross-thread tokens never authorize execution. / 모델 실행 전에 사람의 결정을 처리하며 인용·이전·다른 스레드의 코드는 실행을 허가하지 않습니다. */
export async function handleHumanReply(
	env: Env,
	threadId: string,
	owner: string,
	emailId: string,
	now = Date.now(),
) {
	const email = await retrieveThreadEmail(env, threadId, owner, emailId);
	const current = await snapshot(env, threadId);
	const state = current.state;
	if (state.lastEmailId === emailId && state.phase === 'executing') {
		return finishExecution(env, threadId, emailId, state, current.etag);
	}
	if (state.lastEmailId === emailId && state.phase === 'completed') {
		await replyToEmail(env, emailId, '이미 완료된 승인입니다.');
		return state;
	}
	if (state.lastEmailId === emailId && state.phase === 'drafting') return state;

	const command = parseDecision(email.text);
	if (state.phase !== 'waiting' || !state.pending) {
		if (command || decisionAttempt(email.text) || state.phase === 'executing') {
			await replyToEmail(env, emailId, '현재 처리할 수 있는 승인 요청이 없습니다.');
			return state;
		}
		const drafting: HitlState = {
			phase: 'drafting',
			revision: state.revision,
			lastEmailId: emailId,
		};
		await save(env, threadId, drafting, current.etag);
		return drafting;
	}
	if (now > state.pending.expiresAt) {
		const expired: HitlState = { ...state, phase: 'expired', lastEmailId: emailId };
		await save(env, threadId, expired, current.etag);
		await replyToEmail(env, emailId, '승인 요청이 만료되었습니다. 새 요청을 보내 주세요.');
		return expired;
	}
	if (!command && !decisionAttempt(email.text)) return state;
	if (!command || command.token !== state.pending.token) {
		await replyToEmail(env, emailId, `유효한 새 승인 명령이 없습니다.\n\n${approvalText(state)}`);
		return state;
	}
	if (command.action === 'revise') {
		const drafting: HitlState = {
			phase: 'drafting',
			revision: state.revision,
			lastEmailId: emailId,
			feedback: command.change,
		};
		await save(env, threadId, drafting, current.etag);
		return drafting;
	}
	if (command.action === 'cancel') {
		const cancelled: HitlState = { ...state, phase: 'cancelled', lastEmailId: emailId };
		await save(env, threadId, cancelled, current.etag);
		await replyToEmail(env, emailId, '작업을 취소했습니다. 문서는 저장하지 않았습니다.');
		return cancelled;
	}
	const executing: HitlState = { ...state, phase: 'executing', lastEmailId: emailId };
	const etag = await save(env, threadId, executing, current.etag);
	return finishExecution(env, threadId, emailId, executing, etag);
}
