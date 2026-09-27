import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './route';
const mocks = vi.hoisted(() => ({ context: vi.fn(), releases: vi.fn() }));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('../../../../../../lib/bridge/client-releases', () => ({
  bridgeClientReleases: mocks.releases,
}));
afterEach(() => vi.resetAllMocks());
it('requires a session before inspecting configured downloads', async () => {
  mocks.context.mockResolvedValue(null);
  const response = await GET(
    new Request('https://synthetic.test/api/v1/bridge/client/releases'),
  );
  expect(response.status).toBe(401);
  expect(mocks.releases).not.toHaveBeenCalled();
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
it('returns fresh release information without exposing server file paths', async () => {
  mocks.context.mockResolvedValue({ actor: { type: 'user', id: 'synthetic' } });
  const releases = [
    { platform: 'macos-arm64', available: true, version: '0.6.0-dev.7' },
  ];
  mocks.releases.mockResolvedValue(releases);
  const response = await GET(
    new Request('https://synthetic.test/api/v1/bridge/client/releases'),
  );
  expect(await response.json()).toEqual({ releases });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
