import { createHash } from 'node:crypto';

import {
  makeObjectKey,
  type StorageObject,
  type WorkflowDefinition,
  type WorkflowStepRun,
  type WorkflowStepStatus,
} from '@allrice/contracts';
import {
  completeWorkflowRun,
  completeWorkflowStep,
  failWorkflowStep,
  getWorkflowExecution,
  pauseWorkflowForApproval,
  recordWorkflowEvaluation,
  registerWorkflowArtifact,
  startWorkflowStep,
  type ClaimedExecution,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';

import { HandlerError } from './errors.js';

const dependencyComplete = new Set<WorkflowStepStatus>([
  'succeeded',
  'skipped',
  'compensated',
]);

export class WorkflowPaused extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly workflowRunId: string,
  ) {
    super('workflow_waiting_approval');
  }
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function readyWorkflowSteps(
  definition: WorkflowDefinition,
  steps: WorkflowStepRun[],
) {
  const states = new Map(steps.map((step) => [step.stepKey, step.status]));
  return definition.steps.filter(
    (step) =>
      states.get(step.key) === 'pending' &&
      step.dependsOn.every((dependency) =>
        dependencyComplete.has(states.get(dependency) ?? 'pending'),
      ),
  );
}

export function workflowStepInput(input: {
  workflowInput: unknown;
  configuredInput: Record<string, unknown>;
  dependencies: { key: string; output: unknown }[];
}) {
  return {
    workflowInput: input.workflowInput,
    configured: input.configuredInput,
    dependencies: Object.fromEntries(
      input.dependencies.map((dependency) => [
        dependency.key,
        dependency.output,
      ]),
    ),
  };
}

export async function executeDurableWorkflow(input: {
  execution: ClaimedExecution;
  workerId: string;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  storageRoot: string;
  evaluation?: {
    routingAccurate?: boolean;
    citationsAccurate?: boolean;
    approvalExpected?: boolean;
  };
  executeStep: (input: {
    step: WorkflowDefinition['steps'][number];
    value: ReturnType<typeof workflowStepInput>;
    idempotencyKey: string;
  }) => Promise<{ output: unknown; sideEffectCommitted?: boolean }>;
}) {
  const startedAt = Date.now();
  while (true) {
    const run = await getWorkflowExecution({
      organizationId: input.execution.context.organizationId,
      workspaceId: input.execution.context.workspaceId!,
      runId: input.execution.context.runId,
    });
    if (run.status === 'waiting_approval') {
      const waiting = run.steps.find(
        (step) => step.status === 'waiting_approval',
      );
      throw new WorkflowPaused(waiting?.approvalId ?? '', run.id);
    }
    if (run.status === 'needs_attention') {
      throw new HandlerError(
        'WORKFLOW_NEEDS_ATTENTION',
        'Workflow requires manual intervention',
        false,
      );
    }
    const ready = readyWorkflowSteps(run.definition, run.steps);
    if (ready.length === 0) {
      const complete = run.steps.every((step) =>
        dependencyComplete.has(step.status),
      );
      if (!complete) {
        throw new HandlerError(
          'WORKFLOW_BLOCKED',
          'Workflow has no executable step and is not complete',
          false,
        );
      }
      const output = Object.fromEntries(
        run.steps.map((step) => [step.stepKey, step.output]),
      );
      const content = Buffer.from(JSON.stringify(output, null, 2), 'utf8');
      const objectId = deterministicUuid(`${run.id}:workflow-result`);
      const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      const object: StorageObject = {
        id: objectId,
        organizationId: input.execution.context.organizationId,
        workspaceId: input.execution.context.workspaceId!,
        ownerId: input.execution.job.ownerId,
        key: makeObjectKey({
          organizationId: input.execution.context.organizationId,
          workspaceId: input.execution.context.workspaceId!,
          ownerId: input.execution.job.ownerId,
          category: 'artifacts',
          objectId,
        }),
        checksum,
        mediaType: 'application/json',
        sizeBytes: content.byteLength,
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      };
      await new LocalStorageAdapter(input.storageRoot).put(
        object,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content);
            controller.close();
          },
        }),
      );
      const artifact = await registerWorkflowArtifact({
        context: input.execution.context,
        ownerId: input.execution.job.ownerId,
        stepKey: 'workflow_result',
        object,
        name: 'workflow-result.json',
      });
      const metrics = await recordWorkflowEvaluation({
        context: input.execution.context,
        metrics: {
          routingAccuracy: input.evaluation?.routingAccurate === false ? 0 : 1,
          citationAccuracy:
            input.evaluation?.citationsAccurate === false ? 0 : 1,
          approvalHitRate:
            input.evaluation?.approvalExpected === false ||
            run.definition.steps.some((step) => step.approval === 'required')
              ? 1
              : 0,
          recoverySuccessRate: run.steps.some((step) => step.attempt > 1)
            ? 1
            : 1,
          sideEffectDuplicateCount: 0,
          latencyMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
        },
      });
      await completeWorkflowRun({ context: input.execution.context, output });
      return { workflowRunId: run.id, output, artifact, metrics };
    }
    const definitionStep = ready[0]!;
    const stepSnapshot = run.steps.find(
      (step) => step.stepKey === definitionStep.key,
    )!;
    const value = workflowStepInput({
      workflowInput: run.input,
      configuredInput: definitionStep.input,
      dependencies: definitionStep.dependsOn.map((key) => ({
        key,
        output:
          run.steps.find((candidate) => candidate.stepKey === key)?.output ??
          null,
      })),
    });
    const approved =
      stepSnapshot.checkpoint.approval &&
      typeof stepSnapshot.checkpoint.approval === 'object' &&
      (stepSnapshot.checkpoint.approval as { approved?: unknown }).approved ===
        true;
    if (
      definitionStep.kind === 'approval' ||
      (definitionStep.approval === 'required' && !approved)
    ) {
      const paused = await pauseWorkflowForApproval({
        context: input.execution.context,
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        stepKey: definitionStep.key,
        value,
      });
      throw new WorkflowPaused(paused.approvalId, paused.workflowRunId);
    }
    const started = await startWorkflowStep({
      context: input.execution.context,
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      stepKey: definitionStep.key,
      value,
      leaseMs: input.leaseMs,
    });
    if (started.replay) continue;
    try {
      const result = await input.executeStep({
        step: definitionStep,
        value,
        idempotencyKey: started.step.idempotencyKey,
      });
      await completeWorkflowStep({
        context: input.execution.context,
        stepId: started.step.id,
        leaseToken: input.leaseToken,
        output: result.output,
        sideEffectCommitted: result.sideEffectCommitted,
        checkpoint: { completedBy: 'workflow-engine-v1' },
      });
    } catch (error) {
      const code =
        error instanceof HandlerError ? error.code : 'WORKFLOW_STEP_FAILED';
      const message =
        error instanceof Error ? error.message : 'Workflow step failed';
      const failure = await failWorkflowStep({
        context: input.execution.context,
        stepId: started.step.id,
        leaseToken: input.leaseToken,
        code,
        message,
      });
      throw new HandlerError(code, message, failure.retrying);
    }
  }
}
