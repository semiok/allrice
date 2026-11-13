import { employeeMemoryReadPredicate } from '../workspace/employee-memory-read.ts';
import { getDatabase } from '../core/client.ts';
import { lockWorkspaceStorageQuota } from '../core/storage-quota.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { memoryInstanceForRun } from '../workspace/employee-memory.ts';
import { employeeAccessTransaction } from './employee-access-cancellation.ts';
import {
  type getEmployeeInstance,
  resolveEmployeeSessionInstance,
} from './employee-instances.ts';
import {
  assertEmployeeChatRun,
  employeeChatIdentity,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import type { ContentTx } from './employee-content-model.ts';

/** Existing owner, instance, root, lease and file authority boundary shared by
 * personal Skill import/version operations. */
export async function enterEmployeeContentChat<T>(
  input: EmployeeChatCall,
  tool: string,
  read: (
    tx: ContentTx,
    instance: Awaited<ReturnType<typeof getEmployeeInstance>>,
    text: string,
  ) => Promise<T>,
  options: { reserveStorage?: boolean } = {},
) {
  const { scope } = employeeChatIdentity(input);
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    if (options.reserveStorage)
      await lockWorkspaceStorageQuota(
        tx,
        scope.organizationId,
        scope.workspaceId,
      );
    await readContentPrincipal(scope, tx, true);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
    const [session] = await tx<
      { assignment_id: string; instance_id: string }[]
    >`
      select employee_assignment_id assignment_id,coalesce(employee_instance_id,employee_assignment_id) instance_id
      from allrice_chat_sessions where id=${input.sessionId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.actor.id} and archived_at is null`;
    if (!session) throw new DataAccessError('not_found');
    const instance = await resolveEmployeeSessionInstance(
      scope,
      session.assignment_id,
      session.instance_id,
      tx,
    );
    const text = await assertEmployeeChatRun(tx, input, instance, tool);
    return read(tx, instance, text);
  });
}

/** Frozen recall can predate another Run entering authoring. Recheck at the
 * Worker execution boundary, preserving frozen bodies and historical records. */
export async function filterEmployeeMethodMemories<
  T extends { id: string; revision?: number; content?: string },
>(
  scope: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    runId: string;
  },
  memories: T[],
): Promise<T[]> {
  if (!memories.length) return memories;
  const sql = getDatabase();
  const instanceId = await memoryInstanceForRun(sql, scope);
  if (!instanceId) return [];
  const rows = await getDatabase()<
    { id: string; revision: number; content: string }[]
  >`select m.id,m.revision,m.content from allrice_memories m
    where m.id=any(${memories.map((m) => m.id)}::uuid[])
      and ${employeeMemoryReadPredicate(sql, { ...scope, instanceId })}`;
  // Ordinary edits apply to the next Run. Keep this Run's frozen bytes;
  // only current eligibility (including archival/revocation) may remove them.
  const readable = new Set(rows.map((row) => row.id));
  return memories.filter((memory) => readable.has(memory.id));
}
