/** Isolated current V2 record fixture; source permissions are exercised by the caller. */
import { randomUUID } from 'node:crypto';
import {
  PersonalMemoryPairSchema,
  type RequestContext,
} from '@allrice/contracts';
import {
  runtimeFixtureStorage,
  type createRuntimeFixtureDatabase,
} from '../runtime.fixture.ts';
import { employeeMemoryScope } from './employee-memory.ts';
import { getPersonalEmployeeMemory } from '../employee-memory-management.ts';
export async function seedPersonalMemoryPair(
  db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'],
  context: RequestContext,
  input: {
    workspaceId: string;
    instanceId: string;
    summary: string;
    details: string | null;
    sourceType?:
      'user' | 'message' | 'checkpoint' | 'tool' | 'connector' | 'file';
    sourceId?: string | null;
  },
) {
  runtimeFixtureStorage(db);
  const pair = PersonalMemoryPairSchema.parse({
    summary: input.summary,
    details: input.details,
  });
  const id = randomUUID();
  await db.begin(async (tx) => {
    const scope = await employeeMemoryScope(
      context,
      input.workspaceId,
      input.instanceId,
      tx,
    );
    const content =
      pair.details === null ? pair.summary : `${pair.summary}\n${pair.details}`;
    await tx`insert into allrice_memories(id,organization_id,workspace_id,employee_id,owner_id,instance_id,
      content,summary,details,source_type,source_id,lifecycle_state,trust_level)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.employeeId},${scope.ownerId},${scope.instanceId},
      ${content},${pair.summary},${pair.details},${input.sourceType ?? 'user'},${input.sourceId ?? null},'candidate','derived')`;
    await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,summary,details,
      trust_level,lifecycle_state,memory_class,confidence,expires_at,reason,changed_by)
      select organization_id,workspace_id,id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,
      confidence,expires_at,'synthetic current V2 pair',owner_id from allrice_memories where id=${id}`;
  });
  return (
    await getPersonalEmployeeMemory(
      context,
      input.workspaceId,
      input.instanceId,
      id,
    )
  ).memory;
}
