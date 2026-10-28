import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import type {
  RequestContext,
  UserQuestionItem,
  UserQuestionAnswerSubmission,
} from '@allrice/contracts';
import {
  matchUserQuestionAnswer,
  RuntimeNativeInputProofSchema,
} from '@allrice/contracts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { getDatabase } from './core/client.ts';
import { requirePlatformAdmin } from './platform-authority.ts';

const modeSchema = z.enum(['legacy', 'timed']);
export type NativeQuestionMode = z.infer<typeof modeSchema>;
type Sql = ReturnType<typeof getDatabase> | TransactionSql;
export async function readNativeQuestionMode(
  sql: Sql = getDatabase(),
): Promise<NativeQuestionMode> {
  const [row] = await sql`select value from allrice_settings
    where scope_type='system' and scope_id is null and key='native_question_mode'`;
  return modeSchema.parse(row?.value ?? 'legacy');
}

/** Acquire before principal, root, clock, Job or receipt locks. */
export async function lockNativeQuestionMode(tx: TransactionSql) {
  await tx`select id from allrice_settings where scope_type='system'
    and scope_id is null and key='native_question_mode' for share`;
}

export function isNativeQuestionProjection(payload: unknown) {
  const event = payload as { source?: string; sourceEventType?: string } | null;
  return (
    event?.source === 'dsh' &&
    event.sourceEventType === 'session/user-questions'
  );
}

/** The platform rollout switch is shared by Web and Worker, never an env override. */
export async function getNativeQuestionMode(context: RequestContext) {
  await requirePlatformAdmin(context);
  return readNativeQuestionMode();
}
export async function updateNativeQuestionMode(
  context: RequestContext,
  value: unknown,
) {
  const actor = await requirePlatformAdmin(context);
  const mode = modeSchema.parse(value);
  const { refreshTaskClock } = await import('./task-clock.ts');
  return getDatabase().begin(async (tx) => {
    await tx`select id from allrice_settings where scope_type='system'
      and scope_id is null and key='native_question_mode' for update`;
    // The setting fences new projections and answer-authorizing transactions.
    // Lock every affected live Run in stable order, preserving 703 -> root ->
    // clock -> Job, before touching question rows also written by stop.
    const runs =
      mode === 'legacy'
        ? await tx<{ run_id: string }[]>`
      select distinct e.run_id from allrice_employee_runs e
      join allrice_runs r on r.id=e.run_id
      join allrice_native_questions q on q.session_id=e.session_id
      where r.state not in ('succeeded','failed','canceled')
        and q.state in ('open','continued') and q.closed_at is null
      order by e.run_id`
        : [];
    for (const run of runs) {
      await tx`select pg_advisory_xact_lock(hashtextextended(${run.run_id},703))`;
      await refreshTaskClock(tx, run.run_id);
    }
    // This is revocation, not a substitute DSH state: keep the native projection
    // intact, and never make an old question answerable again when re-enabled.
    if (mode === 'legacy')
      await tx`update allrice_native_questions set closed_at=clock_timestamp()
        where state in ('open','continued') and closed_at is null`;
    await tx`insert into allrice_settings(scope_type,key,value,updated_by)
      values('system','native_question_mode',${tx.json(mode)},${actor})
      on conflict(scope_type,scope_id,key) do update
      set value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()`;
    for (const run of runs) await refreshTaskClock(tx, run.run_id);
    return mode;
  });
}

export interface NativeQuestionProjection {
  sessionId: string;
  sequence: number;
  questions: {
    active: {
      callId: string;
      state: 'open' | 'continued';
      questions: UserQuestionItem[];
    }[];
    settled: {
      callId: string;
      answers: UserQuestionAnswerSubmission['answers'];
    }[];
  };
}

/** Caller acquired the mode fence before its lease/root locks. Copy DSH's view;
 * never interpret tool results or compute a question transition ourselves. */
