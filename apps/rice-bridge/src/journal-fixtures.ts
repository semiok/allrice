import { createHash } from 'node:crypto';

import {
  RuntimeBridgeDispatchSchema,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';

import { bridgeDigest } from './journal.js';

export const fixtureId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function journalDispatch(root: string): RuntimeBridgeDispatch {
  const rootFingerprint = createHash('sha256').update(root).digest('hex');
  const digest = `sha256:${'a'.repeat(64)}`;
  const payload = {
    capability: 'local.fs.write',
    arguments: { path: 'output.txt', content: 'one execution' },
  };
  return RuntimeBridgeDispatchSchema.parse({
    contractVersion: 1,
    snapshot: {
      contractVersion: 1,
      binding: {
        task: {
          scope: {
            organizationId: fixtureId(1),
            workspaceId: fixtureId(2),
            projectId: null,
          },
          chatSessionId: fixtureId(3),
          runId: fixtureId(4),
          rootRunId: fixtureId(4),
          parentRunId: null,
          frozenConfiguration: { employeeVersionId: fixtureId(5), digest },
        },
        attempt: {
          operationId: fixtureId(6),
          attemptId: fixtureId(7),
          attemptNumber: 1,
          generation: 0,
          fence: 1,
        },
        requestedBy: { type: 'user', id: fixtureId(8) },
        policy: { snapshotId: fixtureId(9), digest },
        execution: {
          targetId: fixtureId(10),
          targetKind: 'rice_bridge',
          deviceId: fixtureId(11),
          grantId: fixtureId(12),
          grantVersion: 1,
          scopeDigest: `sha256:${rootFingerprint}`,
          workCopy: { id: fixtureId(13), kind: 'in_place' },
        },
        action: payload.capability,
        inputDigest: bridgeDigest(payload),
        dataScope: [],
        baseline: [],
        command: null,
      },
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: fixtureId(14),
      status: 'dispatched',
      result: null,
    },
    payload,
    leaseToken: fixtureId(15),
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    grantRootFingerprint: rootFingerprint,
  });
}
