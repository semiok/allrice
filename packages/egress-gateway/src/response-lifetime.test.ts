import type * as Http from 'node:http';
import type { ServerResponse } from 'node:http';
import { createServer as freeServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createEgressGateway } from './gateway.ts';
import { admissionFixture } from './admission.fixture.ts';
import type { RequestContext } from '@allrice/contracts';
import type { GuestEgressAccess } from './contract.ts';

const hook = vi.hoisted(() => ({
  response: (_res: ServerResponse) => {
    void _res;
  },
}));
vi.mock('node:http', async (actual) => {
  const native = await actual<typeof Http>();
  return {
    ...native,
    createServer: (...args: Parameters<typeof native.createServer>) => {
      const server = native.createServer(...args);
      server.prependListener('request', (_req, res) => hook.response(res));
      return server;
    },
  };
});
it('keeps the read permit until its failed HTTP response actually drains', async () => {
  const server = freeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  let release!: () => void, entered!: () => void;
  const ending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let response!: ServerResponse;
  hook.response = (res) => {
    response = res;
    const native = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      release = () => {
        native(...args);
      };
      entered();
      return res;
    }) as typeof res.end;
  };
  const signal = new AbortController().signal;
  const binding = {
    vmId: 'vm',
    personId: 'person',
    organizationId: 'org',
    instanceId: 'instance',
    leaseEpoch: 1,
  };
  let access!: GuestEgressAccess;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const finish = vi.fn(async () => {
    expect(response.writableFinished).toBe(true);
    done();
  });
  const gateway = createEgressGateway({
    admission: { ...admissionFixture(), finish },
    vm: { assertAdmissionBinding: async () => {} },
    authority: {
      context: async () => ({}) as RequestContext,
      allow: async () => {},
    },
    transport: {
      read: async () => {
        throw Error('joined upstream failure');
      },
    },
    policy: {
      routes: [
        {
          id: 'read',
          path: '/read',
          origins: ['https://example.test'],
          target: () => new URL('https://example.test'),
          maxResponseBytes: 100,
          timeoutMs: 5000,
          validate: () => {},
        },
      ],
    },
    revokeModel: async () => {},
    provisioner: {
      endpoint: async () => ({
        host: '127.0.0.1',
        port,
        guestOrigin: `http://127.0.0.1:${port}`,
      }),
      install: async (_b, value) => {
        access = value;
      },
      remove: async () => {},
    },
  });
  const receipt = await gateway.prepare(binding, signal);
  try {
    const request = fetch(access.origin + '/read', {
      headers: { authorization: 'Bearer ' + access.capability },
    });
    await ending;
    expect(
      finish,
      'pending failed response must still own permit',
    ).not.toHaveBeenCalled();
    release();
    const result = await request;
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ code: 'UNAVAILABLE' });
    await finished;
    expect(finish).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await gateway.revoke(receipt, 'stop', signal);
    hook.response = () => {};
  }
});
