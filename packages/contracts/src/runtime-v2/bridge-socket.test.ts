import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  BridgeSocketRequestSchema,
  bridgeSocketOperationPath,
} from './bridge-socket.ts';

describe('Bridge socket transport contract', () => {
  const request = {
    version: 1,
    type: 'request',
    id: randomUUID(),
    action: 'operation.next',
    body: {},
  };
  it('maps only enumerated actions to fixed paths', () => {
    expect(
      bridgeSocketOperationPath(BridgeSocketRequestSchema.parse(request)),
    ).toBe('/api/v1/bridge/device/operations/next');
    const operationId = randomUUID();
    expect(
      bridgeSocketOperationPath(
        BridgeSocketRequestSchema.parse({
          ...request,
          action: 'operation.output',
          operationId,
        }),
      ),
    ).toBe(`/api/v1/bridge/device/operations/${operationId}/output`);
  });
  it.each([
    { url: 'https://other.example' },
    { action: 'proxy' },
    { action: 'operation.start' },
    { operationId: randomUUID() },
    { version: 2 },
    { headers: { authorization: 'secret' } },
  ])('rejects arbitrary routing, version and scope: %j', (patch) => {
    expect(
      BridgeSocketRequestSchema.safeParse({ ...request, ...patch }).success,
    ).toBe(false);
  });
});
