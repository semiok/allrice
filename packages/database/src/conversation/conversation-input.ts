import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';

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
}

export async function claimConversationSteer(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  workerId: string;
  generation: number;
  turnId: string;
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
    const rows = await transaction<
      {
        id: string;
        followup_run_id: string;
        client_user_message_id: string;
        message: string;
      }[]
    >`
      select id, followup_run_id, client_user_message_id, message
      from allrice_conversation_commands
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and expected_generation = ${values.generation}
        and expected_turn_id = ${values.turnId}
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
          claimed_at = now(), updated_at = now(), error_code = null
      where id = ${command.id}
    `;
    return {
      id: command.id,
      followupRunId: command.followup_run_id,
      clientUserMessageId: command.client_user_message_id,
      message: command.message,
    };
  });
}

export async function consumeConversationSteer(input: {
  commandId: string;
  workerId: string;
}) {
  const values = {
    commandId: UuidSchema.parse(input.commandId),
    workerId: UuidSchema.parse(input.workerId),
  };
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const commands = await transaction<
      {
        followup_run_id: string;
        assistant_message_id: string;
        message: string;
      }[]
    >`
      select c.followup_run_id, f.assistant_message_id, c.message
      from allrice_conversation_commands c
      join allrice_conversation_followups f on f.run_id = c.followup_run_id
      where c.id = ${values.commandId} and c.state = 'claimed'
        and c.worker_id = ${values.workerId}
      for update of c, f
    `;
    const command = commands[0];
    if (!command) return;
    await transaction`
      update allrice_conversation_commands
      set state = 'consumed', consumed_at = now(), updated_at = now()
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
