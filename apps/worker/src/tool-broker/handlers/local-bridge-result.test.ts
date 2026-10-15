import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RiceToolHandlerContext } from '../types.js';
const ports = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@allrice/database', async (importOriginal) => {
  const { BridgeCommandResultError } =
    await importOriginal<typeof import('@allrice/database')>();
  return { dispatchBridgeCommand: ports.dispatch, BridgeCommandResultError };
});
import { BridgeCommandResultError } from '@allrice/database';
import { executeLocalBridgeTool } from './local.js';
import { HandlerError } from '../../errors.js';
function call(): RiceToolHandlerContext {
  const organizationId = randomUUID(),
    owner = randomUUID();
  return {
    input: {
      context: {
        executionId: randomUUID(),
        runId: randomUUID(),
        jobId: randomUUID(),
        worker: { type: 'worker', id: randomUUID() },
        delegatedBy: { type: 'user', id: owner },
        organizationId,
        workspaceId: randomUUID(),
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId,
          subjectId: owner,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          memberships: [],
          grants: [],
        },
      },
      call: {
        name: 'local.fs.list',
        id: 'synthetic-call',
        arguments: { path: '.', limit: 50 },
      },
      capabilities: [],
      storageRoot: '/unused',
    },
    arguments: { path: '.', limit: 50 },
  };
}
beforeEach(() => vi.resetAllMocks());
it.each([
  ['failed', 'GRANT_NOT_FOUND'],
  ['unknown', 'LOCAL_RESULT_UNKNOWN'],
  ['unknown', 'broker_wait_timeout'],
] as const)(
  'forwards %s / %s to the model without a generic broker error',
  async (status, code) => {
    ports.dispatch.mockRejectedValue(
      new BridgeCommandResultError(status, code),
    );
    const error = await executeLocalBridgeTool(call()).catch(
      (error: unknown) => error,
    );
    // The tool remains failed in the trace; DSH forwards this typed safe reason.
    expect(error).toBeInstanceOf(HandlerError);
    expect(error).toMatchObject({ code, retryable: false });
    expect((error as HandlerError).message).toContain(status);
    expect((error as HandlerError).message).toContain('不可自动重试');
    expect((error as HandlerError).message).not.toMatch(
      /broker request failed/i,
    );
  },
);
it('does not suppress unrelated policy or service errors', async () => {
  ports.dispatch.mockRejectedValue(Error('policy denied'));
  await expect(executeLocalBridgeTool(call())).rejects.toThrow('policy denied');
});
