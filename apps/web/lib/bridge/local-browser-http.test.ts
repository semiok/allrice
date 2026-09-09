import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BridgeDeviceSchema } from '@allrice/contracts';
import { createLocalBrowserHttpHandler } from './local-browser-http.ts';
const device = BridgeDeviceSchema.parse({
  id: randomUUID(),
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
  name: 'Synthetic',
  platform: 'macos-arm64',
  protocolVersion: 2,
  capabilities: ['local.fs.list'],
  status: 'online',
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  revokedAt: null,
});
const identity = {
  workspaceId: randomUUID(),
  controllerLeaseToken: randomUUID(),
};
const make = () => {
  type Port = Parameters<typeof createLocalBrowserHttpHandler>[0];
  const port = {
    authenticate: vi.fn<Port['authenticate']>(async () => ({ device })),
    execute: vi.fn<Port['execute']>(async () => ({ ok: true })),
    capture: vi.fn<Port['capture']>(async () => ({ objectId: randomUUID() })),
  };
  return { port, handle: createLocalBrowserHttpHandler(port) };
};
const request = (body: unknown, token = true) =>
  new Request('https://rice.example.test/api/v1/bridge/browser-workspaces', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer synthetic-device-token' } : {}),
    },
    body: JSON.stringify(body),
  });
describe('P22 device browser HTTP envelope', () => {
  it('requires a device token, never a user cookie or body credential', async () => {
    const f = make();
    expect(
      (
        await f.handle(
          request(
            { kind: 'claim', controllerId: randomUUID(), acceptWork: true },
            false,
          ),
        )
      ).status,
    ).toBe(401);
    expect(f.port.authenticate).not.toHaveBeenCalled();
    expect(
      (
        await f.handle(
          request({
            kind: 'claim',
            controllerId: randomUUID(),
            acceptWork: true,
            jobLeaseToken: randomUUID(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(f.port.execute).not.toHaveBeenCalled();
  });
  it('allows exact claim with acceptWork=false so revocations can be drained while disabled', async () => {
    const f = make(),
      body = { kind: 'claim', controllerId: randomUUID(), acceptWork: false };
    f.port.execute.mockResolvedValue({
      lease: null,
      workspace: null,
      revocations: [],
    });
    const response = await f.handle(request(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(f.port.execute).toHaveBeenCalledWith(device, body);
  });
  it('rejects malformed or oversized bodies before reaching the authority', async () => {
    const f = make();
    const malformed = new Request('https://rice.example.test', {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic',
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect((await f.handle(malformed)).status).toBe(400);
    const large = new Request('https://rice.example.test', {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic',
        'content-type': 'application/json',
      },
      body: 'x'.repeat(300000),
    });
    expect((await f.handle(large)).status).toBe(413);
    expect(f.port.execute).not.toHaveBeenCalled();
  });
  it('accepts bounded exact screenshot metadata, not caller-selected object keys', async () => {
    const f = make(),
      metadata = {
        kind: 'screenshot',
        ...identity,
        fence: 1,
        observationId: randomUUID(),
      };
    const req = (body: unknown) =>
      new Request('https://rice.example.test/capture', {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic',
          'content-type': 'application/octet-stream',
          'x-allrice-browser-capture': Buffer.from(
            JSON.stringify(body),
          ).toString('base64url'),
        },
        body: Buffer.from('synthetic'),
      });
    expect(
      (await f.handle(req({ ...metadata, objectId: randomUUID() }), true))
        .status,
    ).toBe(400);
    expect((await f.handle(req(metadata), true)).status).toBe(200);
    expect(f.port.capture).toHaveBeenCalledTimes(1);
    expect(f.port.capture.mock.calls[0]![2]).toEqual(Buffer.alloc(9)); // transport zeroes private buffers after completion
  });
  it('one-use input returns only bounded binary and zeroes the source buffer', async () => {
    const f = make(),
      bytes = Buffer.from('synthetic-private-value');
    f.port.execute.mockResolvedValue(bytes);
    const response = await f.handle(
      request({
        kind: 'take_input',
        ...identity,
        operationId: randomUUID(),
        operationLeaseToken: randomUUID(),
        inputKind: 'private',
      }),
    );
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(await response.text()).toBe('synthetic-private-value');
    expect(bytes).toEqual(Buffer.alloc(bytes.length));
  });
  it('does not return raw exceptions or secrets, and never reports unknown writes as successful', async () => {
    const f = make();
    f.port.execute.mockRejectedValue(
      new Error('synthetic-secret-should-not-leak'),
    );
    const response = await f.handle(
      request({ kind: 'heartbeat', ...identity }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('synthetic-secret');
  });
});
