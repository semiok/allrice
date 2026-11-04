import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type { ClaimedJobHandlerInput } from '../job-runner.js';

const ports = vi.hoisted(() => ({ resolve: vi.fn(), acquire: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveEmployeeExecution: ports.resolve,
  acquireConversationRuntime: ports.acquire,
}));
import { executeEmployeeRun } from './employee-run.js';

describe('retired queued employee Workflow invocation', () => {
  it('rejects before acquiring a native conversation, including an incomplete historical invocation', async () => {
    const snapshot = {
      schemaVersion: 2,
      workflowInvocation: { startId: randomUUID() },
    };
    ports.resolve.mockResolvedValue({ executionSnapshot: snapshot });
    const input = {
      execution: {
        payload: {
          type: 'allrice.employee.run',
          input: {
            employeeAssignmentId: randomUUID(),
            employeeVersionId: randomUUID(),
            sessionId: randomUUID(),
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
          },
        },
        context: {
          organizationId: randomUUID(),
          workspaceId: randomUUID(),
          runId: randomUUID(),
        },
        job: { ownerId: randomUUID() },
      },
    } as unknown as ClaimedJobHandlerInput;
    await expect(executeEmployeeRun(input)).rejects.toMatchObject({
      code: 'LEGACY_WORKFLOW_RETIRED',
      retryable: false,
    });
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(snapshot.workflowInvocation).toHaveProperty('startId');
  });
});
