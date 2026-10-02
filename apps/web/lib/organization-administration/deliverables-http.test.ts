import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError, ArtifactReviewError } from '@allrice/database';
const ports = vi.hoisted(() => ({
  admin: vi.fn(),
  list: vi.fn(),
  inspect: vi.fn(),
  preview: vi.fn(),
  bytes: vi.fn(),
  storage: {},
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.admin,
}));
vi.mock('../runtime/static-artifact-preview', () => ({
  readStaticArtifactPreview: ports.preview,
}));
vi.mock('../storage/runtime', () => ({
  getStorageAdapter: () => ports.storage,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listCompanyDeliverables: ports.list,
  inspectCompanyDeliverable: ports.inspect,
  readArtifactBytes: ports.bytes,
}));
import { companyDeliverablesHttp } from './deliverables-http';
const org = randomUUID(),
  file = randomUUID(),
  issuer = { actor: { id: randomUUID(), type: 'user' } },
  artifact = {
    object: { id: randomUUID(), checksum: 'sha256:fixed' },
    version: { fileName: '公司成果.txt' },
  };
const req = (query = '', method = 'GET') =>
  new Request(
    `https://localhost/api/v1/admin/organizations/${org}/deliverables?${query}`,
    { method },
  );
describe('company delivery read-only byte boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.admin.mockResolvedValue(issuer);
    ports.list.mockResolvedValue({ deliverables: [] });
    ports.inspect.mockResolvedValue(artifact);
    ports.preview.mockResolvedValue({
      kind: 'text',
      text: 'Checked immutable file',
    });
    ports.bytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });
  it('preserves actual issuer, forbids mutations and blocks storage before denied authority', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect((await companyDeliverablesHttp(req('', method), org)).status).toBe(
        405,
      );
    ports.admin.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect(
      (await companyDeliverablesHttp(req(`artifactId=${file}`), org)).status,
    ).toBe(401);
    ports.inspect.mockRejectedValueOnce(
      new ArtifactReviewError('artifact_not_found'),
    );
    expect(
      (await companyDeliverablesHttp(req(`artifactId=${file}`), org)).status,
    ).toBe(404);
    expect(ports.preview).not.toHaveBeenCalled();
    expect(ports.bytes).not.toHaveBeenCalled();
    await companyDeliverablesHttp(
      req('format=pdf&includeUnavailable=1&userId=' + file),
      org,
    );
    expect(ports.list).toHaveBeenCalledWith(
      issuer,
      org,
      expect.objectContaining({
        format: 'pdf',
        includeUnavailable: true,
        userId: file,
      }),
    );
  });
  it('returns no bytes after access was revoked during IO or the checked object changed', async () => {
    ports.inspect
      .mockResolvedValueOnce(artifact)
      .mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    const denied = await companyDeliverablesHttp(
      req(`artifactId=${file}&download=1`),
      org,
    );
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('Checked immutable');
    ports.inspect.mockResolvedValueOnce(artifact).mockResolvedValueOnce({
      ...artifact,
      object: { ...artifact.object, checksum: 'sha256:changed' },
    });
    expect(
      (await companyDeliverablesHttp(req(`artifactId=${file}`), org)).status,
    ).toBe(409);
  });
  it('uses native preview and validated text paging, while download remains original attachment bytes', async () => {
    const response = await companyDeliverablesHttp(
      req(`artifactId=${file}&offset=7`),
      org,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'text',
      text: 'Checked immutable file',
    });
    expect(ports.preview).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({ offset: 7, signal: expect.any(AbortSignal) }),
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    const download = await companyDeliverablesHttp(
      req(`artifactId=${file}&download=1`),
      org,
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(download.headers.get('content-disposition')).toContain(
      'attachment;',
    );
    expect(ports.bytes).toHaveBeenCalledWith(
      ports.storage,
      artifact.object,
      64_000_000,
    );
  });
  it('rejects malformed identifiers, filters and page offsets before file IO', async () => {
    expect(
      (await companyDeliverablesHttp(req('artifactId=no'), org)).status,
    ).toBe(400);
    for (const offset of ['0', '-1', '1.5', 'NaN', '1000001'])
      expect(
        (
          await companyDeliverablesHttp(
            req(`artifactId=${file}&offset=${offset}`),
            org,
          )
        ).status,
      ).toBe(400);
    expect(ports.preview).not.toHaveBeenCalled();
    expect(ports.bytes).not.toHaveBeenCalled();
  });
});
