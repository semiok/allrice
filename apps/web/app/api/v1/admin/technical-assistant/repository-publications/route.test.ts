import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, QueueError } from '@allrice/database';
import type * as Database from '@allrice/database';
// Legacy operation contracts remain covered; production pause is tested separately.
vi.mock(
  '../../../../../../lib/execution/platform-autonomy',
  async (original) => ({
    ...(await original<
      typeof import('../../../../../../lib/execution/platform-autonomy')
    >()),
    platformAutonomyPaused: () => false,
  }),
);
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createPlatformRepositoryAction: mocks.create,
  listPlatformRepositoryPublications: mocks.list,
  findPlatformRepositoryPublication: mocks.find,
}));
import { GET, POST } from './route';
const endpoint =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/repository-publications';
const write = (body: unknown, origin = 'https://admin.allrice.test') =>
  new Request(endpoint, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const input = () => ({
  action: 'publish',
  requestId: randomUUID(),
  repairTaskId: randomUUID(),
  credentialRevision: 1,
});
describe('repository publication API boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('rejects employees and foreign writes before enqueueing any job', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect((await GET(new Request(endpoint))).status).toBe(403);
    expect((await POST(write(input()))).status).toBe(403);
    expect((await POST(write(input(), 'https://foreign.test'))).status).toBe(
      403,
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('bounds streaming bytes and forbids arbitrary repository, branch, URL or token fields', async () => {
    mocks.auth.mockResolvedValue({});
    expect((await POST(write('a'.repeat(1025)))).status).toBe(413);
    expect((await POST(write('{'))).status).toBe(400);
    for (const extra of [
      { repository: 'foreign/project' },
      { branch: 'main' },
      { url: 'https://foreign.test' },
      { token: 'synthetic' },
    ])
      expect((await POST(write({ ...input(), ...extra }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('reconciles unknown writes by private reads, and never turns a rejected enqueue into success', async () => {
    mocks.auth.mockResolvedValue({});
    mocks.find.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
    const requestId = randomUUID(),
      r = await GET(new Request(endpoint + '?requestId=' + requestId));
    expect(await r.json()).toEqual({ publication: null });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.find).toHaveBeenCalledWith({}, requestId);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockRejectedValue(new QueueError('conflict'));
    expect((await POST(write(input()))).status).toBe(409);
    mocks.list.mockResolvedValue([{ token: 'SYNTHETIC_SECRET' }]);
    const invalid = await GET(new Request(endpoint));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('SYNTHETIC_SECRET');
  });
});
