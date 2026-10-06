import {
  getPlatformRepositoryReviewExecution,
  repositoryReviewRequestGate,
  recordRepositoryReviewRemote,
} from '@allrice/database';
import { FixedRepositoryGithub } from '../repository-repair/github.js';
import { inspectRepositoryCi } from '../repository-repair/ci.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import { HandlerError } from '../errors.js';
import { RepositoryPublicationCiSchema } from '@allrice/database/technical-contracts';
/** The original CI inspector and bounded transport; no second GitHub client,
 * model loop, test re-run or repository write path. */
export async function verifyRepositoryReviewRemote(
  input: ClaimedJobHandlerInput,
  stage: 'preflight' | 'postflight',
) {
  const lease = {
    ...input.workflowLease,
    attempt: input.execution.job.attempt,
  };
  const task = await getPlatformRepositoryReviewExecution(lease),
    m = task.frozen.material;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const github = new FixedRepositoryGithub(
    () => repositoryReviewRequestGate(lease),
    signal,
    fetch,
    true,
  );
  const result = await inspectRepositoryCi(
    github,
    {
      id: m.publicationId,
      source: m.source,
      metadata: m.metadata,
      remote: m.remote,
    },
    signal,
  );
  const ci = RepositoryPublicationCiSchema.parse(result.observation);
  if (ci.state !== 'passed')
    throw new HandlerError(
      'REPOSITORY_REVIEW_REMOTE_CHANGED',
      'The exact repository candidate or CI could not be confirmed; review was not accepted.',
      false,
    );
  await recordRepositoryReviewRemote(lease, stage, ci, result.evidence);
}
