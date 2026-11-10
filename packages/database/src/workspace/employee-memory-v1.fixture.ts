/** Historical full-content fixture only; never imported by production entrypoints. */
import type {
  RequestContext,
  CreateWorkspaceMemoryInputSchema,
} from '@allrice/contracts';
import { CreateWorkspaceMemoryInputSchema as LegacyInput } from '@allrice/contracts';
import type { z } from 'zod';
import {
  runtimeFixtureStorage,
  type createRuntimeFixtureDatabase,
} from '../runtime.fixture.ts';
import { employeeMemoryScope } from './employee-memory.ts';
import { listWorkspaceMemories } from './service.ts';

export async function seedLegacyEmployeeMemory(
  db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'],
  context: RequestContext,
  input: z.input<typeof CreateWorkspaceMemoryInputSchema>,
) {
  runtimeFixtureStorage(db); // Refuse any non-fixture/shared connection.
  const memory = LegacyInput.parse(input);
  if (!memory.instanceId)
    throw Error('Historical fixture requires an exact instance');
  const instanceId = memory.instanceId;
  const id = await db.begin(async (tx) => {
    const scope = await employeeMemoryScope(
      context,
      memory.workspaceId,
      instanceId,
      tx,
    );
    const trust =
      memory.sourceType === 'user' ||
      (memory.sourceType === 'message' && memory.lifecycleState === 'durable')
        ? 'user_confirmed'
        : ['tool', 'connector'].includes(memory.sourceType)
          ? 'untrusted_external'
          : 'derived';
    // Omitted new columns remain NULL from the start, not erased from a new pair.
    const [row] = await tx<{ id: string }[]>`insert into allrice_memories
      (organization_id,workspace_id,employee_id,owner_id,instance_id,content,visibility,source_type,source_id,
        trust_level,confidence,source_label,lifecycle_state,memory_class,expires_at,last_verified_at)
      values(${scope.organizationId},${scope.workspaceId},${scope.employeeId},${scope.ownerId},${scope.instanceId},
        ${memory.content},'private',${memory.sourceType},${memory.sourceId},${trust},${memory.confidence},
        ${memory.sourceLabel},${memory.lifecycleState},${memory.memoryClass},${memory.expiresAt},
        ${trust === 'user_confirmed' ? new Date() : null}) returning id`;
    await tx`insert into allrice_memory_revisions
      (organization_id,workspace_id,memory_id,revision,content,trust_level,lifecycle_state,memory_class,
        confidence,expires_at,reason,changed_by)
      select organization_id,workspace_id,id,revision,content,trust_level,lifecycle_state,memory_class,
        confidence,expires_at,'synthetic historical v1 baseline',owner_id from allrice_memories where id=${row!.id}`;
    return row!.id;
  });
  return (
    await listWorkspaceMemories(context, memory.workspaceId, undefined, {
      instanceId,
    })
  ).find((row) => row.id === id)!;
}
