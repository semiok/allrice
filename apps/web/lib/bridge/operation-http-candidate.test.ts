import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { BridgeDeviceSchema } from '@allrice/contracts';
import {
  createRuntimeBridgeHttpHandler,
  type RuntimeBridgeLedgerPort,
} from './operation-http';

it.each([undefined, false, true, 'true'])(
  'requires explicit boolean candidate support on HTTP claim: %s',
  async (support) => {
    const claim = vi.fn(async () => null);
    const device = BridgeDeviceSchema.parse({
      id: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      name: 'Synthetic HTTP device',
      platform: 'macos-x64',
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    const handler = createRuntimeBridgeHttpHandler({
      enabled: () => true,
      authenticate: async () => ({ device, grants: [] }),
      ledgerForDevice: async () =>
        ({
          claimNextBridgeOperation: claim,
        }) as unknown as RuntimeBridgeLedgerPort,
    });
    const response = await handler(
      new Request('http://localhost/operations/next', {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          supportsLocalCommand: true,
          ...(support === undefined
            ? {}
            : { supportsChangesetCandidate: support }),
        }),
      }),
      'next',
    );
    if (typeof support === 'string') {
      expect(response.status).toBe(400);
      expect(claim).not.toHaveBeenCalled();
    } else {
      expect(response.ok).toBe(true);
      expect(claim).toHaveBeenCalledWith(
        expect.objectContaining({
          supportsChangesetCandidate: support === true,
        }),
      );
    }
  },
);
