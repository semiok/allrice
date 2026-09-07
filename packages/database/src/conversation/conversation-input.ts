import {
  UuidSchema,
  RuntimeNativeInputProofSchema,
  type RuntimeNativeInputProof,
} from '@allrice/contracts';
import { z } from 'zod';
import type { TransactionSql } from 'postgres';

import { getDatabase } from '../core/client.ts';

const TurnIdSchema = z.string().trim().min(1).max(255);

export type ConversationDelivery = 'immediate' | 'follow_up' | 'steer_pending';

export function decideConversationDelivery(input: {
  runtimeState: string | null;
  activeTurnId: string | null;
  generation: number | null;
  requestedMode: 'auto' | 'steer' | 'follow_up';
  expectedTurnId?: string;
  expectedGeneration?: number;
  hasAttachments: boolean;
}): ConversationDelivery {
  if (input.runtimeState !== 'running') return 'immediate';
  if (input.requestedMode === 'follow_up' || input.hasAttachments) {
    return 'follow_up';
  }
  const exactTurn =
    input.activeTurnId !== null &&
    input.expectedTurnId === input.activeTurnId &&
    input.expectedGeneration === input.generation;
  return exactTurn ? 'steer_pending' : 'follow_up';
}

export async function getConversationRuntimeTarget(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
}) {
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    ownerId: UuidSchema.parse(input.ownerId),
  };
  const sql = getDatabase();
  const rows = await sql<
    {
      state: string;
      active_run_id: string | null;
      active_turn_id: string | null;
      thread_generation: number;
    }[]
  >`
    select state, active_run_id, active_turn_id, thread_generation
    from allrice_conversation_runtimes
    where organization_id = ${values.organizationId}
      and workspace_id = ${values.workspaceId}
      and session_id = ${values.sessionId}
      and owner_id = ${values.ownerId}
  `;
  const row = rows[0];
  return row
    ? {
        state: row.state,
        activeRunId: row.active_run_id,
        activeTurnId: row.active_turn_id,
        generation: row.thread_generation,
      }
    : null;
}

export interface ClaimedSteerCommand {
  id: string;
  followupRunId: string;
  clientUserMessageId: string;
  message: string;
  inputKind: 'steer_current' | 'ask_user' | null;
}

export async function claimConversationSteer(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  workerId: string;
  generation: number;
  turnId: string;
  drain?: boolean;
}): Promise<ClaimedSteerCommand | null> {
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    workerId: UuidSchema.parse(input.workerId),
    generation: z.number().int().nonnegative().parse(input.generation),
    turnId: TurnIdSchema.parse(input.turnId),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    // Serialize with turn release/replacement and fence by the live job lease.
    const live =
      await transaction`select cr.session_id,j.id as job_id from allrice_conversation_runtimes cr
      join allrice_jobs j on j.run_id=cr.active_run_id and j.worker_id=cr.worker_id
      where cr.organization_id=${values.organizationId} and cr.workspace_id=${values.workspaceId}
      and cr.session_id=${values.sessionId} and cr.worker_id=${values.workerId} and cr.state='running'
      and cr.thread_generation=${values.generation} and cr.active_turn_id=${values.turnId}
      and j.status in ('claimed','running') and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null
      for update of cr`;
    if (!live.length) return null;
    // Lock acquisition may have waited past the lease deadline. Re-read after it.
    const lease =
      await transaction`select id from allrice_jobs where id=${live[0]!.job_id}
      and worker_id=${values.workerId} and status in ('claimed','running')
      and lease_expires_at>clock_timestamp() and cancel_requested_at is null`;
    if (!lease.length) return null;
    const rows = await transaction<
      {
        id: string;
        followup_run_id: string;
        client_user_message_id: string;
        message: string;
        input_kind: 'steer_current' | 'ask_user' | null;
      }[]
    >`
      select id, followup_run_id, client_user_message_id, message, input_kind
      from allrice_conversation_commands
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and expected_generation = ${values.generation}
        and expected_turn_id = ${values.turnId}
        and (${input.drain === true} or next_attempt_at <= now())
        and (state = 'pending' or (state = 'claimed' and claimed_at < now() - interval '30 seconds'))
      order by created_at, id
      for update skip locked
      limit 1
    `;
    const command = rows[0];
    if (!command) return null;
    await transaction`
      update allrice_conversation_commands
      set state = 'claimed', worker_id = ${values.workerId},
          claimed_at = now(), updated_at = now(), error_code = null,
          delivery_attempts=delivery_attempts+1
      where id = ${command.id}
    `;
    return {
      id: command.id,
      followupRunId: command.followup_run_id,
      clientUserMessageId: command.client_user_message_id,
      message: command.message,
      inputKind: command.input_kind,
    };
  });
}

