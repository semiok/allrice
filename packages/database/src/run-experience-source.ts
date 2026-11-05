import { hasMemorySourceTool, ExperienceSourceHandleSchema } from '@allrice/contracts';
import { ExperienceError } from './experience.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { employeeMemoryReadPredicate } from './workspace/employee-memory-read.ts';
import { memoryInstanceForRun } from './workspace/employee-memory.ts';
import { readRunMemoryContext, type RunMemoryAuthority } from './run-memory-context.ts';

/** The existing tool now expands only ordinary personally confirmed memory.
 * Historical adoption proof / native tool text is never a read capability.
 * No chat source is exposed: a memory reference cannot grant transcript access. */
export async function readRunExperienceSource(auth: RunMemoryAuthority, rawHandle: string) {
  const handle = ExperienceSourceHandleSchema.parse(rawHandle);
  return readRunMemoryContext(auth, 'experience_source', async (tx, state) => {
    const [run] = await tx`select execution_snapshot from allrice_employee_runs where run_id=${auth.scope.runId}`;
    if (!hasMemorySourceTool(run?.execution_snapshot)) throw new ExperienceError('identity_denied');
    const pin = state.confirmedPins?.find((item) => item.handle === handle);
    const instanceId = await memoryInstanceForRun(tx, auth.scope);
    if (!pin || !instanceId) throw new ExperienceError('identity_denied');
    const [row] = await tx`select m.id,r.content,r.revision from allrice_memories m
      join allrice_memory_revisions r on r.memory_id=m.id and r.organization_id=m.organization_id
        and r.workspace_id=m.workspace_id and r.revision=${pin.revision}
      where m.id=${pin.id} and ${employeeMemoryReadPredicate(tx, { ...auth.scope, instanceId })}`;
    if (!row || runtimePolicyDigest(row.content) !== pin.contentDigest) throw new ExperienceError('source_changed');
    return [{ handle, pin, kind: 'confirmed_employee_memory' as const,
      memory: { id: row.id as string, revision: row.revision as number, content: row.content as string },
      notice: '本人确认的记忆版本；并非聊天原文或资源读取授权。资料入口需重新鉴权。',
    }];
  });
}
