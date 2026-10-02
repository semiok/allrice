import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TaskNextStepsInputSchema,
  TaskNextStepsSchema,
} from './task-next-steps.ts';

const input = {
  workspaceId: randomUUID(),
  sessionId: randomUUID(),
  employeeAssignmentId: randomUUID(),
  employeeVersionId: randomUUID(),
};
const step = {
  source: 'context-rule',
  task: {
    id: 'check-result',
    title: '检查已有成果',
    template: '检查已有成果。',
  },
  references: [],
};
const response = {
  contractVersion: 1,
  scope: {
    ...input,
    organizationId: randomUUID(),
    viewerId: randomUUID(),
    sourceRunId: randomUUID(),
    contextRevision: `sha256:${'a'.repeat(64)}`,
  },
  state: 'succeeded',
  readableArtifactCount: 0,
  notice: '',
  suggestions: [step],
};
describe('display-only next-step boundary', () => {
  it('requires complete scope and bounded unique actions, without execution or private runtime fields', () => {
    expect(TaskNextStepsSchema.parse(response)).toEqual(response);
    for (const patch of [
      { suggestions: Array(4).fill(step) },
      { suggestions: [step, step] },
      {
        suggestions: [
          {
            ...step,
            task: {
              ...step.task,
              requires: { toolNames: ['workspace.export.create'] },
            },
          },
        ],
      },
      { scope: { ...response.scope, sourceRunId: null } },
      { runtimePackage: {} },
    ])
      expect(
        TaskNextStepsSchema.safeParse({ ...response, ...patch }).success,
      ).toBe(false);
    expect(
      TaskNextStepsInputSchema.safeParse({ ...input, viewerId: randomUUID() })
        .success,
    ).toBe(false);
  });
});
