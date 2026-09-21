import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError, ArtifactReviewError } from '@allrice/database';
import { tenantValidationHttp } from './validation-http';
const ports = vi.hoisted(() => ({
  admin: vi.fn(),
  summary: vi.fn(),
  run: vi.fn(),
  artifacts: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.admin,
}));
vi.mock('../runtime/static-artifact-preview', () => ({
  readStaticArtifactPreview: ports.read,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getTenantValidationSummary: ports.summary,
  inspectTenantRun: ports.run,
  inspectTenantRunArtifacts: ports.artifacts,
}));
const target = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    subjectId: randomUUID(),
  },
  actor = { actor: { id: randomUUID(), type: 'user' } },
  runId = randomUUID(),
  artifactId = randomUUID();
const request = (suffix = '', method = 'GET') =>
  new Request(
    `https://localhost/api/v1/admin/tenants/${target.organizationId}/validation?workspaceId=${target.workspaceId}&subjectId=${target.subjectId}${suffix}`,
    { method },
  );
describe('tenant validation read-only HTTP', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.admin.mockResolvedValue(actor);
    ports.summary.mockResolvedValue({ ...target, inspectorId: actor.actor.id });
    ports.run.mockResolvedValue({ ...target, run: { id: runId } });
    ports.artifacts.mockResolvedValue({
      artifacts: [{ id: artifactId, object: { checksum: 'sha256:checked' } }],
    });
    ports.read.mockResolvedValue({
      kind: 'text',
      text: 'SAFE_FILE',
      mediaType: 'text/plain',
    });
  });
  it('requires platform identity and accepts no action/write methods', async () => {
    ports.admin.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect(
      (await tenantValidationHttp(request(), target.organizationId)).status,
    ).toBe(401);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(
        (await tenantValidationHttp(request('', method), target.organizationId))
          .status,
      ).toBe(405);
    expect(ports.summary).not.toHaveBeenCalled();
    expect(ports.run).not.toHaveBeenCalled();
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('passes the real issuer separately from explicit target, with private/no-store responses', async () => {
    const response = await tenantValidationHttp(
      request(),
      target.organizationId,
    );
    expect(ports.summary).toHaveBeenCalledWith(actor, target, null);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    await tenantValidationHttp(
      request(`&runId=${runId}`),
      target.organizationId,
    );
    expect(ports.run).toHaveBeenCalledWith(actor, target, runId);
  });
  it('rejects missing/malformed identities, and never reads storage on failed authorization', async () => {
    expect(
      (
        await tenantValidationHttp(
          new Request('https://localhost/validation'),
          target.organizationId,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await tenantValidationHttp(
          request(`&artifactId=${artifactId}`),
          target.organizationId,
        )
      ).status,
    ).toBe(400);
    ports.artifacts.mockRejectedValueOnce(
      new ArtifactReviewError('artifact_not_found'),
    );
    expect(
      (
        await tenantValidationHttp(
          request(`&runId=${runId}&artifactId=${artifactId}`),
          target.organizationId,
        )
      ).status,
    ).toBe(404);
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('checks artifact owner/run and live authority both before and after storage', async () => {
    const response = await tenantValidationHttp(
      request(`&runId=${runId}&artifactId=${artifactId}`),
      target.organizationId,
    );
    expect(ports.artifacts).toHaveBeenCalledTimes(2);
    expect(ports.artifacts).toHaveBeenNthCalledWith(
      2,
      actor,
      target,
      runId,
      artifactId,
    );
    expect(await response.json()).toMatchObject({
      ...target,
      inspectorId: actor.actor.id,
      runId,
      artifactId,
      preview: { text: 'SAFE_FILE' },
    });
    ports.artifacts
      .mockResolvedValueOnce({
        artifacts: [{ id: artifactId, object: { checksum: 'sha256:checked' } }],
      })
      .mockRejectedValueOnce(new DataAccessError('authorization_denied'));
    const revoked = await tenantValidationHttp(
      request(`&runId=${runId}&artifactId=${artifactId}`),
      target.organizationId,
    );
    expect(revoked.status).toBe(403);
    expect(await revoked.text()).not.toContain('SAFE_FILE');
  });
  it('does not return already-read bytes if object identity changes', async () => {
    ports.artifacts
      .mockResolvedValueOnce({
        artifacts: [{ id: artifactId, object: { checksum: 'old' } }],
      })
      .mockResolvedValueOnce({
        artifacts: [{ id: artifactId, object: { checksum: 'new' } }],
      });
    const response = await tenantValidationHttp(
      request(`&runId=${runId}&artifactId=${artifactId}`),
      target.organizationId,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('SAFE_FILE');
  });
});
