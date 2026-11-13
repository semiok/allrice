import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const ports = vi.hoisted(() => ({ context: vi.fn(), favorite: vi.fn() }));
vi.mock('../../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  setWorkbenchFileFavorite: ports.favorite,
}));
import { PUT } from './route';
const a = randomUUID(),
  b = randomUUID(),
  workspaceId = randomUUID(),
  objectId = randomUUID();
const context = (viewerId: string) => ({
  actor: { type: 'user', id: viewerId },
  organizationId: randomUUID(),
  workspaceId,
  memberships: [],
});
const request = (
  expected?: string,
  extra: { origin?: string; workspaceId?: string } = {},
) =>
  new Request(
    `https://allrice.test/api/v1/workbench/files/${objectId}/favorite?workspaceId=${extra.workspaceId ?? workspaceId}`,
    {
      method: 'PUT',
      headers: {
        origin: extra.origin ?? 'https://allrice.test',
        'content-type': 'application/json',
        ...(expected === undefined
          ? {}
          : { 'X-AllRice-Expected-Viewer-Id': expected }),
      },
      body: JSON.stringify({ favorite: true }),
    },
  );
const route = { params: Promise.resolve({ id: objectId }) };
describe('favorite write identity precondition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.context.mockResolvedValue(context(a));
    ports.favorite.mockImplementation(async (current, id, input) => ({
      viewerId: current.actor.id,
      objectId: id,
      favorite: input.favorite,
    }));
  });
  it.each([a, '', a.toUpperCase()])(
    'rejects an old A page after cookie switches to B, before touching either preference: %j',
    async (expected) => {
      ports.context.mockResolvedValue(context(b));
      // Even a B-owned target must not let the old A page write into B's account.
      const response = await PUT(request(expected), route);
      expect(response.status).toBe(409);
      expect(JSON.stringify(await response.json())).not.toContain(objectId);
      expect(ports.favorite).not.toHaveBeenCalled();
    },
  );
  it('passes only the actual current actor to the existing database authority', async () => {
    const current = context(b);
    ports.context.mockResolvedValue(current);
    for (const expected of [b, undefined]) {
      const response = await PUT(request(expected), route);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        viewerId: b,
        objectId,
        favorite: true,
      });
      expect(ports.favorite).toHaveBeenLastCalledWith(current, objectId, {
        favorite: true,
      });
    }
  });
  it('keeps login, same-origin and workspace checks before any favorite access', async () => {
    expect(
      (await PUT(request(a, { origin: 'https://other.test' }), route)).status,
    ).toBe(403);
    expect(
      (await PUT(request(a, { workspaceId: randomUUID() }), route)).status,
    ).toBe(403);
    ports.context.mockResolvedValue(null);
    expect((await PUT(request(a), route)).status).toBe(401);
    expect(ports.favorite).not.toHaveBeenCalled();
  });
});
