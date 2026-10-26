import type { TransactionSql } from 'postgres';
import {
  clarifiedScheduleIntent,
  selectedScheduleAnswers,
} from './schedule-clarification.ts';
import {
  employeeChatUuid,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';

/** Caller already holds live employee/job/human-source authority. Resolve only
 * the latest question in THIS Run, with a tenant-owned typed answer and native
 * adoption proof. An option shown by the model is never itself permission. */
export async function readScheduleClarification(
  tx: TransactionSql,
  input: EmployeeChatCall,
  request: string,
) {
  const ctx = input.context;
  // Parallel calls of one Run read and consume its answers one at a time.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`schedule-answer:${ctx.runId}`},0))`;
  const [row] = await tx<
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
      and e.sequence=(select max(q.sequence) from allrice_run_events q
        where q.run_id=e.run_id and q.payload->>'sourceEventType'='session/user-question')
    order by c.created_at desc,c.id desc limit 1`;
  if (!row) {
    // A question still open (or skipped) in this Run is not "never asked":
    // an earlier decline or consumed answer must not fall back to wording.
    const [asked] = await tx`select 1 from allrice_run_events
      where run_id=${ctx.runId} and payload->>'sourceEventType'='session/user-question' limit 1`;
    return asked
      ? { intent: null, answers: [], confirmedRequests: [] as string[] }
      : null;
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
    // A selected frequency is consumed by another call of this Run.
    intent: enrolled.some((task) => others.has(task.request_id))
      ? null
      : clarifiedScheduleIntent(request, row.question, row.answer),
    answers: selectedScheduleAnswers(row.question, row.answer),
    // A card confirmation is consumed by the task it enrolled, whose
    // immutable first version (fixed rules in configuration, monthly in
    // business_content) stores exactly the confirmed request.
    confirmedRequests: enrolled.map((task) => task.first_prompt),
  };
}
