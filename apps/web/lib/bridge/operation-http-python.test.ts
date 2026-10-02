import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
} from '@allrice/contracts';
import {
  createRuntimeBridgeHttpHandler,
  type ManagedRuntimeGrant,
  type RuntimeBridgeLedgerPort,
} from './operation-http';

function fixture(
  action: 'local.python.execute' | 'local.pdf.read' = 'local.python.execute',
) {
  const device = BridgeDeviceSchema.parse({
    id: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    name: 'Test device',
    platform: 'macos-x64',
    protocolVersion: 2,
    capabilities: [action],
    status: 'online',
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });
  const grant: ManagedRuntimeGrant = {
    id: randomUUID(),
    deviceId: device.id,
    rootFingerprint: 'a'.repeat(64),
    runtimeGeneration: 2,
    revokedAt: null,
    profileVersion: 1,
  };
  const runId = randomUUID(),
    digest = `sha256:${'b'.repeat(64)}`;
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        projectId: null,
      },
      chatSessionId: randomUUID(),
      runId,
      rootRunId: runId,
      parentRunId: null,
      frozenConfiguration: { employeeVersionId: randomUUID(), digest },
    },
    attempt: {
      operationId: randomUUID(),
      attemptId: randomUUID(),
      attemptNumber: 1,
      generation: 0,
      fence: 1,
    },
    requestedBy: { type: 'user', id: device.ownerId },
    policy: { snapshotId: randomUUID(), digest },
    execution: {
      targetId: randomUUID(),
      targetKind: 'rice_bridge',
      deviceId: device.id,
      grantId: grant.id,
      grantVersion: grant.runtimeGeneration,
      scopeDigest: digest,
      workCopy: { id: randomUUID(), kind: 'local_copy' },
    },
    action,
    inputDigest: digest,
    dataScope: [],
    baseline: [],
    command: null,
  });
  const snapshot = RuntimeOperationSnapshotSchema.parse({
    contractVersion: 1,
    binding,
    stepId: null,
    agentInstanceId: null,
    processId: null,
    cancelRequestId: null,
    idempotencyKey: randomUUID(),
    status: 'planned',
    result: null,
  });
  return { device, grant, snapshot };
}

describe('managed runtime HTTP boundary', () => {
  it.each([undefined, false, true, 'true', 1])(
    'accepts only explicit boolean managed-Python support: %s',
    async (support) => {
      const f = fixture(),
        claim = vi.fn(async () => null);
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async () => ({
          device: f.device,
          grants: [],
          managedRuntimeGrant: f.grant,
        }),
        ledgerForDevice: async () =>
          ({
            claimNextBridgeOperation: claim,
          }) as unknown as RuntimeBridgeLedgerPort,
      });
      const response = await handler(
        new Request('http://localhost/operations/next', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            support === undefined ? {} : { supportsManagedPython: support },
          ),
        }),
        'next',
      );
      if (support !== undefined && typeof support !== 'boolean') {
        expect(response.status).toBe(400);
        expect(claim).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
        expect(claim).toHaveBeenCalledWith(
          expect.objectContaining({ supportsManagedPython: support === true }),
        );
      }
    },
  );
  it.each([
    'valid',
    'missing',
    'revoked',
    'other-device',
    'old-generation',
    'folder-action',
    'wrong-runtime-kind',
  ] as const)(
    'rechecks distinct managed grants at physical start: %s',
    async (mode) => {
      const f = fixture();
      let grant: ManagedRuntimeGrant | null = f.grant;
      if (mode === 'missing') grant = null;
      if (mode === 'revoked')
        grant = { ...f.grant, revokedAt: new Date().toISOString() };
      if (mode === 'other-device')
        grant = { ...f.grant, deviceId: randomUUID() };
      if (mode === 'old-generation')
        grant = { ...f.grant, runtimeGeneration: 1 };
      if (mode === 'folder-action')
        f.snapshot.binding.action = 'local.fs.write';
      if (mode === 'wrong-runtime-kind')
        f.snapshot.binding.action = 'local.pdf.read';
      const start = vi.fn(async () => ({
        snapshot: f.snapshot,
        mayExecute: true,
      }));
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async () => ({
          device: f.device,
          grants: [],
          managedRuntimeGrant: grant,
        }),
        ledgerForDevice: async () =>
          ({
            readOperation: async () => f.snapshot,
            startOperation: start,
          }) as unknown as RuntimeBridgeLedgerPort,
      });
      const response = await handler(
        new Request('http://localhost/operations/start', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contractVersion: 1,
            attempt: f.snapshot.binding.attempt,
            leaseToken: randomUUID(),
            receiptId: randomUUID(),
          }),
        }),
        'start',
        f.snapshot.binding.attempt.operationId,
      );
      expect(response.status).toBe(mode === 'valid' ? 200 : 403);
      if (mode === 'valid') expect(start).toHaveBeenCalledOnce();
      else expect(start).not.toHaveBeenCalled();
    },
  );
});

