import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
import { repairFixture } from '../../../../../../test/platform-repair-fixture';
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
  create: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  catalog: vi.fn(),
  detail: vi.fn(),
  cancel: vi.fn(),
  artifact: vi.fn(),
  readBytes: vi.fn(),
  storage: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('../../../../../../lib/storage/runtime', () => ({
  getStorageAdapter: mocks.storage,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createPlatformRepairTask: mocks.create,
  listPlatformRepairTasks: mocks.list,
  findPlatformRepairTask: mocks.find,
  getPlatformRepairCatalog: mocks.catalog,
  getPlatformRepairTask: mocks.detail,
  cancelPlatformRepairTask: mocks.cancel,
  getPlatformRepairArtifact: mocks.artifact,
  readArtifactBytes: mocks.readBytes,
}));
import { GET, POST } from './route';
import { GET as baselines } from './baselines/route';
import { GET as detail, DELETE as cancel } from './[id]/route';
import { GET as download } from './[id]/artifacts/[artifactId]/route';
const endpoint =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/repair';
const write = (body: unknown, origin = 'https://admin.allrice.test') =>
  new Request(endpoint, {
    method: 'POST',
    headers: { origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
describe('private repair API ownership, immutable response, input and download boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it('denies ordinary accounts at every list, catalog, detail, mutation and download ingress before any work', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    const q = repairFixture(),
      params = { params: Promise.resolve({ id: q.id, artifactId: q.id }) };
    for (const response of [
      await GET(new Request(endpoint)),
      await baselines(new Request(endpoint + '/baselines')),
      await detail(new Request(endpoint + '/' + q.id), params),
      await cancel(
        new Request(endpoint + '/' + q.id, {
          method: 'DELETE',
          headers: { origin: 'https://admin.allrice.test' },
        }),
        params,
      ),
      await POST(write({ requestId: q.requestId, baselineId: q.baseline.id })),
      await download(
        new Request(endpoint + '/' + q.id + '/artifacts/' + q.id),
        params,
      ),
    ])
      expect(response.status).toBe(403);
    for (const name of [
      'create',
      'list',
      'find',
      'catalog',
      'detail',
      'cancel',
      'artifact',
      'readBytes',
      'storage',
    ] as const)
      expect(mocks[name]).not.toHaveBeenCalled();
  });
  it('denies cross-origin, oversized and injected authority before task admission', async () => {
    const q = repairFixture();
    mocks.auth.mockResolvedValue({ actor: { type: 'user', id: q.id } });
    expect((await POST(write({}, 'https://other.test'))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect((await POST(write('x'.repeat(1001)))).status).toBe(413);
    expect(
      (
        await POST(
          write({
            requestId: q.requestId,
            baselineId: q.baseline.id,
            ownerId: q.id,
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('returns the persisted exact request and typed detail while preventing shared cache', async () => {
    const q = repairFixture(),
      context = { actor: { type: 'user', id: q.id } };
    mocks.auth.mockResolvedValue(context);
    mocks.create.mockResolvedValue(q);
    mocks.find.mockResolvedValue(q);
    mocks.detail.mockResolvedValue(q);
    mocks.list.mockResolvedValue([q]);
    mocks.catalog.mockResolvedValue({
      state: 'available',
      baselines: [q.baseline],
    });
    const response = await POST(
      write({ requestId: q.requestId, baselineId: q.baseline.id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(q);
    expect(mocks.create).toHaveBeenCalledWith(context, {
      requestId: q.requestId,
      baselineId: q.baseline.id,
    });
    const back = await GET(new Request(endpoint + '?requestId=' + q.requestId));
    expect(await back.json()).toEqual({ task: q });
    expect(mocks.find).toHaveBeenCalledWith(context, q.requestId);
    for (const response of [
      back,
      await GET(new Request(endpoint)),
      await baselines(new Request(endpoint + '/baselines')),
      await detail(new Request(endpoint + '/' + q.id), {
        params: Promise.resolve({ id: q.id }),
      }),
    ])
      expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('keeps foreign-admin existence private and rechecks permission after reading exact download bytes', async () => {
    const q = repairFixture(),
      params = { params: Promise.resolve({ id: q.id, artifactId: q.id }) };
    mocks.auth.mockResolvedValue({ actor: { type: 'user', id: q.id } });
    mocks.artifact.mockRejectedValueOnce(new DataAccessError('not_found'));
    expect((await download(new Request(endpoint), params)).status).toBe(404);
    expect(mocks.storage).not.toHaveBeenCalled();
    const artifact = {
      object: { mediaType: 'application/json' },
      version: { fileName: '候选.json' },
    };
    mocks.artifact
      .mockResolvedValueOnce(artifact)
      .mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    mocks.readBytes.mockResolvedValue(Buffer.from('{}'));
    mocks.storage.mockReturnValue({});
    expect((await download(new Request(endpoint), params)).status).toBe(403);
    mocks.artifact.mockResolvedValue(artifact);
    const response = await download(new Request(endpoint), params);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
    expect(response.headers.get('content-length')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain(
      encodeURIComponent('候选.json'),
    );
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    );
  });
});
