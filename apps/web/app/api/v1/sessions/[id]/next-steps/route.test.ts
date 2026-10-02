import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactReviewError,
  DataAccessError,
  IdentityError,
} from '@allrice/database';
import type * as Database from '@allrice/database';
import { GET } from './route';

const ports = vi.hoisted(() => ({ context: vi.fn(), read: vi.fn() }));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readTaskNextSteps: ports.read,
}));
const sessionId = randomUUID(),
  workspaceId = randomUUID(),
  employeeAssignmentId = randomUUID(),
  employeeVersionId = randomUUID();
const context = {
  organizationId: randomUUID(),
  workspaceId,
  actor: { type: 'user', id: randomUUID() },
};
const route = { params: Promise.resolve({ id: sessionId }) };
const request = () =>
  new Request(
    `http://localhost/api/v1/sessions/${sessionId}/next-steps?${new URLSearchParams({ workspaceId, employeeAssignmentId, employeeVersionId })}`,
  );
describe('scoped ordinary-member next-step read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.context.mockResolvedValue(context);
    ports.read.mockResolvedValue({ suggestions: [] });
  });
  it('needs authentication and rejects foreign identity before any data projection', async () => {
    ports.context.mockResolvedValueOnce(null);
    expect((await GET(request(), route)).status).toBe(401);
    ports.context.mockRejectedValueOnce(
      new IdentityError('tenant_context_invalid'),
    );
    expect((await GET(request(), route)).status).toBe(403);
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('forwards current assignment/version and keeps results private/no-store', async () => {
    const result = await GET(request(), route);
    expect(result.status).toBe(200);
    expect(ports.read).toHaveBeenCalledWith(context, {
      workspaceId,
      sessionId,
      employeeAssignmentId,
      employeeVersionId,
    });
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('returns stale/foreign Session 404, explicit denial 403 and malformed selection 400', async () => {
    for (const [code, status] of [
      ['not_found', 404],
      ['authorization_denied', 403],
    ] as const) {
      ports.read.mockRejectedValueOnce(new DataAccessError(code));
      expect((await GET(request(), route)).status).toBe(status);
    }
    ports.read.mockClear();
    expect(
      (await GET(new Request('http://localhost/?workspaceId=bad'), route))
        .status,
    ).toBe(400);
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('preserves artifact ownership denial during the authorization recheck', async () => {
    for (const [code, status] of [
      ['identity_denied', 403],
      ['artifact_not_found', 404],
    ] as const) {
      ports.read.mockRejectedValueOnce(new ArtifactReviewError(code));
      const result = await GET(request(), route);
      expect(result.status).toBe(status);
      expect(result.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});
