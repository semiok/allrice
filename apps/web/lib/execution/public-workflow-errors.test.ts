import { describe, expect, it } from 'vitest';
import { WorkflowRunSchema } from '@allrice/contracts';
import { publicWorkflowRun } from './public-workflow-errors';
const id = '11111111-1111-4111-8111-111111111111';
const run = WorkflowRunSchema.parse({
  id,
  runId: id,
  organizationId: id,
  workspaceId: id,
  ownerId: id,
  employeeId: id,
  workflowRevisionId: id,
  sessionId: null,
  status: 'failed',
  definition: {
    schemaVersion: 1,
    steps: [{ key: 'load', name: 'Read', kind: 'tool', input: {} }],
  },
  input: { errorMessage: 'business input' },
  output: { code: 'BUSINESS', message: 'business output' },
  currentStepKey: 'load',
  checkpoint: { message: 'business checkpoint' },
  steps: [
    {
      id,
      workflowRunId: id,
      stepKey: 'load',
      name: 'Read',
      kind: 'tool',
      status: 'failed',
      attempt: 1,
      maxAttempts: 1,
      inputDigest: null,
      outputDigest: null,
      output: { errorMessage: 'business output' },
      idempotencyKey: 'fixed',
      approvalId: null,
      sideEffectCommitted: false,
      checkpoint: {},
      errorCode: 'DSH_PI_AI_ERROR',
      errorMessage: 'Your authentication token has expired sk-private',
      startedAt: null,
      completedAt: null,
    },
  ],
  createdAt: '2026-11-03T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
});
describe('public Workflow error DTO only', () => {
  it('hides the known model error slot and preserves all workflow/business data', () => {
    const result = publicWorkflowRun(run);
    expect(result.steps[0]?.errorMessage).toContain('授权失效');
    expect(JSON.stringify(result)).not.toMatch(
      /authentication token has expired|sk-private/,
    );
    expect({ ...result, steps: [] }).toEqual({ ...run, steps: [] });
    expect({ ...result.steps[0], errorMessage: null }).toEqual({
      ...run.steps[0],
      errorMessage: null,
    });
  });
  it('does not classify an unproven DSH error or alter a non-model business error', () => {
    for (const code of [
      'DSH_UNKNOWN',
      'DSH_TURN_FAILED',
      'DSH_NEW_CODE',
      'BUSINESS_NOT_FOUND',
    ]) {
      const result = publicWorkflowRun({
        ...run,
        steps: [
          {
            ...run.steps[0]!,
            errorCode: code,
            errorMessage: 'Original business error',
          },
        ],
      });
      if (code === 'BUSINESS_NOT_FOUND')
        expect(result.steps[0]?.errorMessage).toBe('Original business error');
      else {
        expect(result.steps[0]?.errorMessage).not.toContain(
          'Original business error',
        );
        expect(result.steps[0]?.errorMessage).not.toContain('模型服务返回');
      }
    }
  });
});
