import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({ context: vi.fn(), readiness: vi.fn() }));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getWorkspaceReadiness: mocks.readiness,
}));
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const workspace = '00000000-0000-4000-8000-000000000001';
describe('tenant readiness route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      actor: { type: 'user', id: 'real-user' },
    });
  });
  it('requires auth and validates inputs before DB discovery', async () => {
    mocks.context.mockResolvedValue(null);
    expect(
      (await GET(new Request('https://test/api?workspaceId=bad'))).status,
    ).toBe(401);
    mocks.context.mockResolvedValue({});
    expect(
      (await GET(new Request('https://test/api?workspaceId=bad'))).status,
    ).toBe(400);
    expect(
      (
        await GET(
          new Request(
            `https://test/api?workspaceId=${workspace}&sessionId=bad`,
          ),
        )
      ).status,
    ).toBe(400);
    expect(mocks.readiness).not.toHaveBeenCalled();
  });
  it('passes only authenticated context, never browser owner/role/flag hints', async () => {
    mocks.readiness.mockResolvedValue({ schemaVersion: 1 });
    const response = await GET(
      new Request(
        `https://test/api?workspaceId=${workspace}&ownerId=other&canAdminister=true&enabled=1`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.readiness).toHaveBeenCalledWith(
      { actor: { type: 'user', id: 'real-user' } },
      workspace,
      null,
    );
  });
  it.each([
    ['authorization_denied', 403],
    ['not_found', 404],
  ] as const)('returns %s without scope leakage', async (code, status) => {
    mocks.readiness.mockRejectedValue(new DataAccessError(code));
    const response = await GET(
      new Request(`https://test/api?workspaceId=${workspace}`),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('READINESS_DENIED');
  });
  it('does not leak credentials/SQL on failed projection or return empty success', async () => {
    mocks.readiness.mockRejectedValue(
      Error('postgres://secret and credential-envelope'),
    );
    const response = await GET(
      new Request(`https://test/api?workspaceId=${workspace}`),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"READINESS_UNAVAILABLE"}');
  });
});
