import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TaskNextStepsSchema } from '@allrice/contracts';
import { taskNextStepsMatchScope } from './task-next-steps';

describe('next-step scope checks before rendering', () => {
  it('invalidates every account, company, workspace, employee, version and Session boundary', () => {
    const scope = {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      viewerId: randomUUID(),
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId: randomUUID(),
    };
    const data = TaskNextStepsSchema.parse({
      contractVersion: 1,
      scope: {
        ...scope,
        sourceRunId: null,
        contextRevision: `sha256:${'a'.repeat(64)}`,
      },
      state: 'idle',
      readableArtifactCount: 0,
      notice: '',
      suggestions: [],
    });
    expect(taskNextStepsMatchScope(data, scope)).toBe(true);
    for (const key of Object.keys(scope) as (keyof typeof scope)[])
      expect(
        taskNextStepsMatchScope(data, { ...scope, [key]: randomUUID() }),
      ).toBe(false);
  });
});
