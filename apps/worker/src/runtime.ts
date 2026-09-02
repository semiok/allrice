import { runClaimedJob, type ClaimedJobRunnerInput } from './job-runner.js';
import { executeDispatchedJob } from './jobs/dispatch.js';

export async function executeClaimedJob(input: ClaimedJobRunnerInput) {
  return runClaimedJob(input, executeDispatchedJob);
}
