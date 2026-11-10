import type { TransactionSql } from 'postgres';
import {
  EmployeeMemoryCountsSchema,
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryRecordSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  EmployeeMemoryContractChanged,
  EmployeeMemoryLimitReached,
  employeeMemoryScope,
  memoryPairDigest,
  type EmployeeMemoryScope,
} from './workspace/employee-memory.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';

export type PersonalMemoryRow = {
  id: string;
  summary: string | null;
  details: string | null;
  revision: number;
  lifecycle_state: string;
  trust_level: string;
  captured_at: Date;
  updated_at: Date;
};

/** Ordinary private records only. Raw reviews and business-method data retain
 * their own APIs; this predicate grants neither source nor resource access. */
export function ordinaryMemoryPredicate(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
) {
  return tx`m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
    and m.owner_id=${scope.ownerId} and m.instance_id=${scope.instanceId}
    and m.employee_id=${scope.employeeId} and m.visibility='private'
    and not exists(select 1 from allrice_experience_reviews r where r.memory_id=m.id)
    and not exists(select 1 from allrice_brand_content_experiences b where b.memory_id=m.id)
    and not exists(select 1 from allrice_employee_runs origin
      where origin.organization_id=m.organization_id and origin.workspace_id=m.workspace_id and origin.method_authoring
        and ((m.source_type='message' and m.source_id in (origin.user_message_id,origin.assistant_message_id))
          or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
            where cp.id=m.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))`;
}

