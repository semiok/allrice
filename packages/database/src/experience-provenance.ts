import {
  ExperienceProvenanceSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { ExperienceError, experienceReviewEnabled } from './experience.ts';
import { getEmployeeInstance } from './employees/employee-instances.ts';
import { employeeAccessTransaction } from './employees/employee-access-cancellation.ts';
import { readPrivateExperience } from './experience-adoption.ts';
import {
  lockExperienceProjectionSource,
  readExperienceProjection,
} from './experience-projection.ts';

/** Owner-only exact source expansion. It does not expose an arbitrary Session,
 * renew an old proof, return archived evidence or mutate the index on GET. */
export async function getExperienceProvenance(
  context: RequestContext,
  input: { memoryId: string; instanceId: string; revision: number },
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  const memoryId = UuidSchema.parse(input.memoryId);
  const instanceId = UuidSchema.parse(input.instanceId);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new ExperienceError('invalid_source');
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await getEmployeeInstance(context, instanceId, tx);
    const current = await readPrivateExperience(tx, context, memoryId);
    if (
      current.pin.instanceId !== instanceId ||
      current.pin.revision !== input.revision
    )
      throw new ExperienceError('source_changed');
    await lockExperienceProjectionSource(tx, current);
    const view = await readExperienceProjection(tx, current);
    return ExperienceProvenanceSchema.parse({
      workspaceId: context.workspaceId,
      ...view,
      adoptedAt: current.proof.adoptedAt,
      consolidationRunId: current.source.receipt.runId,
      sources: current.source.occurrence.sources
        .filter((s) => current.proof.sourceIds.includes(s.id))
        .map((s) => ({
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
        })),
    });
  });
}
