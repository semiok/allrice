import { publishRepositoryCandidate } from '../repository-repair/publisher.js';
import { RepositoryRemoteError } from '../repository-repair/github.js';
import { inspectRepositoryCi } from '../repository-repair/ci.js';
import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
export async function executePlatformRepositoryAction(
  input: ClaimedJobHandlerInput,
) {
  try {
    return await publishRepositoryCandidate(
      { ...input.workflowLease, attempt: input.execution.job.attempt },
      input.signal,
      { inspectCi: inspectRepositoryCi },
    );
  } catch (error) {
    if (error instanceof RepositoryRemoteError)
      throw new HandlerError(
        error.code,
        'Repository operation could not be confirmed; inspect the existing publication before proceeding.',
        false,
      );
    throw error;
  }
}
