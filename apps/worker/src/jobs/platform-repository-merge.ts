import { mergeRepositoryCandidate } from '../repository-repair/merger.js';
import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
export async function executePlatformRepositoryMerge(
  input: ClaimedJobHandlerInput,
) {
  try {
    return await mergeRepositoryCandidate(
      { ...input.workflowLease, attempt: input.execution.job.attempt },
      input.signal,
    );
  } catch (error) {
    const known =
      error instanceof Error && /^REPOSITORY_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'REPOSITORY_MERGE_UNCONFIRMED';
    throw new HandlerError(
      known,
      'Repository merge could not be confirmed; read the existing operation before proceeding.',
      false,
    );
  }
}
