import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  application: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  requireRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listEmployeeInstanceModules: ports.list,
  readApplicationBuiltinModules: ports.application,
}));
import { GET } from './route';

const context: RequestContext = {
  requestId: randomUUID(),
  sessionId: randomUUID(),
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const instanceId = randomUUID();
const legacy = {
  modules: [
    {
      descriptor: { id: 'existing-brand-module' },
      binding: null,
      available: true,
      enabled: false,
    },
  ],
};
const application = {
  schemaVersion: 1,
  policy: 'all-enabled',
  applicationBuild: null,
  builtinModules: {
    deliverables: true,
    'enterprise-materials': true,
    'employee-memory': true,
    capabilities: true,
  },
};
const request = (signal?: AbortSignal) =>
  new Request(
    `https://allrice.test/api/v1/employee-instances/${instanceId}/modules?workspaceId=${context.workspaceId}&enabled=false&sourceSha=browser-claim`,
    { signal },
  );
const route = () => ({ params: Promise.resolve({ id: instanceId }) });

beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue(context);
  ports.list.mockResolvedValue(legacy);
  ports.application.mockResolvedValue(application);
});
afterEach(() => vi.restoreAllMocks());

describe('current employee module management application source', () => {
  it('preserves all existing modules and adds only the trusted application policy under original current scope', async () => {
    const incoming = request(),
      response = await GET(incoming, route());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      ...legacy,
      applicationModules: application,
    });
    expect(ports.context).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(ports.application).toHaveBeenCalledExactlyOnceWith('web');
    expect(ports.list).toHaveBeenCalledTimes(2);
    for (const call of ports.list.mock.calls)
      expect(call).toEqual([
        context,
        { workspaceId: context.workspaceId, instanceId },
      ]);
    // Browser flags do not alter application policy, create old bindings or
    // fabricate B/config/native owners; the unchanged owner reads still guard.
    expect(ports.list.mock.invocationCallOrder[0]).toBeLessThan(
      ports.application.mock.invocationCallOrder[0]!,
    );
    expect(ports.application.mock.invocationCallOrder[0]).toBeLessThan(
      ports.list.mock.invocationCallOrder[1]!,
    );
  });

  it.each([
    'authentication_required',
    'authorization_denied',
    'not_found',
  ] as const)(
    'keeps the original %s denial before reading application metadata',
    async (code) => {
      if (code === 'authentication_required')
        ports.context.mockRejectedValueOnce(new DataAccessError(code));
      else ports.list.mockRejectedValueOnce(new DataAccessError(code));
      const response = await GET(request(), route());
      expect(response.status).toBe(
        code === 'authentication_required'
          ? 401
          : code === 'not_found'
            ? 404
            : 403,
      );
      expect(ports.application).not.toHaveBeenCalled();
    },
  );

  it('refuses authority withdrawn during the application read instead of returning an earlier module list', async () => {
    const denied = new DataAccessError('authorization_denied');
    ports.list.mockResolvedValueOnce(legacy).mockRejectedValueOnce(denied);
    const response = await GET(request(), route());
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('applicationModules');
    expect(ports.list).toHaveBeenCalledTimes(2);
  });

  it('propagates invalid build metadata without falling back to legacy bindings or a forged browser release', async () => {
    ports.application.mockRejectedValueOnce(
      Error('invalid application build seal'),
    );
    const response = await GET(request(), route());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('applicationModules');
    expect(ports.list).toHaveBeenCalledTimes(1);
  });

  it('joins actual pending policy work after cancellation and discards the result before another owner read', async () => {
    let entered!: () => void, finish!: (value: typeof application) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ports.application.mockImplementationOnce(() => {
      entered();
      return new Promise<typeof application>((resolve) => {
        finish = resolve;
      });
    });
    const stop = new AbortController();
    let settled = false;
    const outcome = GET(request(stop.signal), route()).finally(() => {
      settled = true;
    });
    try {
      await started;
      stop.abort(Error('management reader cancelled'));
      await turn();
      expect(settled).toBe(false);
      finish(application);
      const response = await outcome;
      expect(response.status).not.toBe(200);
      expect(await response.json()).not.toHaveProperty('applicationModules');
      expect(ports.list).toHaveBeenCalledTimes(1);
    } finally {
      finish(application);
      await outcome;
    }
  });
});
