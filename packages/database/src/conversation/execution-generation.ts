import type postgres from 'postgres';
import {
  ExecutionGenerationSchema,
  UuidSchema,
  type ExecutionGeneration,
} from '@allrice/contracts';
import { DataAccessError } from '../data.ts';

type Reader = postgres.Sql | postgres.TransactionSql;
type Scope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
};

/** Routing ownership only. Callers independently establish current authority.
 * The DB makes this birth fact immutable, so reads introduce no new lock order
 * and cannot race a later generation flip between admission and dispatch. */
export async function readChatExecutionGeneration(db: Reader, input: Scope) {
  const [row] = await db<{ execution_generation: unknown }[]>`
    select execution_generation from allrice_chat_sessions
    where id=${UuidSchema.parse(input.sessionId)}
      and organization_id=${UuidSchema.parse(input.organizationId)}
      and workspace_id=${UuidSchema.parse(input.workspaceId)}
      and owner_id=${UuidSchema.parse(input.ownerId)}`;
  if (!row) throw new DataAccessError('not_found');
  return ExecutionGenerationSchema.parse(row.execution_generation);
}

export async function assertChatExecutionGeneration(
  db: Reader,
  input: Scope,
  expected: ExecutionGeneration,
) {
  if ((await readChatExecutionGeneration(db, input)) !== expected)
    throw new DataAccessError('authorization_denied');
}

/** Existing queue dispatch only. Non-chat jobs retain their existing gates. */
export async function assertLegacyJobExecutionGeneration(
  db: Reader,
  job: {
    run_id: string;
    organization_id: string;
    workspace_id: string | null;
    owner_id: string;
  },
) {
  const rows = await db<{ session_id: string }[]>`
    select session_id from allrice_employee_runs where run_id=${job.run_id}
      and organization_id=${job.organization_id}
      and workspace_id=${job.workspace_id} and owner_id=${job.owner_id}`;
  for (const row of rows)
    await assertChatExecutionGeneration(
      db,
      {
        organizationId: job.organization_id,
        workspaceId: job.workspace_id!,
        ownerId: job.owner_id,
        sessionId: row.session_id,
      },
      '3.x',
    );
}
