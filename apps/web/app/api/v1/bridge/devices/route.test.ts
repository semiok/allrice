import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { GET } from './route';

const mocks = vi.hoisted(() => ({ context: vi.fn(), devices: vi.fn() }));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listBridgeDevices: mocks.devices,
}));
const context = {
  actor: { type: 'user', id: 'synthetic-owner' },
} satisfies Pick<RequestContext, 'actor'>;
const request = () =>
  new Request(
    'https://owned.example.test/api/v1/bridge/devices?workspaceId=synthetic-workspace',
  );

describe('Bridge device status GET is tenant-private and never cached', () => {
  afterEach(() => vi.resetAllMocks());
  it('refreshes the authority on every request instead of reusing the old online response', async () => {
    mocks.context.mockResolvedValue(context);
    mocks.devices
      .mockResolvedValueOnce([{ status: 'online' }])
      .mockResolvedValueOnce([{ status: 'offline' }]);
    const first = await GET(request()),
      second = await GET(request());
    expect((await first.json()).devices[0].status).toBe('online');
    expect((await second.json()).devices[0].status).toBe('offline');
    for (const response of [first, second])
      expect(response.headers.get('Cache-Control')).toBe(
        'private, no-store, max-age=0',
      );
    expect(mocks.devices).toHaveBeenCalledTimes(2);
    expect(mocks.devices).toHaveBeenLastCalledWith(
      context,
      'synthetic-workspace',
    );
  });
  it('does not cache authentication failures or call the data service without a session', async () => {
    mocks.context.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(mocks.devices).not.toHaveBeenCalled();
  });
});
