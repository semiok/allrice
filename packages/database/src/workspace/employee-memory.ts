import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  UuidSchema,
  WorkspaceMemorySchema,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { resolveEmployeeSessionInstance } from '../employees/employee-instances.ts';
import type { ResourcePrincipal } from '../resource-principal.ts';

type Sql = ReturnType<typeof getDatabase> | TransactionSql;
export type EmployeeMemoryIdentity = ResourcePrincipal &
  Partial<Pick<RequestContext, 'sessionId'>>;
export type EmployeeMemoryScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  instanceId: string;
  employeeId: string;
};

export class EmployeeMemoryConflict extends Error {
  constructor() {
    super('employee_memory_conflict');
  }
}

export const memoryContentDigest = (content: string) =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** The browser selects an instance, never an owner. Resolve current persisted
 * membership and the existing assignment/instance gate inside the transaction.
 * Read-only callers do not materialize legacy instances. */
export async function employeeMemoryScope(
  context: EmployeeMemoryIdentity,
  workspaceId: string,
  instanceId: string,
  tx: TransactionSql,
  write = false,
): Promise<EmployeeMemoryScope> {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const who = { ...context, workspaceId: UuidSchema.parse(workspaceId) };
  const principal = await readContentPrincipal(who, tx, write);
  if (!principal || (write && !principal.writable))
    throw new DataAccessError('authorization_denied');
  let [row] = await tx<{ assignment_id: string; employee_id: string }[]>`
    select i.assignment_id,a.employee_id from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id
      and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
    where i.id=${UuidSchema.parse(instanceId)} and i.organization_id=${context.organizationId}
      and i.workspace_id=${who.workspaceId} and i.owner_id=${context.actor.id}`;
  if (!row && write) {
    // The existing general-instance resolver owns this mapping. This creates
    // no memory mapping and cannot select a different user's assignment.
    await resolveEmployeeSessionInstance(who, instanceId, undefined, tx, true);
    [row] = await tx<{ assignment_id: string; employee_id: string }[]>`
      select id assignment_id,employee_id from allrice_employee_assignments where id=${instanceId}`;
  }
  if (!row) throw new DataAccessError('not_found');
  await resolveEmployeeSessionInstance(
    who,
    row.assignment_id,
    instanceId,
    tx,
    write,
  );
  return {
    organizationId: context.organizationId,
    workspaceId: who.workspaceId,
    ownerId: context.actor.id,
    instanceId,
    employeeId: row.employee_id,
  };
}

/** Authority for model reads comes from the Run/Session row, not tool args or
 * a model-supplied employee ID. This helper only narrows an existing read. */
export async function memoryInstanceForRun(
  sql: Sql,
  scope: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    runId: string;
  },
) {
  if (
    !(await readContentPrincipal(
      {
        actor: { type: 'user', id: scope.ownerId },
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
      },
      sql,
    ))
  )
    return null;
  const [row] = await sql<{ instance_id: string }[]>`
    select i.id instance_id from allrice_employee_runs r
    join allrice_chat_sessions s on s.id=r.session_id and s.organization_id=r.organization_id
      and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id
    join allrice_employee_instances i on i.id=coalesce(s.employee_instance_id,s.employee_assignment_id)
      and i.organization_id=s.organization_id and i.workspace_id=s.workspace_id and i.owner_id=s.owner_id
    join allrice_employee_assignments a on a.id=i.assignment_id and a.id=r.employee_assignment_id
      and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id and a.user_id=i.owner_id
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id
      and e.workspace_id=a.workspace_id
    where r.run_id=${scope.runId} and r.organization_id=${scope.organizationId}
      and r.workspace_id=${scope.workspaceId} and r.owner_id=${scope.ownerId}
      and s.archived_at is null and i.archived_at is null and a.active and e.status='active'
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
          and d.tenant_employee_id=a.employee_id and not d.active)`;
  return row?.instance_id ?? null;
}

export function assertMemoryRevision(
  current: { revision: number; content: string },
  expected: { expectedRevision: number; contentDigest: string },
) {
  if (
    current.revision !== expected.expectedRevision ||
    memoryContentDigest(current.content) !== expected.contentDigest
  )
    throw new EmployeeMemoryConflict();
}

/** The caller has already locked current identity and instance authority.
 * Persist the receipt in the same transaction as content/revisions/audit.
 * A later edit/archive prevents an old acknowledgement becoming a fresh one. */
export async function memoryOperation(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
  operation: 'create' | 'correct' | 'promote' | 'archive',
  key: string,
  request: unknown,
  mutate: () => Promise<z.infer<typeof WorkspaceMemorySchema>>,
) {
  const digest = memoryContentDigest(JSON.stringify({ operation, request }));
  const lockKey = `employee-memory:${scope.organizationId}:${scope.workspaceId}:${scope.ownerId}:${scope.instanceId}:${key}`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey},0))`;
  const [prior] = await tx<
    {
      request_digest: string;
      response: unknown;
      revision: number;
      archived_at: Date | null;
    }[]
  >`
    select op.request_digest,op.response,m.revision,m.archived_at
    from allrice_employee_memory_operations op join allrice_memories m
      on m.id=op.memory_id and m.organization_id=op.organization_id and m.workspace_id=op.workspace_id
      and m.owner_id=op.owner_id and m.instance_id=op.instance_id
    where op.organization_id=${scope.organizationId} and op.workspace_id=${scope.workspaceId}
      and op.owner_id=${scope.ownerId} and op.instance_id=${scope.instanceId} and op.operation_key=${key}
    for share of m`;
  if (prior) {
    const response = WorkspaceMemorySchema.parse(prior.response);
    if (
      prior.request_digest !== digest ||
      prior.revision !== response.revision ||
      Boolean(prior.archived_at) !== (operation === 'archive')
    )
      throw new EmployeeMemoryConflict();
    return response;
  }
  const response = await mutate();
  await tx`insert into allrice_employee_memory_operations
    (organization_id,workspace_id,owner_id,instance_id,operation_key,operation,request_digest,memory_id,response)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${key},
      ${operation},${digest},${response.id},${tx.json(response)})`;
  return response;
}