export async function recordNativeQuestions(
  tx: TransactionSql,
  runId: string,
  payload: unknown,
) {
  const event = payload as {
    source?: string;
    sourceEventType?: string;
    nativePayload?: NativeQuestionProjection;
  } | null;
  if (!isNativeQuestionProjection(event)) return;
  const view = event!.nativePayload!;
  const [scope] = await tx`select s.id from allrice_employee_runs e
    join allrice_chat_sessions s on s.id=e.session_id
      and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id
      and s.owner_id=e.owner_id
    join allrice_native_session_bindings b on b.native_session_id=${view.sessionId}
      and b.context_kind='chat' and b.context_id=s.id and b.organization_id=s.organization_id
      and b.workspace_id=s.workspace_id and b.owner_id=s.owner_id
    join allrice_conversation_runtimes cr on cr.session_id=s.id and cr.thread_id=b.native_session_id
      and cr.active_run_id=e.run_id and cr.state='running'
    join allrice_jobs j on j.run_id=e.run_id and j.worker_id=cr.worker_id and j.status='running'
    where e.run_id=${runId}
      and (s.native_question_sequences->>${view.sessionId} is null
        or (s.native_question_sequences->>${view.sessionId})::bigint<${view.sequence})
    for update of s`;
  if (!scope) return;
  // A new approved native Session cannot inherit or revive a previous call's
  // authority, even if DSH reuses callId or an old snapshot arrives later.
  await tx`update allrice_native_questions set closed_at=coalesce(closed_at,clock_timestamp())
    where session_id=${scope.id} and native_session_id<>${view.sessionId}`;
  // Rollback fences notifications already in flight in an old timed Host.
  const mode = await readNativeQuestionMode(tx);
  const items = [
    ...view.questions.active.map((q) => ({ ...q, answers: null })),
    ...view.questions.settled.map((q) => ({
      ...q,
      state: 'settled',
      questions: null,
    })),
  ];
  for (const item of items) {
    await tx`insert into allrice_native_questions
      (session_id,native_session_id,call_id,source_run_id,state,questions,answers,sequence,closed_at)
      values(${scope.id},${view.sessionId},${item.callId},${runId},${item.state},
        ${tx.json(item.questions ?? [])},${item.answers === null ? null : tx.json(item.answers)},${view.sequence},
        ${mode === 'legacy' ? new Date() : null})
      on conflict(session_id,native_session_id,call_id) do update set state=excluded.state,
        questions=case when allrice_native_questions.questions='[]'::jsonb
          then excluded.questions else allrice_native_questions.questions end,
        answers=excluded.answers,sequence=excluded.sequence,native_present=true,
        closed_at=coalesce(allrice_native_questions.closed_at,excluded.closed_at)`;
  }
  // Mirror membership without inventing a native terminal state. Preserve the
  // original question and revocation facts even if DSH later removes the call.
  await tx`update allrice_native_questions set native_present=false,sequence=${view.sequence}
    where session_id=${scope.id} and native_session_id=${view.sessionId}
    and not (call_id=any(${items.map((q) => q.callId)}::text[]))`;
  await tx`update allrice_chat_sessions set native_question_sequences=
    jsonb_set(native_question_sequences,${[view.sessionId]}::text[],to_jsonb(${view.sequence}::bigint))
    where id=${scope.id}`;
}

/** Product stop revokes only questions first observed in this Run. Archiving
 * does not revoke; deleting the owning Session cascades the projection. */
export async function closeNativeRunQuestions(
  tx: TransactionSql,
  runId: string,
) {
  const [table] =
    await tx`select to_regclass(format('%I.allrice_native_questions',current_schema())) is not null available`;
  if (!table?.available) return;
  await tx`update allrice_native_questions set closed_at=clock_timestamp()
    where source_run_id=${runId} and state in ('open','continued') and closed_at is null`;
}

/** Callers already have session authority; query identity is scoped by both ids. */
export async function readNativeQuestion(
  tx: TransactionSql,
  sessionId: string,
  questionId: string,
) {
  const [row] = await tx`select q.* from allrice_native_questions q
    join allrice_chat_sessions s on s.id=q.session_id
    join allrice_conversation_runtimes r on r.session_id=s.id and r.thread_id=q.native_session_id
    join allrice_native_session_bindings b on b.native_session_id=q.native_session_id
      and b.context_kind='chat' and b.context_id=s.id and b.organization_id=s.organization_id
      and b.workspace_id=s.workspace_id and b.owner_id=s.owner_id
    where q.session_id=${sessionId} and q.native_present
      and q.native_session_id||':'||q.call_id=${questionId}`;
  return row ?? null;
}

export class NativeQuestionError extends Error {
  readonly code = 'question_expired';
  constructor() {
    super('这道题已失效，请等待新的提问。');
  }
}

/** Admission only; DSH owns the question state. An old native card must never
 * become a normal prompt, including after platform rollback or in another Session. */