export async function consumeConversationSteer(input: {
  commandId: string;
  workerId: string;
  proof?: RuntimeNativeInputProof;
}) {
  const values = {
    commandId: UuidSchema.parse(input.commandId),
    workerId: UuidSchema.parse(input.workerId),
  };
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const live =
      await transaction`select cr.session_id,j.id as job_id from allrice_conversation_runtimes cr
      join allrice_conversation_commands c on c.session_id=cr.session_id
      join allrice_jobs j on j.run_id=cr.active_run_id and j.worker_id=cr.worker_id
      where c.id=${values.commandId} and cr.worker_id=${values.workerId} and cr.state='running'
      and cr.thread_generation=c.expected_generation and cr.active_turn_id=c.expected_turn_id
      and j.status in ('claimed','running') and j.lease_expires_at>clock_timestamp()
      for update of cr`;
    if (!live.length) return;
    const lease =
      await transaction`select id from allrice_jobs where id=${live[0]!.job_id}
      and worker_id=${values.workerId} and status in ('claimed','running') and lease_expires_at>clock_timestamp()`;
    if (!lease.length) return;
    const commands = await transaction<
      {
        followup_run_id: string;
        assistant_message_id: string;
        message: string;
        input_kind: string | null;
        client_user_message_id: string;
        expected_turn_id: string;
      }[]
    >`
      select c.followup_run_id, f.assistant_message_id, c.message, c.input_kind, c.client_user_message_id,c.expected_turn_id
      from allrice_conversation_commands c
      join allrice_conversation_followups f on f.run_id = c.followup_run_id
      where c.id = ${values.commandId} and c.state = 'claimed'
        and c.worker_id = ${values.workerId}
      for update of c, f
    `;
    const command = commands[0];
    if (!command) return;
    if (command.input_kind) {
      const proof = RuntimeNativeInputProofSchema.parse(input.proof);
      if (
        proof.status !== 'adopted' ||
        proof.inputId !== command.client_user_message_id ||
        proof.turnId !== command.expected_turn_id
      )
        throw new Error('INPUT_ADOPTION_PROOF_REQUIRED');
    }
    await transaction`
      update allrice_conversation_commands
      set state = 'consumed', consumed_at = now(), updated_at = now(),
          native_proof=${input.proof ? transaction.json(input.proof) : null}
      where id = ${values.commandId}
    `;
    await transaction`
      update allrice_conversation_followups
      set state = 'consumed', consumed_at = now()
      where run_id = ${command.followup_run_id}
    `;
    await transaction`
      update allrice_jobs
      set status = 'canceled', cancel_requested_at = now(),
          cancel_reason = 'consumed_by_active_turn', completed_at = now(), updated_at = now()
      where run_id = ${command.followup_run_id} and status = 'queued'
    `;
    await transaction`
      update allrice_runs
      set state = 'canceled', error_code = 'STEER_CONSUMED',
          error_message = 'Input was consumed by the active turn',
          completed_at = now(), updated_at = now()
      where id = ${command.followup_run_id} and state = 'queued'
    `;
    await transaction`
      update allrice_employee_runs
      set status = 'canceled', error_code = 'STEER_CONSUMED',
          error_message = 'Input was consumed by the active turn',
          completed_at = now()
      where run_id = ${command.followup_run_id} and status = 'queued'
    `;
    await transaction`
      insert into allrice_run_events (
        organization_id, workspace_id, run_id, sequence, event_type, payload
      )
      select organization_id, workspace_id, id,
        coalesce((select max(sequence) + 1 from allrice_run_events where run_id = r.id), 0),
        'run.canceled',
        ${transaction.json({ reason: 'consumed_by_active_turn' })}
      from allrice_runs r
      where r.id = ${command.followup_run_id}
        and not exists (
          select 1 from allrice_run_events e
          where e.run_id = r.id and e.event_type = 'run.canceled'
        )
    `;
    await transaction`
      update allrice_messages
      set content = ${transaction.json({
        text: command.message.startsWith('allrice:user-question:v1:')
          ? ''
          : '已补充给正在工作的 Rice。',
        citations: [],
      })}, status = 'completed', completed_at = now(), error_code = null
      where id = ${command.assistant_message_id} and status = 'pending'
    `;
  });
}

