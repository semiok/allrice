import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, QueueError } from '@allrice/database';
import type * as Database from '@allrice/database';
import type * as AutonomyPolicy from '../../../../../../lib/execution/platform-autonomy';
// Legacy operation contracts remain covered; production pause is tested separately.
vi.mock(
  '../../../../../../lib/execution/platform-autonomy',
  async (original) => ({
    ...(await original<typeof AutonomyPolicy>()),
    platformAutonomyPaused: () => false,
  }),
);
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  panel: vi.fn(),
  credential: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createPlatformRepositoryMerge: mocks.create,
  findPlatformRepositoryMerge: mocks.find,
  getPlatformRepositoryMergePanel: mocks.panel,
  getPlatformRepositoryCredential: mocks.credential,
  getPlatformRepositoryMerge: mocks.get,
  cancelPlatformRepositoryMerge: mocks.cancel,
}));
import { GET, POST } from './route';
import { GET as detail, DELETE as stop } from './[id]/route';
const endpoint =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/repository-merges';
const request = () => ({
  action: 'merge',
  requestId: randomUUID(),
  reviewSubjectId: randomUUID(),
  publicationId: randomUUID(),
  expectedSubjectDigest: 'sha256:' + 'a'.repeat(64),
  credentialRevision: 1,
});
const write = (body: unknown, origin = 'https://admin.allrice.test') =>
  new Request(endpoint, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
describe('private repository merge API boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('denies employees and foreign writes before any side effect', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    const id = randomUUID(),
      p = { params: Promise.resolve({ id }) };
    expect(
      (await GET(new Request(endpoint + '?publicationId=' + id))).status,
    ).toBe(403);
    expect((await POST(write(request()))).status).toBe(403);
    expect((await POST(write(request(), 'https://foreign.test'))).status).toBe(
      403,
    );
    expect((await detail(new Request(endpoint + '/' + id), p)).status).toBe(
      403,
    );
    expect(
      (
        await stop(
          new Request(endpoint + '/' + id, {
            method: 'DELETE',
            headers: { origin: 'https://foreign.test' },
          }),
          p,
        )
      ).status,
    ).toBe(403);
    for (const fn of [mocks.create, mocks.panel, mocks.get, mocks.cancel])
      expect(fn).not.toHaveBeenCalled();
  });
  it('bounds streaming input and rejects browser-supplied caller, evidence, token, repository and execution parameters', async () => {
    mocks.auth.mockResolvedValue({});
    expect((await POST(write('x'.repeat(1025)))).status).toBe(400);
    expect((await POST(write('{'))).status).toBe(400);
    for (const extra of [
      { token: 'synthetic' },
      { repository: 'foreign/project' },
      { reviewerRunId: randomUUID() },
      { evidence: [] },
      { bypassRules: true },
      { mergeMethod: 'squash' },
      { headSha: 'a'.repeat(40) },
      { baseSha: 'b'.repeat(40) },
      { shell: 'git push' },
      { command: 'merge' },
      { authority: {} },
    ])
      expect((await POST(write({ ...request(), ...extra }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('reconciles unknown requests by private reads, bounds output and returns conflict rather than automatic merge retry', async () => {
    mocks.auth.mockResolvedValue({});
    mocks.find.mockResolvedValue(null);
    const id = randomUUID(),
      r = await GET(new Request(endpoint + '?requestId=' + id));
    expect(await r.json()).toEqual({ merge: null });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.find).toHaveBeenCalledWith({}, id);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockRejectedValue(new QueueError('conflict'));
    expect((await POST(write(request()))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.credential.mockResolvedValue({ state: 'configured', revision: 1 });
    mocks.panel.mockResolvedValue({ token: 'SYNTHETIC_SECRET' });
    const invalid = await GET(new Request(endpoint + '?publicationId=' + id));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('SYNTHETIC_SECRET');
  });
});
