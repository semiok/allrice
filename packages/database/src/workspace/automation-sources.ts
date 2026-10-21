import type { ChatMessageSource, RequestContext } from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { employeeChatUuid } from '../employees/employee-chat-authority.ts';

/** Read actual dispatch bindings, including legacy schedules. Presentation
 * never changes saved messages or infers authority from their text. The caller
 * has already authorized this exact conversation and its owner. */
export async function readScheduleMessageSources(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  ownerId: string,
  sql: ReturnType<typeof getDatabase>,
): Promise<Map<string, ChatMessageSource>> {
  const [schema] =
    await sql`select to_regclass(format('%I.allrice_automation_runs',current_schema())) is not null available`;
  if (!schema?.available) return new Map();
  const rows = await sql<
    {
      user_message_id: string;
      task_id: string;
      scheduled_at: Date;
      occurrence_id: string;
    }[]
  >`
    select er.user_message_id,a.id task_id,ar.scheduled_for scheduled_at,
      coalesce(to_jsonb(ar)->>'native_recurring_occurrence_id',
        to_jsonb(ar)->>'native_once_occurrence_id',ar.id::text) occurrence_id
    from allrice_automation_runs ar
    join allrice_automations a on a.id=ar.automation_id
      and a.organization_id=ar.organization_id and a.workspace_id=ar.workspace_id
      and a.owner_id=${ownerId} and a.trigger_type='schedule'
    join allrice_employee_runs er on er.run_id=ar.run_id
      and er.organization_id=ar.organization_id and er.workspace_id=ar.workspace_id
      and er.owner_id=a.owner_id and er.session_id=ar.session_id
    join allrice_messages m on m.id=er.user_message_id
      and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id
      and m.owner_id=er.owner_id and m.session_id=er.session_id and m.role='user'
    where ar.organization_id=${context.organizationId}
      and ar.workspace_id=${workspaceId} and ar.session_id=${sessionId}
    order by ar.created_at,ar.id
  `;
  return new Map(
    rows.map((row) => [
      row.user_message_id,
      {
        kind: 'schedule',
        taskId: row.task_id,
        scheduledAt: row.scheduled_at.toISOString(),
        occurrenceId: row.occurrence_id,
      },
    ]),
  );
}

/** Recover creation cards from the existing call identity and the actual plan.
 * Never treat an assistant promise or a schedule-looking sentence as a task. */
export async function readCreatedAutomationIds(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  ownerId: string,
  sql: ReturnType<typeof getDatabase>,
): Promise<Map<string, string[]>> {
  const [schema] =
    await sql`select to_regclass(format('%I.allrice_task_calls',current_schema())) is not null available`;
  if (!schema?.available) return new Map();
  const calls = await sql<{ run_id: string; call_id: string }[]>`
    select distinct c.run_id,c.call_id from allrice_task_calls c
    join allrice_employee_runs er on er.run_id=c.run_id
      and er.organization_id=${context.organizationId} and er.workspace_id=${workspaceId}
      and er.owner_id=${ownerId} and er.session_id=${sessionId}
    where c.kind='tool'`;
  if (!calls.length) return new Map();
  const requests = new Map<string, string>();
  for (const call of calls)
    for (const lane of ['native-once-call', 'native-recurring-call'])
      requests.set(
        employeeChatUuid(
          lane,
          context.organizationId,
          workspaceId,
          call.run_id,
          call.call_id,
        ),
        call.run_id,
      );
  const ids = [...requests.keys()];
  const plans = await sql<{ id: string; request_id: string }[]>`
    select id,coalesce(to_jsonb(a)->>'native_recurring_request_id',to_jsonb(a)->>'native_once_request_id') request_id
    from allrice_automations a where organization_id=${context.organizationId} and workspace_id=${workspaceId}
      and owner_id=${ownerId} and session_id=${sessionId} and trigger_type='schedule'
      and (to_jsonb(a)->>'native_recurring_request_id'=any(${ids}::text[]) or to_jsonb(a)->>'native_once_request_id'=any(${ids}::text[]))
    order by created_at,id`;
  const result = new Map<string, string[]>();
  for (const plan of plans) {
    const runId = requests.get(plan.request_id);
    if (runId) result.set(runId, [...(result.get(runId) ?? []), plan.id]);
  }
  return result;
}
