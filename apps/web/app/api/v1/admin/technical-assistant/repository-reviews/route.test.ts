import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, QueueError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  panel: vi.fn(),
  credential: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  artifact: vi.fn(),
  bytes: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('../../../../../../lib/storage/runtime', () => ({
  getStorageAdapter: () => ({}),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createPlatformRepositoryReview: mocks.create,
  findPlatformRepositoryReview: mocks.find,
  getPlatformRepositoryReviewPanel: mocks.panel,
  getPlatformRepositoryCredential: mocks.credential,
  getPlatformRepositoryReview: mocks.get,
  cancelPlatformRepositoryReview: mocks.cancel,
  getPlatformRepositoryReviewArtifact: mocks.artifact,
  readArtifactBytes: mocks.bytes,
}));
import { GET, POST } from './route';
import { GET as detail, DELETE as stop } from './[id]/route';
import { GET as download } from './[id]/artifacts/[artifactId]/route';
const endpoint =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/repository-reviews';
const request = () => ({
  requestId: randomUUID(),
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
describe('private repository review API boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('denies employees and foreign writes before any side effect or download', async () => {
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
    expect(
      (
        await download(new Request(endpoint), {
          params: Promise.resolve({ id, artifactId: randomUUID() }),
        })
      ).status,
    ).toBe(403);
    for (const fn of [
      mocks.create,
      mocks.panel,
      mocks.get,
      mocks.cancel,
      mocks.artifact,
      mocks.bytes,
    ])
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
      { command: 'merge' },
      { authority: {} },
    ])
      expect((await POST(write({ ...request(), ...extra }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('reconciles unknown requests by private reads, bounds output and returns conflict rather than automatic model retry', async () => {
    mocks.auth.mockResolvedValue({});
    mocks.find.mockResolvedValue(null);
    const id = randomUUID(),
      r = await GET(new Request(endpoint + '?requestId=' + id));
    expect(await r.json()).toEqual({ review: null });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.find).toHaveBeenCalledWith({}, id);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockRejectedValue(new QueueError('conflict'));
    expect((await POST(write(request()))).status).toBe(409);
    mocks.credential.mockResolvedValue({ state: 'configured', revision: 1 });
    mocks.panel.mockResolvedValue({ token: 'SYNTHETIC_SECRET' });
    const invalid = await GET(new Request(endpoint + '?publicationId=' + id));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('SYNTHETIC_SECRET');
  });
  it('rechecks actual artifact authority after reading bytes and does not release bytes when access changes', async () => {
    mocks.auth.mockResolvedValue({});
    mocks.artifact
      .mockResolvedValueOnce({
        object: { mediaType: 'application/json' },
        version: { fileName: 'review.json' },
      })
      .mockRejectedValueOnce(new DataAccessError('not_found'));
    mocks.bytes.mockResolvedValue(Buffer.from('private-opinion'));
    const r = await download(new Request(endpoint), {
      params: Promise.resolve({ id: randomUUID(), artifactId: randomUUID() }),
    });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('private-opinion');
    expect(mocks.artifact).toHaveBeenCalledTimes(2);
  });
});