export function mapEmployeeMemoryRecord(row: PersonalMemoryRow) {
  if (row.summary === null) throw new EmployeeMemoryContractChanged();
  return EmployeeMemoryRecordSchema.parse({
    id: row.id,
    summary: row.summary,
    details: row.details,
    hasDetails: row.details !== null,
    state:
      row.lifecycle_state === 'durable' && row.trust_level === 'user_confirmed'
        ? 'active'
        : 'pending',
    revision: row.revision,
    pairDigest: memoryPairDigest({
      summary: row.summary,
      details: row.details,
    }),
    capturedAt: row.captured_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function lockEmployeeMemoryOrder(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`memory-order:${scope.organizationId}:${scope.ownerId}:${scope.instanceId}`},0))`;
}

export async function employeeMemoryCounts(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
) {
  const [counts] = await tx<{ active: number; pending: number }[]>`
    select count(*) filter(where m.lifecycle_state='durable' and m.trust_level='user_confirmed')::integer active,
      count(*) filter(where not (m.lifecycle_state='durable' and m.trust_level='user_confirmed'))::integer pending
    from allrice_memories m where ${ordinaryMemoryPredicate(tx, scope)}
      and m.archived_at is null and (m.expires_at is null or m.expires_at>clock_timestamp())`;
  if (counts!.active > 100) throw new EmployeeMemoryContractChanged();
  return EmployeeMemoryCountsSchema.parse({ ...counts, maxActive: 100 });
}

/** Caller holds the existing same-scope foreground serial point. Background
 * candidate producers never acquire that lock or consume an active place. */
export async function assertEmployeeMemoryAdmission(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
) {
  const counts = await employeeMemoryCounts(tx, scope);
  if (counts.active === 100) throw new EmployeeMemoryLimitReached();
}

async function readManaged(
  tx: TransactionSql,
  scope: EmployeeMemoryScope,
  memoryId?: string,
) {
  const rows = await tx<
    PersonalMemoryRow[]
  >`select m.id,m.summary,m.details,m.revision,m.lifecycle_state,m.trust_level,m.captured_at,m.updated_at
    from allrice_memories m where ${ordinaryMemoryPredicate(tx, scope)} and m.archived_at is null
      and (m.expires_at is null or m.expires_at>clock_timestamp())
      ${memoryId ? tx`and m.id=${memoryId}` : tx``}
    order by case when m.lifecycle_state='durable' and m.trust_level='user_confirmed' then m.updated_at else m.captured_at end desc,m.id desc`;
  if (memoryId) {
    if (!rows[0]) throw new DataAccessError('not_found');
    return {
      schemaVersion: 2 as const,
      memory: mapEmployeeMemoryRecord(rows[0]),
    };
  }
  const projected = rows.map((row) => {
    const record = mapEmployeeMemoryRecord(row);
    return {
      id: record.id,
      summary: record.summary,
      hasDetails: record.hasDetails,
      state: record.state,
      revision: record.revision,
      pairDigest: record.pairDigest,
      capturedAt: record.capturedAt,
      updatedAt: record.updatedAt,
    };
  });
  const active = projected.filter((row) => row.state === 'active');
  const pending = projected.filter((row) => row.state === 'pending');
  if (active.length > 100) throw new EmployeeMemoryContractChanged();
  return EmployeeMemoryListSchema.parse({
    schemaVersion: 2,
    workspaceId: scope.workspaceId,
    instanceId: scope.instanceId,
    counts: { active: active.length, pending: pending.length, maxActive: 100 },
    active,
    pending,
  });
}

export async function listPersonalEmployeeMemories(
  context: RequestContext,
  workspaceInput: string,
  instanceInput: string,
  query: unknown = {},
) {
  z.object({}).strict().parse(query);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      const scope = await employeeMemoryScope(
        context,
        UuidSchema.parse(workspaceInput),
        UuidSchema.parse(instanceInput),
        tx,
      );
      return EmployeeMemoryListSchema.parse(await readManaged(tx, scope));
    },
  );
}

export async function getPersonalEmployeeMemory(
  context: RequestContext,
  workspaceInput: string,
  instanceInput: string,
  memoryInput: string,
) {
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      const scope = await employeeMemoryScope(
        context,
        UuidSchema.parse(workspaceInput),
        UuidSchema.parse(instanceInput),
        tx,
      );
      return EmployeeMemoryDetailResponseSchema.parse(
        await readManaged(tx, scope, UuidSchema.parse(memoryInput)),
      );
    },
  );
}

/** Real administrator authority, never a forged owner context. Every successful
 * list/detail read writes its own body-free audit in the same transaction. */
async function readAdmin(
  context: RequestContext,
  organizationInput: string,
  ownerInput: string,
  instanceInput: string,
  memoryInput?: string,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    ownerId = UuidSchema.parse(ownerInput),
    instanceId = UuidSchema.parse(instanceInput);
  const memoryId =
    memoryInput === undefined ? undefined : UuidSchema.parse(memoryInput);
  return getDatabase().begin('isolation level repeatable read', async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    await requireTenantAdministrationTarget(tx, organizationId, null);
    const [instance] = await tx<
      { workspace_id: string; employee_id: string }[]
    >`
      select i.workspace_id,a.employee_id from allrice_employee_instances i
      join allrice_employee_assignments a on a.id=i.assignment_id and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id
      join allrice_workspaces w on w.id=i.workspace_id and w.organization_id=i.organization_id
      where i.id=${instanceId} and i.organization_id=${organizationId} and i.owner_id=${ownerId} and w.archived_at is null
        and exists(select 1 from allrice_memberships m where m.organization_id=i.organization_id and m.user_id=i.owner_id)`;
    if (!instance) throw new DataAccessError('not_found');
    const result = await readManaged(
      tx,
      {
        organizationId,
        ownerId,
        instanceId,
        workspaceId: instance.workspace_id,
        employeeId: instance.employee_id,
      },
      memoryId,
    );
    const returnedCount =
      'memory' in result ? 1 : result.active.length + result.pending.length;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${instance.workspace_id},${context.actor.id},'employee_memory.admin_read',${memoryId ? 'memory' : 'employee_instance'},${memoryId ?? instanceId},'recorded','administrator_memory_read',${context.requestId},
        ${tx.json({ ownerId, instanceId, schemaVersion: 2, returnedCount, ...(memoryId ? { memoryId } : {}) })})`;
    return result;
  });
}

export async function listAdminEmployeeMemories(
  context: RequestContext,
  organizationInput: string,
  ownerInput: string,
  instanceInput: string,
  query: unknown = {},
) {
  z.object({}).strict().parse(query);
  return EmployeeMemoryListSchema.parse(
    await readAdmin(context, organizationInput, ownerInput, instanceInput),
  );
}
export async function getAdminEmployeeMemory(
  context: RequestContext,
  organizationInput: string,
  ownerInput: string,
  instanceInput: string,
  memoryInput: string,
) {
  return EmployeeMemoryDetailResponseSchema.parse(
    await readAdmin(
      context,
      organizationInput,
      ownerInput,
      instanceInput,
      memoryInput,
    ),
  );
}
