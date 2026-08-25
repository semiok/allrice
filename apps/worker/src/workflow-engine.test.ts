import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { readyWorkflowSteps, workflowStepInput } from './workflow-engine.js';

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

function step(key: string, status: 'pending' | 'succeeded') {
  return {
    id: randomUUID(),
    workflowRunId: randomUUID(),
    stepKey: key,
    name: key,
    kind: key === 'research' ? ('knowledge' as const) : ('approval' as const),
    status,
    attempt: status === 'succeeded' ? 1 : 0,
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
});
