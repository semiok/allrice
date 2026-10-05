import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const ports = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock('../../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readQualityEvidenceBundle: ports.read,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('read-only quality archive HTTP boundary', () => {
  it('checks authority before archive IO, including a request after authority is lost', async () => {
    vi.stubEnv('ALLRICE_QUALITY_EVIDENCE_DIR', '/trusted/release/archive');
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    const empty = {
      schemaVersion: 1,
      state: 'not_configured',
      deployedSha: 'a'.repeat(40),
      currentDevAcceptance: 'not_claimed',
      records: [],
    };
    ports.auth.mockResolvedValue({});
    ports.read.mockReturnValue(empty);
    const response = await GET(new Request('https://admin.test/api/evidence'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(empty);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ports.auth.mock.invocationCallOrder[0]).toBeLessThan(
      ports.read.mock.invocationCallOrder[0]!,
    );
    expect(ports.read).toHaveBeenCalledWith(
      '/trusted/release/archive',
      'a'.repeat(40),
    );
    ports.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect(
      (await GET(new Request('https://admin.test/api/evidence'))).status,
    ).toBe(403);
    expect(ports.auth).toHaveBeenCalledTimes(2);
    expect(ports.read).toHaveBeenCalledTimes(1);
  });
});
