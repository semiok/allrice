import {
  QueuedMessageActionSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import {
  ArtifactReviewError,
  assertWorkbenchSession,
} from '../artifact-review.ts';
import { refreshTaskClock } from '../task-clock.ts';
import { getDatabase } from '../core/client.ts';

/** Caller holds the conversation runtime lock. Never create a second scheduler. */
export async function releaseNextConversationFollowup(
  tx: TransactionSql,
  sessionId: string,
) {
  const [next] = await tx<{ run_id: string }[]>`
    select f.run_id from allrice_conversation_followups f
    join allrice_jobs j on j.run_id=f.run_id
    where f.session_id=${sessionId} and f.state='queued' and f.mode<>'steer_only'
      and j.status='queued' and j.cancel_requested_at is null
    order by f.created_at,f.run_id for update of f,j skip locked limit 1`;
  if (!next) return;
  await tx`update allrice_conversation_followups set state='released',released_at=now() where run_id=${next.run_id}`;
  await tx`update allrice_jobs set available_at=now(),timeout_at=now()+interval '5 minutes',updated_at=now() where run_id=${next.run_id}`;
}

/** Mutates the existing durable input. No second send, copied Run or local-only removal. */
export async function updateQueuedMessage(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
  messageId: string,
  input: unknown,
) {
  UuidSchema.parse(workspaceId);
  UuidSchema.parse(messageId);
  const action = QueuedMessageActionSchema.parse(input);
  const sql = getDatabase();
  await sql.begin(async (tx) => {
    await assertWorkbenchSession(
      tx,
      { ...context, workspaceId },
      sessionId,
      true,
    );
    // Same runtime → followup → job ordering as turn release; the job lock also
    // fences a concurrent worker claim. A started task cannot be edited away.
    const [runtime] = await tx<
      {
        state: string;
        active_run_id: string | null;
        active_turn_id: string | null;
        thread_generation: number;
        worker_id: string | null;
      }[]
    >`
      select state,active_run_id,active_turn_id,thread_generation,worker_id
      from allrice_conversation_runtimes where session_id=${sessionId} for update`;
    const [row] = await tx<
      {
        run_id: string;
        state: string;
        mode: string;
        assistant_message_id: string;
        client_user_message_id: string;
        text: string;
        kind: string;
        status: string;
        cancel_requested_at: Date | null;
        error_code: string | null;
        has_attachments: boolean;
      }[]
    >`
      select f.run_id,f.state,f.mode,f.assistant_message_id,f.client_user_message_id,
        m.content->>'text' as text,i.kind,j.status,j.cancel_requested_at,r.error_code,
        exists(select 1 from allrice_message_attachments a where a.message_id=m.id) as has_attachments
      from allrice_conversation_followups f
      join allrice_messages m on m.id=f.user_message_id
      join allrice_chat_input_requests i on i.user_message_id=m.id
      join allrice_jobs j on j.run_id=f.run_id
      join allrice_runs r on r.id=f.run_id
      where f.session_id=${sessionId} and f.user_message_id=${messageId}
        and f.organization_id=${context.organizationId} and f.workspace_id=${workspaceId}
      for update of f,j`;
    if (!row) throw new ArtifactReviewError('queued_message_not_found');
    const removalCode =
      action.action === 'edit'
        ? 'QUEUED_MESSAGE_EDITED'
        : 'QUEUED_MESSAGE_REMOVED';
    if (action.action !== 'steer' && row.error_code === removalCode) return;
    if (action.action === 'steer' && row.mode === 'steer_only') {
      const [prior] =
        await tx`select id from allrice_conversation_commands where followup_run_id=${row.run_id}
        and expected_turn_id=${action.expectedTurnId} and expected_generation=${action.expectedGeneration}`;
      if (prior) return; // A retry acknowledges the same receipt, never re-dispatches.
    }
    if (
      row.mode !== 'follow_up' ||
      !['queued', 'released'].includes(row.state) ||
      row.status !== 'queued' ||
      row.cancel_requested_at ||
      !['message', 'queue_next'].includes(row.kind)
    )
      throw new ArtifactReviewError('queued_message_started');
    if (action.action === 'steer') {
      if (row.has_attachments)
        throw new ArtifactReviewError('queued_attachments_require_turn');
      if (
        runtime?.state !== 'running' ||
        !runtime.active_run_id ||
        runtime.active_turn_id !== action.expectedTurnId ||
        runtime.thread_generation !== action.expectedGeneration
      )
        throw new ArtifactReviewError('input_turn_changed');
      const [live] =
        await tx`select id from allrice_jobs where run_id=${runtime.active_run_id}
        and worker_id=${runtime.worker_id} and status in ('claimed','running')
        and lease_expires_at>clock_timestamp() and cancel_requested_at is null`;
      if (!live) throw new ArtifactReviewError('input_turn_changed');
      await tx`update allrice_conversation_followups set mode='steer_only',state='queued',released_at=null where run_id=${row.run_id}`;
      await tx`insert into allrice_conversation_commands(organization_id,workspace_id,session_id,owner_id,followup_run_id,command_type,client_user_message_id,expected_generation,expected_turn_id,message,input_kind)
        values(${context.organizationId},${workspaceId},${sessionId},${context.actor.id},${row.run_id},'steer',${row.client_user_message_id},${action.expectedGeneration},${action.expectedTurnId},${row.text},'steer_current')`;
      await tx`update allrice_chat_input_requests set kind='steer_current' where user_message_id=${messageId}`;
      // Worker uses the existing DSH receipt/adoption path. Accepted != adopted.
      return;
    }
    await tx`update allrice_conversation_followups set state='canceled',consumed_at=now() where run_id=${row.run_id}`;
    await tx`update allrice_jobs set status='canceled',cancel_requested_at=now(),cancel_reason=${removalCode},completed_at=now(),updated_at=now() where run_id=${row.run_id}`;
    await tx`update allrice_runs set state='canceled',error_code=${removalCode},completed_at=now(),updated_at=now() where id=${row.run_id}`;
    await refreshTaskClock(tx, row.run_id);
    await tx`update allrice_employee_runs set status='canceled',error_code=${removalCode},completed_at=now() where run_id=${row.run_id}`;
    await tx`update allrice_messages set status='failed',error_code=${removalCode},completed_at=now() where id=${row.assistant_message_id}`;
    await tx`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      select organization_id,workspace_id,id,coalesce((select max(sequence)+1 from allrice_run_events where run_id=r.id),0),'run.canceled',${tx.json({ reason: removalCode })}
      from allrice_runs r where id=${row.run_id}`;
    // Removing the released head must wake the next item even if no turn is
    // left to emit another completion. Serialized with runtime release above.
    if (row.state === 'released' && runtime?.state !== 'running')
      await releaseNextConversationFollowup(tx, sessionId);
  });
}
