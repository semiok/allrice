/** @internal Shared original memory mutation core, NOT in workspace/service or
 * any public barrel. Callers retain authority/admission/source/operation locks
 * and the actual outer transaction. No SQL handle is returned. */
import type {
  MemoryClass,
  MemoryLifecycleState,
  PersonalMemoryPair,
  RequestContext,
  Visibility,
} from '@allrice/contracts';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import { DataAccessError } from '../data.ts';
import type { EmployeeMemoryScope } from './employee-memory.ts';
import { memoryPairContent } from './employee-memory-primitives.ts';

export interface MemoryRow {
  metadata?: Record<string, unknown>;
  id: string;
  organization_id: string;
  workspace_id: string;
  employee_id: string | null;
  instance_id: string | null;
  owner_id: string;
  content: string;
  summary: string | null;
  details: string | null;
  visibility: Visibility;
  source_type:
    'user' | 'file' | 'message' | 'checkpoint' | 'tool' | 'connector';
  source_id: string | null;
  lifecycle_state: MemoryLifecycleState;
  memory_class: MemoryClass;
  revision: number;
  trust_level: 'user_confirmed' | 'derived';
  confidence: number | string;
  source_label: string;
  captured_at: Date;
  expires_at: Date | null;
  last_verified_at: Date | null;
  supersedes_memory_id: string | null;
  last_recalled_at: Date | null;
  recall_count: number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}
function owner(context: RequestContext) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context.actor.id;
}
export async function insertEmployeeMemoryPair(
  tx: Sql | TransactionSql,
  context: RequestContext,
  scope: EmployeeMemoryScope,
  pair: PersonalMemoryPair,
  source: {
    sourceType: MemoryRow['source_type'];
    sourceId: string | null;
    sourceLabel: string;
    trust: MemoryRow['trust_level'];
    confidence: number;
    lifecycleState: MemoryLifecycleState;
    memoryClass: MemoryClass;
    metadata?: Record<string, JSONValue>;
  },
) {
  const actorId = owner(context);
  const [row] = await tx<MemoryRow[]>`
    insert into allrice_memories(organization_id,workspace_id,employee_id,owner_id,instance_id,
      content,summary,details,visibility,source_type,source_id,trust_level,confidence,source_label,
      lifecycle_state,memory_class,expires_at,last_verified_at,metadata)
    values(${scope.organizationId},${scope.workspaceId},${scope.employeeId},${scope.ownerId},${scope.instanceId},
      ${memoryPairContent(pair)},${pair.summary},${pair.details},'private',${source.sourceType},${source.sourceId},
      ${source.trust},${source.confidence},${source.sourceLabel},${source.lifecycleState},${source.memoryClass},null,
      ${source.trust === 'user_confirmed' ? new Date() : null},${tx.json(source.metadata ?? {})}) returning *`;
  if (!row) throw new Error('memory creation failed');
  await insertMemoryRevision(
    tx,
    context,
    row,
    `created from ${source.sourceLabel}`,
  );
  // Same original memory.create audit fields/decision, in the pair/receipt tx.
  await tx`insert into allrice_audit_events(
    organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${context.organizationId},${scope.workspaceId},${actorId},'memory.create','memory',${row.id},
      'allowed',${`explicit_${source.sourceType}_source`},${context.requestId})`;
  return row;
}
export async function insertMemoryRevision(
  tx: Sql | TransactionSql,
  context: RequestContext,
  row: MemoryRow,
  reason: string,
) {
  await tx`insert into allrice_memory_revisions
    (organization_id,workspace_id,memory_id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,
      confidence,expires_at,reason,changed_by)
    values(${row.organization_id},${row.workspace_id},${row.id},${row.revision},${row.content},${row.summary},${row.details},
      ${row.trust_level},${row.lifecycle_state},${row.memory_class},${row.confidence},${row.expires_at},
      ${reason},${owner(context)})`;
}