export async function rejectConversationSteer(input: {
  commandId: string;
  workerId: string;
  errorCode: string;
}) {
  const sql = getDatabase();
  await sql`
    update allrice_conversation_commands
    set state = 'rejected', error_code = ${input.errorCode}, updated_at = now()
    where id = ${UuidSchema.parse(input.commandId)}
      and worker_id = ${UuidSchema.parse(input.workerId)}
      and state = 'claimed'
  `;
}

/** Release only this claim. The same id is retried against DSH's own journal;
 * a transport timeout never causes replay as a later ordinary user turn. */
export async function deferConversationSteer(input: {
  commandId: string;
  workerId: string;
  proof?: RuntimeNativeInputProof;
}) {
  const db = getDatabase();
  if (input.proof) RuntimeNativeInputProofSchema.parse(input.proof);
  await db`update allrice_conversation_commands set state='pending',worker_id=null,claimed_at=null,
    native_proof=${input.proof ? db.json(input.proof) : null},next_attempt_at=now()+interval '500 milliseconds',updated_at=now()
    where id=${UuidSchema.parse(input.commandId)} and worker_id=${UuidSchema.parse(input.workerId)} and state='claimed'`;
}

/** Call while holding the runtime lock. Strict inputs cannot fall through to a new Run. */
export async function cancelUnadoptedSteers(
  tx: TransactionSql,
  sessionId: string,
) {
  const rows = await tx<
    {
      run_id: string;
      assistant_message_id: string;
      error_code: string | null;
    }[]
  >`
    select f.run_id,f.assistant_message_id,c.error_code from allrice_conversation_followups f
    join allrice_conversation_commands c on c.followup_run_id=f.run_id
    where f.session_id=${sessionId} and f.mode='steer_only' and f.state='queued' and c.state='rejected'
    for update of f`;
  for (const row of rows) {
    await tx`update allrice_conversation_followups set state='canceled' where run_id=${row.run_id}`;
    await tx`update allrice_jobs set status='canceled',cancel_requested_at=now(),cancel_reason='input_not_adopted',
      completed_at=now(),updated_at=now() where run_id=${row.run_id} and status='queued'`;
    await tx`update allrice_runs set state='canceled',error_code='INPUT_NOT_ADOPTED',completed_at=now(),updated_at=now()
      where id=${row.run_id} and state='queued'`;
    await tx`update allrice_employee_runs set status='canceled',error_code='INPUT_NOT_ADOPTED',completed_at=now()
      where run_id=${row.run_id} and status='queued'`;
    await tx`update allrice_messages set status='failed',error_code='INPUT_NOT_ADOPTED',completed_at=now(),
      content=${tx.json({ text: '本次输入未确认在原回合生效，不会自动作为下一轮任务执行。', citations: [] })}
      where id=${row.assistant_message_id} and status='pending'`;
    await tx`insert into allrice_run_events (organization_id,workspace_id,run_id,sequence,event_type,payload)
      select organization_id,workspace_id,id,
        coalesce((select max(sequence)+1 from allrice_run_events where run_id=r.id),0),'run.canceled',
        ${tx.json({ reason: 'input_not_adopted' })} from allrice_runs r where id=${row.run_id}
        and not exists(select 1 from allrice_run_events where run_id=r.id and event_type='run.canceled')`;
  }
}
