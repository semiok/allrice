import {
  ExperienceReadPinsSchema,
} from '@allrice/contracts';
import { readPrivateExperience } from './experience-adoption.ts';
import { experienceSkillsMatchRun } from './experience-skill-dependencies.ts';
import {
  lockExperienceProjectionSource,
  readExperienceProjection,
  projectionFor,
} from './experience-projection.ts';

import type { TransactionSql } from 'postgres';
import {
  hasMemorySourceTool,
  ExperienceSourceHandleSchema,
} from '@allrice/contracts';
import { ExperienceError } from './experience.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { employeeMemoryReadPredicate } from './workspace/employee-memory-read.ts';
import { memoryInstanceForRun } from './workspace/employee-memory.ts';
import {
  readRunMemoryContext,
  type RunMemoryAuthority,
} from './run-memory-context.ts';

/** The existing tool now expands only ordinary personally confirmed memory.
 * Historical adoption proof / native tool text is never a read capability.
 * No chat source is exposed: a memory reference cannot grant transcript access. */
export async function readRunExperienceSource(
  auth: RunMemoryAuthority,
  rawHandle: string,
) {
  const handle = ExperienceSourceHandleSchema.parse(rawHandle);
  return readRunMemoryContext(auth, 'experience_source', async (tx, state) => {
    if (state.initial.documentDigest === undefined) return readLegacyRunSource(tx, auth, handle);
    const [run] =
      await tx`select execution_snapshot from allrice_employee_runs where run_id=${auth.scope.runId}`;
    if (!hasMemorySourceTool(run?.execution_snapshot))
      throw new ExperienceError('identity_denied');
    const pin = state.confirmedPins?.find((item) => item.handle === handle);
    const instanceId = await memoryInstanceForRun(tx, auth.scope);
    if (!pin || !instanceId) throw new ExperienceError('identity_denied');
    const [row] =
      await tx`select m.id,r.content,r.revision from allrice_memories m
      join allrice_memory_revisions r on r.memory_id=m.id and r.organization_id=m.organization_id
        and r.workspace_id=m.workspace_id and r.revision=${pin.revision}
      where m.id=${pin.id} and ${employeeMemoryReadPredicate(tx, { ...auth.scope, instanceId })}`;
    if (!row || runtimePolicyDigest(row.content) !== pin.contentDigest)
      throw new ExperienceError('source_changed');
    return [
      {
        handle,
        pin,
        kind: 'confirmed_employee_memory' as const,
        memory: {
          id: row.id as string,
          revision: row.revision as number,
          content: row.content as string,
        },
        notice:
          '本人确认的记忆版本；并非聊天原文或资源读取授权。资料入口需重新鉴权。',
      },
    ];
  });
}

/** Frozen legacy non-document Runs retain their original source contract. */
async function readLegacyRunSource(tx: TransactionSql, auth: RunMemoryAuthority, handle: string) {
    const [run] =
      await tx`select experience_reads,execution_snapshot from allrice_employee_runs where run_id=${auth.scope.runId}`;
    if (!hasMemorySourceTool(run?.execution_snapshot))
      throw new ExperienceError('identity_denied');
    const pin = ExperienceReadPinsSchema.parse(run!.experience_reads).find(
      (p) =>
        `experience:${runtimePolicyDigest({ runId: auth.scope.runId, pin: p })}` ===
        handle,
    );
    if (!pin) throw new ExperienceError('identity_denied');
    const current = await readPrivateExperience(
      tx,
      {
        actor: { type: 'user', id: auth.scope.ownerId },
        organizationId: auth.scope.organizationId,
        workspaceId: auth.scope.workspaceId,
      },
      pin.id,
    );
    if (
      runtimePolicyDigest(current.pin) !== runtimePolicyDigest(pin) ||
      (current.proof.validation.kind === 'independent_skill_case' &&
        !experienceSkillsMatchRun(
          current.proof.validation.dependencies,
          run!.execution_snapshot?.personalSkills,
        ))
    )
      throw new ExperienceError('source_changed');
    await lockExperienceProjectionSource(tx, current);
    // A broken derived index can degrade the representation, never authority.
    const view = await tx
      .savepoint((cache) => readExperienceProjection(cache, current))
      .catch(() => ({
        projection: projectionFor(current),
        representation: 'original' as const,
        indexState: 'unavailable' as const,
      }));
    return current.source.occurrence.sources
      .filter((s) => current.proof.sourceIds.includes(s.id))
      .map((s) => ({
        handle,
        pin,
        representation: view.representation,
        indexState: view.indexState,
        rule: view.projection.rule,
        applicability: view.projection.applicability,
        source: {
          id: s.id,
          runId: s.runId,
          sessionId: s.sessionId,
          messageId: s.messageId,
          excerpt: s.excerpt,
          sourceDigest: s.sourceDigest,
          skills: [
            ...new Map(
              s.evidence.skills.map(({ pin }) => [pin.bindingId, pin]),
            ).values(),
          ],
        },
      }));

}
