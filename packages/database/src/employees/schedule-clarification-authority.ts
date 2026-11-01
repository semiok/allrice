import { nativeQuestionAnswerAdopted } from '../native-questions.ts';
import type { TransactionSql } from 'postgres';
import { EmployeeExecutionSnapshotSchema } from '@allrice/contracts';
import {
  clarifiedScheduleIntent,
  selectedScheduleAnswers,
} from './schedule-clarification.ts';
import {
  assertEmployeeChatHumanSource,
  employeeChatUuid,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';

/** Caller holds live consumer authority. Legacy questions stay Run-bound;
 * native answers retain their first human request across consumer Runs. */
export async function readScheduleClarification(
  tx: TransactionSql,
  input: EmployeeChatCall,
  request: string,
) {
  const ctx = input.context;
  const unconfirmed = {
    request,
    intent: null,
    answers: [],
    confirmedRequests: [] as string[],
  };
  // Parallel calls of one Session read and consume its answers one at a time.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`schedule-answer:${input.sessionId}`},0))`;
  const [legacy] = await tx<
    { question: unknown; answer: unknown; answered_at: Date }[]
  >`
    select e.payload->'nativePayload' question,m.content->'interaction'->'answer' answer,
      m.created_at answered_at
    from allrice_run_events e
    join allrice_conversation_commands c on c.organization_id=e.organization_id
      and c.workspace_id=e.workspace_id and c.session_id=${input.sessionId}
      and c.owner_id=${ctx.policySnapshot.subjectId} and c.input_kind='ask_user'
      and c.state='consumed' and c.expected_turn_id=e.payload->>'turnId'
      and c.expected_generation=(e.payload->>'generation')::int
      and c.native_proof->>'status'='adopted'
      and c.native_proof->>'checkpoint'='question_resolved'
      and c.native_proof->>'inputId'=c.client_user_message_id::text
      and c.native_proof->>'turnId'=c.expected_turn_id
      and c.native_proof->>'messageId'=e.payload->'nativePayload'->>'questionId'
    join allrice_conversation_followups f on f.run_id=c.followup_run_id
      and f.organization_id=c.organization_id and f.workspace_id=c.workspace_id
      and f.session_id=c.session_id and f.owner_id=c.owner_id
    join allrice_messages m on m.id=f.user_message_id and m.organization_id=c.organization_id
      and m.workspace_id=c.workspace_id and m.session_id=c.session_id and m.owner_id=c.owner_id
      and m.role='user' and m.status='completed'
      and m.client_message_id=c.client_user_message_id
      and m.content->'interaction'->>'type'='user_question_answer'
    where e.organization_id=${ctx.organizationId} and e.workspace_id=${ctx.workspaceId!}
      and e.run_id=${ctx.runId} and e.payload->>'sourceEventType'='session/user-question'
      and not (e.payload->'nativePayload'->>'questionId' like 'dsh-%')
      and e.sequence=(select max(q.sequence) from allrice_run_events q
        where q.run_id=e.run_id and q.payload->>'sourceEventType'='session/user-question')
    order by c.created_at desc,c.id desc limit 1`;
  // A continued answer may be adopted in a later native turn. Its typed
  // command must belong to this Run (or its live turn), not the original turn.
  // The public DSH settled view supplies the answers; receipt rows only gate it.
  const [native] = await tx<
    {
      question: unknown;
      answer: unknown;
      answered_at: Date;
      question_id: string;
      native_proof: unknown;
      client_user_message_id: string;
      source_run_id: string;
    }[]
  >`select jsonb_build_object('questionId',m.content->'interaction'->'answer'->>'questionId',
      'questions',q.questions) question,
      m.content->'interaction'->'answer' answer,m.created_at answered_at,
      m.content->'interaction'->'answer'->>'questionId' question_id,c.native_proof,c.client_user_message_id,q.source_run_id
    from allrice_conversation_commands c
    join allrice_conversation_followups f on f.run_id=c.followup_run_id
      and f.organization_id=c.organization_id and f.workspace_id=c.workspace_id
      and f.session_id=c.session_id and f.owner_id=c.owner_id
    join allrice_messages m on m.id=f.user_message_id and m.organization_id=c.organization_id
      and m.workspace_id=c.workspace_id and m.session_id=c.session_id and m.owner_id=c.owner_id
      and m.role='user' and m.status='completed' and m.client_message_id=c.client_user_message_id
      and m.content->'interaction'->>'type'='user_question_answer'
    left join allrice_native_questions q on q.session_id=c.session_id
      and q.native_session_id||':'||q.call_id=m.content->'interaction'->'answer'->>'questionId'
    where c.organization_id=${ctx.organizationId} and c.workspace_id=${ctx.workspaceId!}
      and c.session_id=${input.sessionId} and c.owner_id=${ctx.policySnapshot.subjectId}
      and c.input_kind='ask_user' and c.state='consumed'
      and m.content->'interaction'->'answer'->>'questionId' like 'dsh-%'
      and (q.source_run_id=${ctx.runId} or c.followup_run_id=${ctx.runId}
        or exists(select 1 from allrice_conversation_runtimes r where r.session_id=c.session_id
          and r.active_run_id=${ctx.runId} and r.active_turn_id=c.native_proof->>'turnId'))
    order by c.created_at desc,c.id desc limit 1`;
  if (
    native &&
    ((native.native_proof as { inputId?: string } | null)?.inputId !==
      native.client_user_message_id ||
      !(await nativeQuestionAnswerAdopted(
        tx,
        input.sessionId,
        native.question_id,
        native.native_proof,
        native.answer,
      )))
  )
    return unconfirmed;
  if (native) {
    const [source] = await tx<
      {
        id: string;
        text: string;
        execution_snapshot: unknown;
      }[]
    >`select m.id,m.content->>'text' text,e.execution_snapshot
      from allrice_employee_runs e
      join allrice_messages m on m.id=e.user_message_id and m.session_id=e.session_id
        and m.organization_id=e.organization_id and m.workspace_id=e.workspace_id and m.owner_id=e.owner_id
        and m.role='user' and m.status='completed'
      join allrice_employee_runs consumer on consumer.run_id=${ctx.runId}
        and consumer.employee_assignment_id=e.employee_assignment_id
        and consumer.execution_snapshot#>>'{instance,id}'=e.execution_snapshot#>>'{instance,id}'
      where e.run_id=${native.source_run_id} and e.session_id=${input.sessionId}
        and e.organization_id=${ctx.organizationId} and e.workspace_id=${ctx.workspaceId!}
        and e.owner_id=${ctx.policySnapshot.subjectId} for share of e,m nowait`;
    if (!source) return unconfirmed;
    const snapshot = EmployeeExecutionSnapshotSchema.parse(
      source.execution_snapshot,
    );
    if (snapshot.schemaVersion !== 2) return unconfirmed;
    // The original Run may be finished. Recheck its existing human-source
    // exclusions without requiring its old lease or turn to remain live.
    await assertEmployeeChatHumanSource(
      tx,
      {
        ...input,
        userMessageId: source.id,
        context: { ...ctx, runId: native.source_run_id },
      },
      { text: source.text, snapshot },
    );
    request = source.text;
  }
  const row = native ?? legacy;
  if (!row) {
    // A question still open (or skipped) in this Run is not "never asked":
    // an earlier decline or consumed answer must not fall back to wording.
    const [asked] = await tx`select 1 from allrice_run_events
      where run_id=${ctx.runId} and payload->>'sourceEventType'='session/user-question' limit 1`;
    return asked ? unconfirmed : null;
  }
  // An answer authorizes one enrollment; deleted rows count too, so a new
  // call cannot silently recreate the confirmed task. Tasks enrolled before
  // the answer did not consume it.
  const id = (kind: string, callId: string) =>
    employeeChatUuid(
      kind,
      ctx.organizationId,
      ctx.workspaceId!,
      ctx.runId,
      callId,
    );
  const kinds = ['native-once-call', 'native-recurring-call'];
  const calls = await tx<{ call_id: string }[]>`
    select call_id from allrice_task_calls where run_id=${ctx.runId}
      and kind='tool' and call_id<>${input.callId}`;
  const others = new Set(
    calls.flatMap((c) => kinds.map((kind) => id(kind, c.call_id))),
  );
  const enrolled = await tx<{ request_id: string; first_prompt: string }[]>`
    select coalesce(a.native_once_request_id,a.native_recurring_request_id) request_id,
      coalesce(v.configuration->>'prompt',v.business_content->>'prompt',a.prompt) first_prompt
    from allrice_automations a
    left join allrice_native_recurring_versions v on v.automation_id=a.id and v.revision=1
    where a.organization_id=${ctx.organizationId} and a.workspace_id=${ctx.workspaceId!}
      and a.owner_id=${ctx.policySnapshot.subjectId} and a.session_id=${input.sessionId}
      and a.created_at>=${row.answered_at}
      and coalesce(a.native_once_request_id,a.native_recurring_request_id)
        <>all(${kinds.map((kind) => id(kind, input.callId))}::uuid[])`;
  return {
    request,
    // A selected frequency is consumed by another call of this Run.
    intent: enrolled.some((task) => !!native || others.has(task.request_id))
      ? null
      : clarifiedScheduleIntent(request, row.question, row.answer),
    answers: selectedScheduleAnswers(row.question, row.answer),
    // A card confirmation is consumed by the task it enrolled, whose
    // immutable first version (fixed rules in configuration, monthly in
    // business_content) stores exactly the confirmed request.
    confirmedRequests: enrolled.map((task) => task.first_prompt),
  };
}
