import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { CompanyAssetError, DataAccessError } from '@allrice/database';
const p = vi.hoisted(() => ({
  admin: vi.fn(),
  member: vi.fn(),
  file: vi.fn(),
  list: vi.fn(),
  recommendations: vi.fn(),
  detail: vi.fn(),
  history: vi.fn(),
  sources: vi.fn(),
  mutate: vi.fn(),
  preview: vi.fn(),
  bytes: vi.fn(),
  storage: {},
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: p.admin,
}));
vi.mock('../identity/session', () => ({ getRequestContext: p.member }));
vi.mock('../storage/runtime', () => ({ getStorageAdapter: () => p.storage }));
vi.mock('../runtime/static-artifact-preview', () => ({
  readStaticArtifactPreview: p.preview,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getCompanyAssetFile: p.file,
  listCompanyAssets: p.list,
  listCompanyTemplateRecommendations: p.recommendations,
  getCompanyAsset: p.detail,
  listCompanyAssetRevisions: p.history,
  listCompanyRuleSources: p.sources,
  mutateCompanyAsset: p.mutate,
  readArtifactBytes: p.bytes,
}));
import { companyAssetsHttp } from './company-assets-http';
const org = randomUUID(),
  id = randomUUID(),
  rev = randomUUID(),
  ws = randomUUID();
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: org,
  workspaceId: ws,
};
const file = {
  object: {
    id: randomUUID(),
    checksum: 'sha256:fixed',
    sizeBytes: 3,
    mediaType: 'text/plain',
  },
  file: { fileName: '公司范本.txt' },
  content: { body: 'Explicitly selected content' },
  digest: 'sha256:revision',
};
const request = (
  q = '',
  method = 'GET',
  body?: unknown,
  origin = 'https://localhost',
) =>
  new Request('https://localhost/api/v1/company-assets?' + q, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
describe('company publication HTTP authority and exact bytes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    p.admin.mockResolvedValue(context);
    p.member.mockResolvedValue(context);
    p.file.mockResolvedValue(file);
    p.preview.mockResolvedValue({
      kind: 'text',
      text: 'immutable company snapshot',
      offset: 0,
      eof: true,
    });
    p.bytes.mockResolvedValue(Buffer.from([1, 2, 3]));
    p.list.mockResolvedValue({ assets: [] });
    p.recommendations.mockResolvedValue({ assets: [] });
    p.mutate.mockResolvedValue({ state: 'draft' });
  });
  it('preserves the real reader, validates requested workspace and excludes other verbs/admin-only sources', async () => {
    expect((await companyAssetsHttp(request('', 'DELETE'))).status).toBe(405);
    expect((await companyAssetsHttp(request('sources=1'))).status).toBe(403);
    const otherWs = randomUUID();
    expect(
      (await companyAssetsHttp(request('workspaceId=' + otherWs))).status,
    ).toBe(200);
    expect(p.list).toHaveBeenCalledWith(
      { ...context, workspaceId: otherWs },
      org,
      { administration: false, after: undefined },
    );
    p.member.mockResolvedValueOnce(null);
    expect((await companyAssetsHttp(request())).status).toBe(401);
    expect(
      (await companyAssetsHttp(request('workspaceId=invalid'))).status,
    ).toBe(400);
  });
  it('reads bounded recommendations as the actual member and validates the employee scope', async () => {
    const employee = randomUUID(),
      otherWs = randomUUID();
    const response = await companyAssetsHttp(
      request(
        `recommendations=1&workspaceId=${otherWs}&employeeId=${employee}&task=quarter`,
      ),
    );
    expect(response.status).toBe(200);
    expect(p.recommendations).toHaveBeenCalledWith(
      { ...context, workspaceId: otherWs },
      org,
      employee,
      'quarter',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(
      (await companyAssetsHttp(request('recommendations=1&employeeId=invalid')))
        .status,
    ).toBe(400);
    expect(
      (
        await companyAssetsHttp(
          request(`recommendations=1&employeeId=${employee}`),
          org,
        )
      ).status,
    ).toBe(403);
  });
  it('requires an exact publication revision and authorizes before and after native preview IO', async () => {
    expect(
      (await companyAssetsHttp(request(`assetId=${id}&preview=1`))).status,
    ).toBe(400);
    expect(p.preview).not.toHaveBeenCalled();
    const result = await companyAssetsHttp(
      request(`assetId=${id}&revisionId=${rev}&preview=1&offset=7`),
    );
    expect(await result.json()).toMatchObject({
      kind: 'text',
      text: 'immutable company snapshot',
    });
    expect(p.file).toHaveBeenNthCalledWith(1, context, org, id, rev, false);
    expect(p.file).toHaveBeenNthCalledWith(2, context, org, id, rev, false);
    expect(p.preview).toHaveBeenCalledWith(
      {
        object: file.object,
        kind: 'document',
        version: { fileName: file.file.fileName },
      },
      expect.objectContaining({ offset: 7 }),
    );
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
  });
  it('returns no bytes if withdrawn, member access revoked or exact snapshot changed during IO', async () => {
    for (const failure of [
      new CompanyAssetError('asset_unavailable'),
      new DataAccessError('authorization_denied'),
    ]) {
      p.file.mockResolvedValueOnce(file).mockRejectedValueOnce(failure);
      const r = await companyAssetsHttp(
        request(`assetId=${id}&revisionId=${rev}&download=1`),
      );
      expect([403, 409]).toContain(r.status);
      expect(await r.text()).not.toContain('immutable company snapshot');
    }
    p.file
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, digest: 'changed' });
    expect(
      (
        await companyAssetsHttp(
          request(`assetId=${id}&revisionId=${rev}&preview=1`),
        )
      ).status,
    ).toBe(409);
    p.file.mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    const before = p.bytes.mock.calls.length;
    expect(
      (
        await companyAssetsHttp(
          request(`assetId=${id}&revisionId=${rev}&download=1`),
        )
      ).status,
    ).toBe(403);
    expect(p.bytes.mock.calls.length).toBe(before);
  });
  it('uses attachment bytes for downloads and rejects foreign-origin publication before mutation', async () => {
    const download = await companyAssetsHttp(
      request(`assetId=${id}&revisionId=${rev}&download=1`),
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(download.headers.get('content-disposition')).toContain(
      'attachment;',
    );
    expect(
      (
        await companyAssetsHttp(
          request('', 'POST', { operation: 'save' }, 'https://foreign.test'),
        )
      ).status,
    ).toBe(403);
    expect(p.mutate).not.toHaveBeenCalled();
    expect(
      (await companyAssetsHttp(request('', 'POST', { operation: 'save' })))
        .status,
    ).toBe(200);
    expect(p.mutate).toHaveBeenCalledWith(
      context,
      org,
      { operation: 'save' },
      p.storage,
      false,
    );
  });
});
