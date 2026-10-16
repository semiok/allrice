import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';
import {
  createRuntimeBridgeHttpHandler,
  type RuntimeBridgeLedgerPort,
} from './operation-http';

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
  const device = BridgeDeviceSchema.parse({
    id: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    name: 'budget HTTP test',
    platform: 'macos-x64',
    protocolVersion: 2,
    capabilities: ['local.fs.list'],
    status: 'online',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
  });
  const attempt = {
    operationId: randomUUID(),
    attemptId: randomUUID(),
    attemptNumber: 1,
    generation: 0,
    fence: 1,
  };
  const snapshot = {
    binding: {
      attempt,
      execution: { deviceId: device.id, targetKind: 'rice_bridge' },
    },
  } as RuntimeOperationSnapshot;
  const budget = startSandboxExecutionBudget(
    sandboxExecutionBudgetSpec(
      { version: 1, kind: 'compute' },
      resolveSandboxExecutionPolicy([]),
    ),
    Date.now(),
    Date.now() + 600000,
  );
  const exchange = vi.fn(async () => budget);
  const handler = createRuntimeBridgeHttpHandler({
    enabled: () => true,
    authenticate: async () => ({ device, grants: [] }),
    ledgerForDevice: async () =>
      ({
        readOperation: async () => snapshot,
        exchangeSandboxExecutionBudget: exchange,
      }) as unknown as RuntimeBridgeLedgerPort,
  });
  const body = { contractVersion: 1, attempt, leaseToken: randomUUID() };
  return {
    body,
    snapshot,
    exchange,
    budget,
    request: (patch: Record<string, unknown> = {}) =>
      handler(
        new Request('http://localhost/operations/budget', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer synthetic-token',
          },
          body: JSON.stringify({ ...body, ...patch }),
        }),
        'budget',
        attempt.operationId,
      ),
  };
}
it('binds the budget exchange to the authenticated device scope and original attempt', async () => {
  const f = fixture(),
    response = await f.request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ budget: f.budget });
  expect(f.exchange).toHaveBeenCalledWith(
    expect.objectContaining({
      ...f.body,
      operationId: f.body.attempt.operationId,
    }),
  );
});
it.each(['disabled', 'other-device', 'other-attempt', 'model-cap'])(
  'rejects %s before any authority mutation',
  async (mode) => {
    const f = fixture();
    if (mode === 'disabled')
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '0');
    if (mode === 'other-device')
      f.snapshot.binding.execution.deviceId = randomUUID();
    const patch =
      mode === 'other-attempt'
        ? { attempt: { ...f.body.attempt, attemptId: randomUUID() } }
        : mode === 'model-cap'
          ? { maxExecutionMs: 3600000 }
          : {};
    const response = await f.request(patch);
    expect(response.status).toBe(
      mode === 'disabled' || mode === 'other-device'
        ? 404
        : mode === 'other-attempt'
          ? 409
          : 400,
    );
    expect(f.exchange).not.toHaveBeenCalled();
  },
);
it.each([
  'SANDBOX_EXECUTION_DEADLINE',
  'SANDBOX_EXECUTION_NO_PROGRESS',
  'SANDBOX_EXECUTION_LIMIT',
  'SANDBOX_EXECUTION_RENEWAL_CONFLICT',
  'SANDBOX_EXECUTION_POLICY_CHANGED',
  'internal /secret/token',
])('classifies %s without leaking internal details', async (code) => {
  const f = fixture();
  f.exchange.mockRejectedValue(Error(code));
  const response = await f.request(),
    expected = code.startsWith('SANDBOX_') ? code : 'OPERATION_REQUEST_FAILED';
  expect(response.status).toBe(code.startsWith('SANDBOX_') ? 409 : 500);
  expect(await response.json()).toEqual({
    error: { code: expected, message: expected },
  });
});
