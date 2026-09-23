/** Separate synthetic Worker process; production runner/queue/adapter ports.
 * Never imported by a production entrypoint. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getDatabase,
  claimNextJob,
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
  readNativeQuestionWait,
  claimConversationSteer,
  consumeConversationSteer,
  beginNativeTask,
  completeNativeTask,
  parkNativeQuestion,
  continueNativeQuestion,
  releaseConversationRuntime,
} from '@allrice/database';
import { runClaimedJob } from '../../src/job-runner.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { HandlerError } from '../../src/errors.js';

if (process.env.ALLRICE_NATIVE_WAIT_FIXTURE !== 'synthetic-only')
  throw Error('fixture_not_authorized');
const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  org: string;
  workspace: string;
  user: string;
  session: string;
  assignment: string;
  version: string;
  configChecksum: string;
  root: string;
  baseUrl: string;
};
const scope = await getDatabase()<
  { schema: string }[]
>`select current_schema() as schema`;
if (!/^p25_[a-f0-9]{32}$/.test(scope[0]!.schema))
  throw Error('isolated_fixture_schema_required');
const workerId = randomUUID();
let questionSuspension = false;
const job = await claimNextJob(workerId, 30000);
if (!job?.lease) throw Error('fixture_job_missing');
const adapter = new DshHarnessAdapter({
  runtimeRoot: join(config.root, 'owned-runtime'),
  credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
});
await runClaimedJob(
  {
    workerId,
    jobId: job.id,
    leaseToken: job.lease.token,
    leaseMs: 30000,
    heartbeatMs: 1000,
    executionRoot: join(config.root, 'execution'),
    stopping: () => false,
    onAbortReady: () => {},
  },
  async ({ execution, workflowLease, isolation, signal, onHarnessEvent }) => {
    const ownership = {
      organizationId: config.org,
      workspaceId: config.workspace,
      sessionId: config.session,
      runId: execution.context.runId,
      workerId,
    };
    let runtime = await acquireConversationRuntime({
      ...ownership,
      ownerId: config.user,
      configChecksum: config.configChecksum,
      compactThresholdTokens: 40000,
    });
    const owner = { context: execution.context, worker: workflowLease };
    const checkpoint = await readNativeQuestionWait({
      ...owner,
      configChecksum: config.configChecksum,
      generation: runtime.generation,
    });
    const command = checkpoint
      ? await claimConversationSteer({
          ...ownership,
          generation: runtime.generation,
          turnId: checkpoint.turnId,
        })
      : null;
    if (checkpoint && !command) throw Error('fixture_answer_missing');
    if (!(await beginNativeTask({ ...owner, attempt: execution.job.attempt })))
      throw new HandlerError(
        'DSH_EXECUTION_OUTCOME_UNKNOWN',
        'No replay',
        false,
      );
    let parked = false;
    try {
      const result = await adapter.execute({
        kernel: {
          schemaVersion: 1,
          harness: 'dsh',
          employeeAssignmentId: config.assignment,
          employeeVersionId: config.version,
          sessionId: config.session,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
          systemInstructions: 'Synthetic durable wait test.',
          userRequest: 'Ask for a choice then finish this task.',
          bootstrapConversation: '',
          authorizedMemoryContext: '',
          grantedCapabilities: ['model:invoke'],
          skillVersionIds: [],
          imageAttachments: [],
        },
        providerSnapshot: {
          provider: 'dsh',
          authMode: 'allrice_credential',
          route: 'openai-compatible',
          model: 'native-wait',
          reasoningEffort: 'low',
          credentialReference: 'synthetic-only',
          baseUrl: config.baseUrl,
        },
        storageObjects: [],
        workDirectory: isolation.workDirectory,
        executionEnvironment: isolation.environment,
        signal,
        attempt: execution.job.attempt,
        generation: runtime.generation,
        threadId: runtime.threadId,
        tools: [],
        onEvent: async (event) => {
          if (
            event.type === 'tool.failed' &&
            event.sourcePayload?.questionWait === true
          )
            questionSuspension = true;
          await onHarnessEvent(event);
        },
        onThreadBound: async (input) => {
          runtime = await bindConversationThread({ ...ownership, ...input });
          return { generation: runtime.generation };
        },
        onTurnStarted: async (input) => {
          runtime = await recordConversationTurn({ ...ownership, ...input });
        },
        questionWait: {
          ...(checkpoint && command
            ? {
                resume: {
                  sessionId: checkpoint.sessionId,
                  questionId: checkpoint.questionId,
                  turnId: checkpoint.turnId,
                  inputId: command.clientUserMessageId,
                  text: command.message,
                },
              }
            : {}),
          adopted: async (proof) => {
            if (!checkpoint || !command) throw Error('fixture_no_wait');
            await consumeConversationSteer({
              commandId: command.id,
              workerId,
              proof,
            });
            await continueNativeQuestion({
              ...owner,
              questionId: checkpoint.questionId,
            });
          },
          park: async (checkpoint) => {
            await parkNativeQuestion({
              ...owner,
              checkpoint,
              configChecksum: config.configChecksum,
              generation: runtime.generation,
            });
            parked = true;
          },
        },
      });
      await completeNativeTask({ ...owner, attempt: execution.job.attempt });
      return result;
    } finally {
      if (!parked)
        await releaseConversationRuntime({ ...ownership, outcome: 'idle' });
    }
  },
);
process.send?.({
  finished: true,
  jobId: job.id,
  workerId,
  processes: adapter.runtimeInventory().length,
  questionSuspension,
});
await adapter.close();
// Simulates the Worker remaining available for other jobs; no per-Run timer.
setInterval(() => {}, 60000);
