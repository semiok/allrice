import { createHash } from 'node:crypto';

import {
  RuntimeBridgeDispatchSchema,
  RuntimeBridgeReceiptSchema,
  RuntimeBridgeStartSchema,
  RuntimeBridgeHeartbeatSchema,
  RuntimeBridgeOutputSchema,
  UuidSchema,
  canonicalRuntimeBridgeJson,
  runtimeContractEqual,
  type BridgeDevice,
  type BridgeFolderGrant,
  type RuntimeBridgePayload,
  type RuntimeBridgeReceipt,
  type RuntimeOperationSnapshot,
  type RuntimeScope,
} from '@allrice/contracts';

import { getBridgeDeviceToken } from './request.ts';

type Snapshot = RuntimeOperationSnapshot;
type Scope = RuntimeScope;
const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    ...init,
    headers: { ...init?.headers, 'Cache-Control': 'private, no-store' },
  });

/** Structural port implemented by the PostgreSQL ledger; not another authority. */
export interface RuntimeBridgeLedgerPort {
  claimNextBridgeOperation(input: {
    scope: Scope;
    deviceId: string;
    leaseMs: number;
    supportsLocalCommand?: boolean;
  }): Promise<{
    snapshot: Snapshot;
    leaseToken: string;
    leaseExpiresAt: string;
    bridgePayload: RuntimeBridgePayload | null;
  } | null>;
  readOperation(scope: Scope, id: string): Promise<Snapshot>;
  heartbeat?(input: {
    scope: Scope;
    operationId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<{ snapshot: Snapshot; leaseExpiresAt: string }>;
  recordOutput?(input: {
    scope: Scope;
    operationId: string;
    leaseToken: string;
    attempt: RuntimeBridgeReceipt['attempt'];
    sequence: number;
    stream: 'stdout' | 'stderr';
    content: string;
  }): Promise<void>;
  startOperation(input: {
    scope: Scope;
    operationId: string;
    leaseToken: string;
    receiptId: string;
    attempt: RuntimeBridgeReceipt['attempt'];
  }): Promise<{ snapshot: Snapshot; mayExecute: boolean }>;
  recordReceipt(
    input: RuntimeBridgeReceipt & { scope: Scope; operationId: string },
  ): Promise<{
    snapshot: Snapshot;
    disposition: 'applied' | 'duplicate' | 'stale' | 'conflict';
  }>;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function boundedJson(request: Request, maximum = 550_000) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new HttpProblem(415, 'JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpProblem(400, 'BODY_REQUIRED');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new HttpProblem(413, 'BODY_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createRuntimeBridgeHttpHandler(input: {
  enabled: () => boolean;
  authenticate: (
    token: string,
  ) => Promise<{ device: BridgeDevice; grants: BridgeFolderGrant[] }>;
  // Must include current admission. Do not construct a permissive production ledger.
  ledgerForDevice: (device: BridgeDevice) => Promise<RuntimeBridgeLedgerPort>;
}) {
  return async (
    request: Request,
    action: 'next' | 'start' | 'receipts' | 'heartbeat' | 'output',
    operationId?: string,
  ) => {
    try {
      if (!input.enabled()) throw new HttpProblem(404, 'FEATURE_DISABLED');
      const token = getBridgeDeviceToken(request);
      if (!token) throw new HttpProblem(401, 'DEVICE_UNAUTHORIZED');
      const { device, grants } = await input.authenticate(token);
      if (device.revokedAt || device.status === 'revoked')
        throw new HttpProblem(401, 'DEVICE_UNAUTHORIZED');
      // B1 accepts only workspace-scoped (projectId=null) operations. A future
      // project adapter must resolve membership rather than trusting client IDs.
      const scope: Scope = {
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        projectId: null,
      };
      const ledger = await input.ledgerForDevice(device);
      if (action === 'next') {
        const selection = request.body
          ? ((await boundedJson(request, 1024)) as Record<string, unknown>)
          : {};
        if (
          !selection ||
          typeof selection !== 'object' ||
          Array.isArray(selection) ||
          Object.keys(selection).some(
            (key) => key !== 'supportsLocalCommand',
          ) ||
          ('supportsLocalCommand' in selection &&
            typeof selection.supportsLocalCommand !== 'boolean')
        )
          throw new HttpProblem(400, 'INVALID_REQUEST');
        const lease = await ledger.claimNextBridgeOperation({
          scope,
          deviceId: device.id,
          leaseMs: 120_000,
          supportsLocalCommand: selection.supportsLocalCommand === true,
        });
        if (!lease) return json({ dispatch: null });
        const grant = grants.find(
          (item) =>
            item.id === lease.snapshot.binding.execution.grantId &&
            !item.revokedAt &&
            item.deviceId === device.id,
        );
        if (
          !grant ||
          lease.snapshot.binding.execution.deviceId !== device.id ||
          !lease.bridgePayload
        )
          throw new HttpProblem(409, 'DISPATCH_SCOPE_MISMATCH');
        return json({
          dispatch: RuntimeBridgeDispatchSchema.parse({
            contractVersion: 1,
            snapshot: lease.snapshot,
            payload: lease.bridgePayload,
            leaseToken: lease.leaseToken,
            leaseExpiresAt: lease.leaseExpiresAt,
            grantRootFingerprint: grant.rootFingerprint,
          }),
        });
      }
      const id = UuidSchema.parse(operationId);
      const snapshot = await ledger.readOperation(scope, id);
      if (
        snapshot.binding.execution.deviceId !== device.id ||
        snapshot.binding.execution.targetKind !== 'rice_bridge'
      )
        throw new HttpProblem(404, 'OPERATION_UNAVAILABLE');
      if (action === 'start') {
        const grant = grants.find(
          (item) =>
            item.id === snapshot.binding.execution.grantId &&
            !item.revokedAt &&
            item.deviceId === device.id,
        );
        if (!grant) throw new HttpProblem(403, 'GRANT_REVOKED');
        const body = RuntimeBridgeStartSchema.parse(
          await boundedJson(request, 16_384),
        );
        if (body.attempt.operationId !== id)
          throw new HttpProblem(409, 'OPERATION_MISMATCH');
        return json(
          await ledger.startOperation({
            scope,
            operationId: id,
            leaseToken: body.leaseToken,
            attempt: body.attempt,
            receiptId: body.receiptId,
          }),
        );
      }
      if (action === 'heartbeat' || action === 'output') {
        const body = (
          action === 'heartbeat'
            ? RuntimeBridgeHeartbeatSchema
            : RuntimeBridgeOutputSchema
        ).parse(await boundedJson(request, 100_000));
        if (
          body.attempt.operationId !== id ||
          !runtimeContractEqual(body.attempt, snapshot.binding.attempt)
        )
          throw new HttpProblem(409, 'OPERATION_MISMATCH');
        if (action === 'heartbeat') {
          if (!ledger.heartbeat) throw new HttpProblem(404, 'FEATURE_DISABLED');
          return json(
            await ledger.heartbeat({
              scope,
              operationId: id,
              leaseToken: body.leaseToken,
              leaseMs: 120_000,
            }),
          );
        }
        if (!ledger.recordOutput)
          throw new HttpProblem(404, 'FEATURE_DISABLED');
        await ledger.recordOutput({
          ...RuntimeBridgeOutputSchema.parse(body),
          scope,
          operationId: id,
        });
        return json({ accepted: true });
      }
      const receipt = RuntimeBridgeReceiptSchema.parse(
        await boundedJson(request),
      );
      if (receipt.attempt.operationId !== id)
        throw new HttpProblem(409, 'OPERATION_MISMATCH');
      const evidenceRef =
        receipt.signal.type === 'operation.outcome'
          ? receipt.signal.result.evidence
          : receipt.signal.type === 'operation.stopped'
            ? receipt.signal.evidence
            : null;
      if (
        evidenceRef &&
        evidenceRef.digest !==
          `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(receipt.evidence)).digest('hex')}`
      ) {
        throw new HttpProblem(409, 'EVIDENCE_DIGEST_MISMATCH');
      }
      const result = await ledger.recordReceipt({
        ...receipt,
        scope,
        operationId: id,
      });
      // Stale/conflicting evidence remains on the server for reconciliation;
      // do not ACK it as current acceptance or discard its device outbox copy.
      if (!['applied', 'duplicate'].includes(result.disposition))
        throw new HttpProblem(409, 'RECEIPT_RECONCILIATION_REQUIRED');
      return json({ receiptId: receipt.receiptId, accepted: true });
    } catch (error) {
      let status = 500;
      let code = 'OPERATION_REQUEST_FAILED';
      if (error instanceof HttpProblem) {
        status = error.status;
        code = error.code;
      } else if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === 'ZodError')
      ) {
        status = 400;
        code = 'INVALID_REQUEST';
      } else if (error && typeof error === 'object' && 'code' in error) {
        const reason = String(error.code);
        if (reason === 'device_unauthorized') {
          status = 401;
          code = 'DEVICE_UNAUTHORIZED';
        } else if (['scope_mismatch', 'unavailable'].includes(reason)) {
          status = 404;
          code = 'OPERATION_UNAVAILABLE';
        } else if (
          [
            'lease_lost',
            'invalid_state',
            'receipt_conflict',
            'root_canceled',
            'deadline_exceeded',
          ].includes(reason)
        ) {
          status = 409;
          code = 'OPERATION_CONFLICT';
        }
      }
      // Never expose database errors, credential strings or absolute local paths.
      return json({ error: { code, message: code } }, { status });
    }
  };
}
