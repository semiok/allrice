import { z } from 'zod';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  getPlatformRepositoryReviewExecution,
  repositoryReviewRequestGate,
  recordRepositoryReviewRemote,
  executeRepositoryReview,
  getDatabase,
  cloudStableId,
  appendJobEvent,
} from '@allrice/database';
import { FixedRepositoryGithub } from '../repository-repair/github.js';
import { inspectRepositoryCi } from '../repository-repair/ci.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import { HandlerError } from '../errors.js';
import {
  RepositoryPublicationCiSchema,
  RepositoryReviewCommandSchema,
  repositoryReviewToolName,
} from '@allrice/database/technical-contracts';
import type { HarnessToolCall } from '../harness/adapter.js';

export const platformRepositoryReviewToolDefinition = {
  name: repositoryReviewToolName,
  description:
    'Inspect the frozen repository candidate, record its independent review opinion, or seal its accepted delivery. No edits, execution, network or repository writes.',
  inputSchema: z.toJSONSchema(RepositoryReviewCommandSchema),
};

export async function executePlatformRepositoryReviewTool(
  input: ClaimedJobHandlerInput,
  call: HarnessToolCall,
) {
  input.signal.throwIfAborted();
  if (call.name !== repositoryReviewToolName)
    throw new HandlerError(
      'REPOSITORY_REVIEW_TOOL_DENIED',
      'Repository review tool required',
      false,
    );
  const args = RepositoryReviewCommandSchema.parse(call.arguments);
  const value = await executeRepositoryReview(
    {
      context: input.execution.context,
      worker: { ...input.workflowLease, attempt: input.execution.job.attempt },
      requestId: cloudStableId(
        `repository-review-call:${input.execution.context.runId}:${call.id}`,
      ),
      arguments: args,
    },
    new LocalStorageAdapter(
      process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
    ),
    getDatabase(),
  );
  await appendJobEvent({
    ...input.workflowLease,
    type: 'tool.completed',
    payload: {
      name: call.name,
      toolCallId: call.id,
      source: 'platform_repository_review',
      action: args.action,
    },
  });
  return { modelContent: JSON.stringify(value), summary: '已保存仓库审查事实' };
}

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
