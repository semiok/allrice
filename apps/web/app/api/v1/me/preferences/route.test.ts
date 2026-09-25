import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getUserPreferences: mocks.get,
  updateUserPreferences: mocks.update,
}));
import { GET, PATCH } from './route';
const context = {
  actor: { type: 'user', id: 'current-user' },
  memberships: [],
};
const request = (body: unknown) =>
  new Request('https://allrice.test/api/v1/me/preferences?userId=other', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('authenticated personal preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue(context);
    mocks.get.mockResolvedValue({ streamingOutput: false, updatedAt: null });
    mocks.update.mockResolvedValue({
      streamingOutput: true,
      updatedAt: '2026-09-25T00:00:00.000Z',
    });
  });
  it('requires login for reads and writes', async () => {
    mocks.context.mockResolvedValue(null);
    expect((await GET(new Request('https://allrice.test/api'))).status).toBe(
      401,
    );
    expect((await PATCH(request({ streamingOutput: true }))).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('writes only the current account, without admin privileges or shared caching', async () => {
    const response = await PATCH(request({ streamingOutput: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(context, {
      streamingOutput: true,
    });
    expect((await response.json()).viewerId).toBe('current-user');
  });
  it.each([
    { streamingOutput: 'true' },
    { streamingOutput: true, userId: 'other' },
    {},
  ])('rejects invalid or foreign-target settings %j', async (body) => {
    expect((await PATCH(request(body))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('returns failure instead of pretending a failed write was saved', async () => {
    mocks.update.mockRejectedValue(Error('private-sql'));
    const response = await PATCH(request({ streamingOutput: true }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private-sql');
  });
});
