import { hasMemorySourceTool } from '@allrice/contracts';
import {
  ExperienceReadPinsSchema,
  ExperienceSourceHandleSchema,
} from '@allrice/contracts';
import { readPrivateExperience } from './experience-adoption.ts';
import { ExperienceError } from './experience.ts';
import { experienceSkillsMatchRun } from './experience-skill-dependencies.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  lockExperienceProjectionSource,
  readExperienceProjection,
  projectionFor,
} from './experience-projection.ts';
import {
  readRunMemoryContext,
  type RunMemoryAuthority,
} from './run-memory-context.ts';

/** Handle lookup is confined to already issued Run pins. A guessed source ID,
 * older version or cached native tool response cannot grant a new read. */
export async function readRunExperienceSource(
  auth: RunMemoryAuthority,
  rawHandle: string,
) {
  const handle = ExperienceSourceHandleSchema.parse(rawHandle);
  return readRunMemoryContext(auth, 'experience_source', async (tx) => {
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
  });
}
