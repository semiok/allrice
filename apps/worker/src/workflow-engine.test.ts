import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStepRun } from '@allrice/contracts';

const runtime = vi.hoisted(() => ({
  completeWorkflowRun: vi.fn(),
  completeWorkflowStep: vi.fn(),
  failWorkflowStep: vi.fn(),
  getWorkflowExecution: vi.fn(),
  pauseWorkflowForApproval: vi.fn(),
  recordWorkflowEvaluation: vi.fn(),
  registerWorkflowArtifact: vi.fn(),
  startWorkflowStep: vi.fn(),
  put: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@allrice/database', () => runtime);
vi.mock('@allrice/storage', () => ({
  LocalStorageAdapter: class {
    put = runtime.put;
  },
}));

import {
  executeDurableWorkflow,
  readyWorkflowSteps,
  workflowStepInput,
} from './workflow-engine.js';
import { HandlerError } from './errors.js';

const definition = {
  schemaVersion: 1 as const,
  inputSchema: {},
  outputSchema: {},
  failurePolicy: 'fail_fast' as const,
  recoveryPolicy: 'checkpoint' as const,
  steps: [
    {
      key: 'research',
      name: '检索资料',
      kind: 'knowledge' as const,
      dependsOn: [],
      input: {},
      timeoutMs: 10_000,
      maxAttempts: 2,
      approval: 'none' as const,
      sideEffect: 'none' as const,
      compensation: null,
    },
    {
      key: 'approve',
      name: '确认发布',
      kind: 'approval' as const,
      dependsOn: ['research'],
      input: {},
      timeoutMs: 10_000,
      maxAttempts: 1,
      approval: 'required' as const,
      sideEffect: 'none' as const,
      compensation: null,
    },
  ],
};

function step(key: string, status: WorkflowStepRun['status']) {
  return {
    id: randomUUID(),
    workflowRunId: randomUUID(),
    stepKey: key,
    name: key,
    kind: key === 'research' ? ('knowledge' as const) : ('approval' as const),
    status,
    attempt: status === 'pending' ? 0 : 1,
    maxAttempts: 2,
    inputDigest: null,
    outputDigest: status === 'succeeded' ? `sha256:${'a'.repeat(64)}` : null,
    output: null,
    idempotencyKey: `${randomUUID()}:${key}`,
    approvalId: null,
    sideEffectCommitted: false,
    checkpoint: {},
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
  };
}

describe('durable workflow planner', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects withdrawn context on resume before touching a remaining direct tool step', async () => {
    const executeStep = vi.fn();
    // The gate runs before loading or mutating Workflow rows, so existing
    // succeeded steps and their receipts are untouched on a refused resume.
    await expect(
      executeDurableWorkflow({
        checkContent: async () => {
          throw new HandlerError(
            'EMPLOYEE_CONTENT_UNAVAILABLE',
            'withdrawn',
            false,
          );
        },
        executeStep,
      } as unknown as Parameters<typeof executeDurableWorkflow>[0]),
    ).rejects.toMatchObject({
      code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
      retryable: false,
    });
    expect(executeStep).not.toHaveBeenCalled();
  });
  it('releases only steps whose dependencies are durably complete', () => {
    expect(
      readyWorkflowSteps(definition, [
        step('research', 'pending'),
        step('approve', 'pending'),
      ]).map((item) => item.key),
    ).toEqual(['research']);
    expect(
      readyWorkflowSteps(definition, [
        step('research', 'succeeded'),
        step('approve', 'pending'),
      ]).map((item) => item.key),
    ).toEqual(['approve']);
  });

  it('passes dependency digests instead of mutable hidden state', () => {
    expect(
      workflowStepInput({
        workflowInput: { topic: 'rice' },
        configuredInput: { format: 'brief' },
        dependencies: [{ key: 'research', output: 'sha256:evidence' }],
      }),
    ).toEqual({
      workflowInput: { topic: 'rice' },
      configured: { format: 'brief' },
      dependencies: { research: 'sha256:evidence' },
    });
  });

  it('offers an interrupted running step for lease-verified recovery without releasing its successor', () => {
    expect(
      readyWorkflowSteps(definition, [
        step('research', 'running'),
        step('approve', 'pending'),
      ]).map((item) => item.key),
    ).toEqual(['research']);
    // The planner never infers a completed dependency from an in-flight effect.
    expect(
      readyWorkflowSteps(definition, [
        step('research', 'needs_attention'),
        step('approve', 'pending'),
      ]),
    ).toEqual([]);
  });

  it('omits synthetic evaluation metrics when a business stage defers evaluation', async () => {
    const workflowId = randomUUID();
    runtime.getWorkflowExecution.mockResolvedValue({
      id: workflowId,
      status: 'running',
      definition,
      steps: [step('research', 'succeeded'), step('approve', 'succeeded')],
    });
    runtime.registerWorkflowArtifact.mockResolvedValue({ id: randomUUID() });
    const executeStep = vi.fn();
    const result = await executeDurableWorkflow({
      execution: {
        context: {
          organizationId: randomUUID(),
          workspaceId: randomUUID(),
          runId: randomUUID(),
        },
        job: { ownerId: randomUUID() },
      },
      workerId: randomUUID(),
      jobId: randomUUID(),
      leaseToken: randomUUID(),
      leaseMs: 30_000,
      storageRoot: '/unused-workflow-unit-storage',
      recordEvaluation: false,
      executeStep,
    } as unknown as Parameters<typeof executeDurableWorkflow>[0]);
    expect(result.metrics).toBeNull();
    expect(runtime.recordWorkflowEvaluation).not.toHaveBeenCalled();
    expect(runtime.completeWorkflowRun).toHaveBeenCalledOnce();
    expect(executeStep).not.toHaveBeenCalled();
  });
});