describe('independent read-only PDF HTTP dispatch', () => {
  it.each([undefined, false, true, 'true', 1])(
    'requires explicit boolean PDF support: %s',
    async (support) => {
      const f = fixture('local.pdf.read'),
        claim = vi.fn(async () => null);
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async () => ({
          device: f.device,
          grants: [],
          pdfRuntimeGrant: f.grant,
        }),
        ledgerForDevice: async () =>
          ({
            claimNextBridgeOperation: claim,
          }) as unknown as RuntimeBridgeLedgerPort,
      });
      const response = await handler(
        new Request('http://localhost/operations/next', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            support === undefined ? {} : { supportsPdfRead: support },
          ),
        }),
        'next',
      );
      if (support !== undefined && typeof support !== 'boolean') {
        expect(response.status).toBe(400);
        expect(claim).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(200);
        expect(claim).toHaveBeenCalledWith(
          expect.objectContaining({
            supportsPdfRead: support === true,
            supportsManagedPython: false,
          }),
        );
      }
    },
  );
  it.each([
    'valid',
    'missing',
    'revoked',
    'other-device',
    'old-generation',
    'python-grant-only',
  ] as const)(
    'rechecks only the PDF runtime grant at start: %s',
    async (mode) => {
      const f = fixture('local.pdf.read');
      let pdf: ManagedRuntimeGrant | null = f.grant;
      if (mode === 'missing' || mode === 'python-grant-only') pdf = null;
      if (mode === 'revoked')
        pdf = { ...f.grant, revokedAt: new Date().toISOString() };
      if (mode === 'other-device') pdf = { ...f.grant, deviceId: randomUUID() };
      if (mode === 'old-generation') pdf = { ...f.grant, runtimeGeneration: 1 };
      const start = vi.fn(async () => ({
        snapshot: f.snapshot,
        mayExecute: true,
      }));
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async () => ({
          device: f.device,
          grants: [],
          pdfRuntimeGrant: pdf,
          managedRuntimeGrant: mode === 'python-grant-only' ? f.grant : null,
        }),
        ledgerForDevice: async () =>
          ({
            readOperation: async () => f.snapshot,
            startOperation: start,
          }) as unknown as RuntimeBridgeLedgerPort,
      });
      const response = await handler(
        new Request('http://localhost/operations/start', {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contractVersion: 1,
            attempt: f.snapshot.binding.attempt,
            leaseToken: randomUUID(),
            receiptId: randomUUID(),
          }),
        }),
        'start',
        f.snapshot.binding.attempt.operationId,
      );
      expect(response.status).toBe(mode === 'valid' ? 200 : 403);
      if (mode === 'valid') expect(start).toHaveBeenCalledOnce();
      else expect(start).not.toHaveBeenCalled();
    },
  );
});