export async function requireNativeQuestionAdmission(
  tx: TransactionSql,
  sessionId: string,
  questionId: string,
) {
  // A reserved native identity must be verified, including a missing or
  // malformed binding. This prefix classifies; it never grants authority.
  if (!questionId.startsWith('dsh-')) return;
  await lockNativeQuestionMode(tx);
  const row = await readNativeQuestion(tx, sessionId, questionId);
  if (
    !row ||
    row.closed_at ||
    !['open', 'continued'].includes(row.state) ||
    (await readNativeQuestionMode(tx)) !== 'timed'
  )
    throw new NativeQuestionError();
}

/** The runtime lock serializes release and claims. DSH still owns adoption:
 * retain a proven reply awaiting projection and already-admitted FIFO duplicates
 * for their Job's idempotent receipt; never reclassify either as an ordinary prompt. */
export async function rerouteNativeQuestionSteers(
  tx: TransactionSql,
  sessionId: string,
) {
  if ((await readNativeQuestionMode(tx)) !== 'timed') return [];
  const rows = await tx<
    { id: string }[]
  >`update allrice_conversation_followups f
    set mode='follow_up' from allrice_conversation_commands c,
      allrice_messages m,allrice_native_questions q
    where f.session_id=${sessionId} and f.mode in ('steer_only','follow_up') and f.state='queued'
      and c.followup_run_id=f.run_id and c.input_kind='ask_user' and c.state in ('pending','claimed')
      and m.id=f.user_message_id and q.session_id=f.session_id and q.native_present
      and q.native_session_id=(select thread_id from allrice_conversation_runtimes where session_id=f.session_id)
      and q.native_session_id||':'||q.call_id=m.content->'interaction'->'answer'->>'questionId'
      and q.state in ('open','continued','settled')
      and q.closed_at is null returning c.id`;
  const ids = rows.map((row) => row.id);
  if (ids.length)
    await tx`update allrice_conversation_commands set state='pending',worker_id=null,claimed_at=null,
      expected_generation=null,expected_turn_id=null,error_code=null,next_attempt_at=now(),updated_at=now()
      where id=any(${ids}::uuid[])`;
  return ids;
}

/** Caller holds the mode fence plus tenant/owner and consumed-command authority. A native
 * proof alone cannot authorize: its answer must match DSH's settled batch. */
export async function nativeQuestionAnswerAdopted(
  tx: TransactionSql,
  sessionId: string,
  questionId: string,
  proofValue: unknown,
  answer: unknown,
  deferPending = false,
) {
  const proof = RuntimeNativeInputProofSchema.safeParse(proofValue);
  const row = await readNativeQuestion(tx, sessionId, questionId);
  if (
    !row ||
    row.closed_at ||
    (await readNativeQuestionMode(tx)) !== 'timed' ||
    !proof.success ||
    proof.data.status !== 'adopted' ||
    !['question_resolved', 'question_replied'].includes(
      proof.data.checkpoint,
    ) ||
    proof.data.callId !== row.call_id ||
    proof.data.messageId !== questionId
  )
    return false;
  const matched = matchUserQuestionAnswer(
    { questionId, questions: row.questions },
    answer,
  );
  if (!matched) return false;
  // Decide pending and adopted from this one projection read. A newer commit
  // between READ COMMITTED statements must not turn a valid proof into rejection.
  if (row.state !== 'settled' || proof.data.sequence > row.sequence) {
    if (deferPending) throw Error('QUESTION_ADOPTION_PENDING');
    return false;
  }
  return (
    runtimePolicyDigest(matched.answers) === runtimePolicyDigest(row.answers)
  );
}

/** Same predicate for both clock reads; legacy and unprojected program cards
 * retain their existing run ledger. A timed model card is never dual-written. */
export function answerableTaskQuestions(
  tx: TransactionSql,
  runId: string,
  native: boolean,
) {
  if (!native)
    return tx`exists(select 1 from allrice_task_questions q where q.run_id=${runId} and q.pending)`;
  return tx`(exists(select 1 from allrice_native_questions q
      join allrice_employee_runs e on e.session_id=q.session_id
      join allrice_conversation_runtimes cr on cr.session_id=q.session_id and cr.thread_id=q.native_session_id
      where e.run_id=${runId} and q.native_present and q.state in ('open','continued') and q.closed_at is null)
    or exists(select 1 from allrice_task_questions q where q.run_id=${runId} and q.pending))`;
}
