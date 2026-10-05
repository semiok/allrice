import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  health: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('../../../../../lib/execution/platform-technical-health', () => ({
  platformTechnicalHealth: mocks.health,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readPlatformTechnicalDiagnostics: mocks.read,
  listPlatformTechnicalIssues: mocks.list,
  capturePlatformTechnicalIssue: mocks.capture,
}));
import { GET, POST } from './route';
describe('platform technical API authorization and origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('denies ordinary admin lookalikes before any platform probe, database read or mutation', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect(
      (
        await GET(
          new Request(
            'https://admin.allrice.test/api/v1/admin/technical-assistant',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request(
            'https://admin.allrice.test/api/v1/admin/technical-assistant',
            {
              method: 'POST',
              headers: { origin: 'https://admin.allrice.test' },
              body: '{}',
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('refuses cross-origin writes and oversized input before capture', async () => {
    mocks.auth.mockResolvedValue({
      actor: { type: 'user', id: 'platform-admin' },
    });
    expect(
      (
        await POST(
          new Request(
            'https://admin.allrice.test/api/v1/admin/technical-assistant',
            {
              method: 'POST',
              headers: { origin: 'https://other.test' },
              body: '{}',
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(
      (
        await POST(
          new Request(
            'https://admin.allrice.test/api/v1/admin/technical-assistant',
            {
              method: 'POST',
              headers: { origin: 'https://admin.allrice.test' },
              body: 'x'.repeat(2001),
            },
          ),
        )
      ).status,
    ).toBe(413);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
  it('returns only the canonical stored capture and disables shared caches', async () => {
    const context = { actor: { type: 'user', id: 'platform-admin' } };
    mocks.auth.mockResolvedValue(context);
    const input = { kind: 'run', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    mocks.capture.mockResolvedValue({
      created: false,
      detail: { issue: { id: 'stored-id' }, records: [] },
    });
    const response = await POST(
      new Request(
        'https://admin.allrice.test/api/v1/admin/technical-assistant',
        {
          method: 'POST',
          headers: { origin: 'https://admin.allrice.test' },
          body: JSON.stringify(input),
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.capture).toHaveBeenCalledWith(context, input);
    expect(await response.json()).toMatchObject({
      created: false,
      detail: { issue: { id: 'stored-id' } },
    });
  });
});
