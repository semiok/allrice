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
  if (!row) return null;
  // An answer authorizes one enrollment. Any task of this session created
  // after it, other than this call's own replay, consumed it; deleted rows
  // count too, so a new call cannot silently recreate the confirmed task.
  const own = ['native-once-call', 'native-recurring-call'].map((kind) =>
    employeeChatUuid(
      kind,
      ctx.organizationId,
      ctx.workspaceId!,
      ctx.runId,
      input.callId,
    ),
  );
  const enrolled = await tx<{ rule: unknown; conversation_mode: string }[]>`
    select schedule->'rule' rule,conversation_mode from allrice_automations
    where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!}
      and owner_id=${ctx.policySnapshot.subjectId} and session_id=${input.sessionId}
      and created_at>=${row.answered_at}
      and coalesce(native_once_request_id,native_recurring_request_id)<>all(${own}::uuid[])`;
  return {
    // A selected frequency is consumed by any enrollment after it; a card
    // confirmation only by one with its exact rule and mode.
    intent: enrolled.length
      ? null
      : clarifiedScheduleIntent(request, row.question, row.answer),
    answers: selectedScheduleAnswers(row.question, row.answer),
    enrolled: enrolled.map((task) => ({
      rule: task.rule,
      conversationMode: task.conversation_mode,
    })),
  };
}
