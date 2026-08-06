import { UuidSchema } from '@allrice/contracts';
import type postgres from 'postgres';
import { z } from 'zod';

import { getDatabase } from './index.ts';

const ChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ThreadIdSchema = z.string().trim().min(1).max(255);
const TurnIdSchema = z.string().trim().min(1).max(255);

type ConversationRuntimeState = 'idle' | 'running' | 'interrupted' | 'error';

interface ConversationRuntimeRow {
  organization_id: string;
  workspace_id: string;
  session_id: string;
  owner_id: string;
  thread_id: string | null;
  thread_generation: number;
  config_checksum: string;
  state: ConversationRuntimeState;
  active_run_id: string | null;
  active_turn_id: string | null;
  worker_id: string | null;
  last_error_code: string | null;
}

export class ConversationRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'conversation_busy'
      | 'conversation_ownership_lost'
      | 'conversation_not_found',
  ) {
    super(code);
  }
}

export function conversationRuntimeCanAcquire(input: {
  state: ConversationRuntimeState;
  activeRunId: string | null;
  requestedRunId: string;
  activeRunTerminal: boolean;
}) {
  return (
    input.state !== 'running' ||
    input.activeRunId === input.requestedRunId ||
    input.activeRunTerminal
  );
}

function mapBinding(row: ConversationRuntimeRow) {
  return {
    sessionId: row.session_id,
    threadId: row.thread_id,
    generation: row.thread_generation,
    configChecksum: row.config_checksum,
    state: row.state,
    activeRunId: row.active_run_id,
    activeTurnId: row.active_turn_id,
    workerId: row.worker_id,
    lastErrorCode: row.last_error_code,
  };
}

export async function acquireConversationRuntime(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  runId: string;
  workerId: string;
  configChecksum: string;
}) {
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    ownerId: UuidSchema.parse(input.ownerId),
    runId: UuidSchema.parse(input.runId),
    workerId: UuidSchema.parse(input.workerId),
    configChecksum: ChecksumSchema.parse(input.configChecksum),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`
      insert into allrice_conversation_runtimes (
        organization_id, workspace_id, session_id, owner_id, config_checksum
      ) values (
        ${values.organizationId}, ${values.workspaceId}, ${values.sessionId},
        ${values.ownerId}, ${values.configChecksum}
      ) on conflict (session_id) do nothing
    `;
    const rows = await transaction<ConversationRuntimeRow[]>`
      select * from allrice_conversation_runtimes
      where organization_id = ${values.organizationId}
        and workspace_id = ${values.workspaceId}
        and session_id = ${values.sessionId}
        and owner_id = ${values.ownerId}
      for update
    `;
    const current = rows[0];
    if (!current) throw new ConversationRuntimeError('conversation_not_found');
    const activeRuns = current.active_run_id
      ? await transaction<{ state: string }[]>`
          select state from allrice_runs
          where id = ${current.active_run_id}
            and organization_id = ${values.organizationId}
            and workspace_id = ${values.workspaceId}
        `
      : [];
    const activeRunTerminal =
      !activeRuns[0] ||
      ['succeeded', 'failed', 'canceled'].includes(activeRuns[0].state);
    if (
      !conversationRuntimeCanAcquire({
        state: current.state,
        activeRunId: current.active_run_id,
        requestedRunId: values.runId,
        activeRunTerminal,
      })
    ) {
      throw new ConversationRuntimeError('conversation_busy');
    }
    const configChanged = current.config_checksum !== values.configChecksum;
    const updated = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set state = 'running', active_run_id = ${values.runId},
          active_turn_id = null, worker_id = ${values.workerId},
          config_checksum = ${values.configChecksum},
          thread_id = ${configChanged ? null : current.thread_id},
          last_error_code = null, last_started_at = now(), updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(updated[0]!);
  });
}

async function lockedOwnedRuntime(
  transaction: postgres.TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    workerId: string;
  },
) {
  const rows = await transaction<ConversationRuntimeRow[]>`
    select * from allrice_conversation_runtimes
    where organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and session_id = ${input.sessionId}
    for update
  `;
  const row = rows[0];
  if (
    !row ||
    row.state !== 'running' ||
    row.active_run_id !== input.runId ||
    row.worker_id !== input.workerId
  ) {
    throw new ConversationRuntimeError('conversation_ownership_lost');
  }
  return row;
}

function ownedValues(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
}) {
  return {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    sessionId: UuidSchema.parse(input.sessionId),
    runId: UuidSchema.parse(input.runId),
    workerId: UuidSchema.parse(input.workerId),
  };
}

export async function bindConversationThread(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  threadId: string;
}) {
  const values = {
    ...ownedValues(input),
    threadId: ThreadIdSchema.parse(input.threadId),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    const changed = current.thread_id !== values.threadId;
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set thread_id = ${values.threadId},
          thread_generation = thread_generation + ${changed ? 1 : 0},
          active_turn_id = null, updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function recordConversationTurn(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  threadId: string;
  turnId: string;
}) {
  const values = {
    ...ownedValues(input),
    threadId: ThreadIdSchema.parse(input.threadId),
    turnId: TurnIdSchema.parse(input.turnId),
  };
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const current = await lockedOwnedRuntime(transaction, values);
    if (current.thread_id !== values.threadId) {
      throw new ConversationRuntimeError('conversation_ownership_lost');
    }
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set active_turn_id = ${values.turnId}, updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}

export async function releaseConversationRuntime(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
  outcome: 'idle' | 'interrupted' | 'error';
  errorCode?: string;
}) {
  const values = ownedValues(input);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await lockedOwnedRuntime(transaction, values);
    const rows = await transaction<ConversationRuntimeRow[]>`
      update allrice_conversation_runtimes
      set state = ${input.outcome}, active_run_id = null,
          active_turn_id = null, worker_id = null,
          last_error_code = ${input.errorCode ?? null},
          last_completed_at = now(), updated_at = now()
      where session_id = ${values.sessionId}
      returning *
    `;
    return mapBinding(rows[0]!);
  });
}
