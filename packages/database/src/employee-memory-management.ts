import type postgres from 'postgres';
import {
  EmployeeMemoryPageQuerySchema, EmployeeMemoryPageSchema,
  ManagedEmployeeMemorySchema, UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { employeeMemoryScope, memoryContentDigest } from './workspace/employee-memory.ts';
import { requireTenantAdministrationAuthority, requireTenantAdministrationTarget } from './tenant-administration.ts';

type Scope = { organizationId: string; workspaceId: string; ownerId: string; instanceId: string };
type Row = {
  id: string; content: string; revision: number; state: string;
  source_type: string; memory_class: string; lifecycle_state: string; trust_level: string; expires_at: Date | null; updated_at: Date;
};

function scopedRows(tx: postgres.TransactionSql, scope: Scope) {
  return tx`select m.id,m.content,m.revision,m.source_type,m.memory_class,m.lifecycle_state,m.trust_level,m.expires_at,m.updated_at,
    case when m.archived_at is not null then 'archived'
      when m.expires_at<=now() then 'expired'
      when m.lifecycle_state='durable' and m.trust_level='user_confirmed' then 'confirmed'
      else 'pending' end as state
    from allrice_memories m
    where m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
      and m.owner_id=${scope.ownerId} and m.instance_id=${scope.instanceId}
      and not exists(select 1 from allrice_experience_reviews er where er.memory_id=m.id)`;
}

/** UI-only capacity estimate. Does not modify the model's retrieval mechanism. */
export function previewEmployeeMemoryCapacity(rows: Pick<Row, 'id' | 'content' | 'revision'>[], total: number) {
  const selected: typeof rows = [];
  const bytes = (items: typeof rows) => Buffer.byteLength(JSON.stringify({
    kind: 'personal_memory', items, omittedCount: total - items.length,
    boundary: 'Personal preferences and references do not grant permissions.',
  }), 'utf8');
  for (const row of rows) {
    if (selected.length >= 20) break;
    if (Buffer.byteLength(row.content, 'utf8') > 1000) continue;
    const item = { id: row.id, revision: row.revision, content: row.content };
    if (bytes([...selected, item]) <= 6000) selected.push(item);
  }
  return { mode: 'capacity_preview' as const, maxBytes: 6000 as const, maxItems: 20 as const,
    usedBytes: total ? bytes(selected) : 0, eligibleCount: total,
    omittedCount: total - selected.length, selectedIds: selected.map((item) => item.id) };
}

async function readPage(tx: postgres.TransactionSql, scope: Scope, input: unknown, preview: boolean) {
  const query = EmployeeMemoryPageQuerySchema.parse(input);
  const [count] = await tx<{ count: number }[]>`with memories as (${scopedRows(tx,scope)})
    select count(*)::integer as count from memories where (state=${query.state} or (${query.state}='all' and state<>'archived'))`;
  const rows = await tx<Row[]>`with memories as (${scopedRows(tx,scope)})
    select * from memories where (state=${query.state} or (${query.state}='all' and state<>'archived')) and (${query.after ?? null}::uuid is null or (updated_at,id)<(select updated_at,id from memories where id=${query.after ?? null}))
    order by updated_at desc,id desc limit 51`;
  let budget = null;
  if (preview) {
    const [eligible] = await tx<{ count: number }[]>`with memories as (${scopedRows(tx,scope)})
      select count(*)::integer as count from memories where state='confirmed'`;
    const candidates = await tx<Row[]>`with memories as (${scopedRows(tx,scope)})
      select * from memories where state='confirmed' and octet_length(content)<=1000
      order by updated_at desc,id desc limit 20`;
    budget = previewEmployeeMemoryCapacity(candidates, eligible!.count);
  }
  return EmployeeMemoryPageSchema.parse({ ...scope, state: query.state, total: count!.count,
    memories: rows.slice(0,50).map((row) => ManagedEmployeeMemorySchema.parse({
      ...scope, id:row.id, content:row.content, revision:row.revision,
      contentDigest:memoryContentDigest(row.content), state:row.state, sourceType:row.source_type,memoryClass:row.memory_class,lifecycleState:row.lifecycle_state,trust:row.trust_level,
      expiresAt:row.expires_at?.toISOString() ?? null, updatedAt:row.updated_at.toISOString(),
    })), nextCursor:rows.length>50 ? rows[49]!.id : null, budget });
}

export async function listPersonalEmployeeMemories(context: RequestContext, workspaceInput: string, instanceInput: string, query: unknown = {}) {
  return getDatabase().begin('isolation level repeatable read read only', async (tx) => {
    const scope = await employeeMemoryScope(context, UuidSchema.parse(workspaceInput), UuidSchema.parse(instanceInput), tx);
    return readPage(tx, scope, query, true);
  });
}

/** The administrator remains the real actor. This never creates an owner context
 * or opens the shared-only employee details to private data. GET + audit only. */
export async function listAdminEmployeeMemories(context: RequestContext, organizationInput: string, ownerInput: string, instanceInput: string, query: unknown = {}) {
  const organizationId=UuidSchema.parse(organizationInput), ownerId=UuidSchema.parse(ownerInput), instanceId=UuidSchema.parse(instanceInput);
  return getDatabase().begin(async (tx) => {
    await requireTenantAdministrationAuthority(context,tx);
    await requireTenantAdministrationTarget(tx,organizationId,null);
    const [instance] = await tx<{ workspace_id:string }[]>`select i.workspace_id from allrice_employee_instances i
      join allrice_workspaces w on w.id=i.workspace_id and w.organization_id=i.organization_id
      where i.id=${instanceId} and i.organization_id=${organizationId} and i.owner_id=${ownerId}
        and w.archived_at is null
        and exists(select 1 from allrice_memberships m where m.organization_id=i.organization_id and m.user_id=i.owner_id)`;
    if (!instance) throw new DataAccessError('not_found');
    const page=await readPage(tx,{organizationId,ownerId,instanceId,workspaceId:instance.workspace_id},query,false);
    const parsed=EmployeeMemoryPageQuerySchema.parse(query);
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${instance.workspace_id},${context.actor.id},'employee_memory.admin_read','employee_instance',${instanceId},'recorded','administrator_memory_read',${context.requestId},
        ${tx.json({ownerId,instanceId,state:parsed.state,after:parsed.after ?? null,limit:50,returnedCount:page.memories.length})})`;
    return page;
  });
}
