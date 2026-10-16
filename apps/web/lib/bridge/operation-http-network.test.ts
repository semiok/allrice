import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  SandboxNetworkLeaseSchema,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';
import {
  createRuntimeBridgeHttpHandler,
  type RuntimeBridgeLedgerPort,
} from './operation-http';
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
  const device = BridgeDeviceSchema.parse({
    id: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    name: 'Synthetic network',
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
  const lease = SandboxNetworkLeaseSchema.parse({
    version: 1,
    organizationId: device.organizationId,
    workspaceId: device.workspaceId,
    ownerId: device.ownerId,
    runId: randomUUID(),
    operationId: attempt.operationId,
    attemptId: attempt.attemptId,
    target: { kind: 'bridge', targetId: randomUUID(), deviceId: device.id },
    policyDigest: 'sha256:' + 'a'.repeat(64),
    grantId: randomUUID(),
    grantVersion: 1,
    network: { mode: 'controlled_https', origins: ['https://pypi.org'] },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maximumConnections: 8,
    maximumBytes: 100000,
  });
  const exchange = vi.fn(async () => lease),
    body = { contractVersion: 1, attempt, leaseToken: randomUUID() };
  const handler = createRuntimeBridgeHttpHandler({
    enabled: () => true,
    authenticate: async () => ({ device, grants: [] }),
    ledgerForDevice: async () =>
      ({
        readOperation: async () => snapshot,
        sandboxNetworkLease: exchange,
      }) as unknown as RuntimeBridgeLedgerPort,
  });
  const request = (patch: Record<string, unknown> = {}) =>
    handler(
      new Request('http://localhost/operations/network', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer synthetic-token',
        },
        body: JSON.stringify({ ...body, ...patch }),
      }),
      'network',
      attempt.operationId,
    );
  return { request, snapshot, exchange, lease, body };
}
it('returns only the authority-owned lease after exact device and attempt checks', async () => {
  const f = fixture(),
    response = await f.request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ lease: f.lease });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(f.exchange).toHaveBeenCalledWith(
    expect.objectContaining({
      ...f.body,
      operationId: f.body.attempt.operationId,
    }),
  );
});
it.each([
  'disabled',
  'other-device',
  'other-attempt',
  'injected-grant',
  'oversize',
])('rejects %s without issuing a lease', async (mode) => {
  const f = fixture();
  if (mode === 'disabled') vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '0');
  if (mode === 'other-device')
    f.snapshot.binding.execution.deviceId = randomUUID();
  const response = await f.request(
    mode === 'other-attempt'
      ? { attempt: { ...f.body.attempt, attemptId: randomUUID() } }
      : mode === 'injected-grant'
        ? { network: f.lease.network }
        : mode === 'oversize'
          ? { text: 'x'.repeat(17000) }
          : {},
  );
  expect(response.status).toBe(
    mode === 'disabled' || mode === 'other-device'
      ? 404
      : mode === 'other-attempt'
        ? 409
        : mode === 'oversize'
          ? 413
          : 400,
  );
  expect(f.exchange).not.toHaveBeenCalled();
});
