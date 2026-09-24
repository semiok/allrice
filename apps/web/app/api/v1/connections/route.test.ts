import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as DatabaseModule from '@allrice/database';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  rotate: vi.fn(),
  beginOAuth: vi.fn(),
  setMemberConnected: vi.fn(),
  oauthAuthorizationUrl: vi.fn(),
  completeOAuthCallback: vi.fn(),
}));
vi.mock('../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  createMcpStore: () => mocks,
}));
import { GET, PATCH } from './route';
import { GET as authorize } from './authorize/route';
import { GET as callback } from './callback/route';
const workspaceId = randomUUID(),
  connectionId = randomUUID();
const context = { actor: { type: 'user', id: randomUUID() } };
const request = (payload: unknown, origin = 'https://allrice.test') =>
  new Request('https://allrice.test/api/v1/connections', {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue(context);
  mocks.list.mockResolvedValue([]);
  mocks.setMemberConnected.mockResolvedValue({ id: connectionId });
  mocks.beginOAuth.mockResolvedValue({
    id: connectionId,
    loginState: 'preparing',
  });
});
it('lists the signed-in member connections without requiring an admin session or caching', async () => {
  const response = await GET(
    new Request(
      `https://allrice.test/api/v1/connections?workspaceId=${workspaceId}`,
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mocks.list).toHaveBeenCalledWith(context, workspaceId);
  mocks.context.mockRejectedValue(
    new DataAccessError('authentication_required'),
  );
  expect(
    (
      await GET(
        new Request(
          `https://allrice.test/api/v1/connections?workspaceId=${workspaceId}`,
        ),
      )
    ).status,
  ).toBe(401);
});
it('rejects cross-origin writes and arbitrary execution, grants and caller identity fields', async () => {
  expect(
    (
      await PATCH(
        request(
          { action: 'disconnect', workspaceId, connectionId },
          'https://attacker.test',
        ),
      )
    ).status,
  ).toBe(403);
  for (const extra of [
    { action: 'call' },
    { action: 'grant' },
    { userId: randomUUID() },
    { enabled: true },
  ]) {
    expect(
      (
        await PATCH(
          request({
            action: 'disconnect',
            workspaceId,
            connectionId,
            ...extra,
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect(mocks.setMemberConnected).not.toHaveBeenCalled();
});
it.each(['disconnect', 'reconnect', 'delete'])(
  'routes %s to the current member only',
  async (action) => {
    expect(
      (await PATCH(request({ action, workspaceId, connectionId }))).status,
    ).toBe(200);
    expect(mocks.setMemberConnected).toHaveBeenCalledWith(context, {
      action,
      workspaceId,
      connectionId,
      connected: action === 'reconnect',
      remove: action === 'delete',
    });
  },
);
it('uses the actual proxy browser origin for OAuth callback without accepting caller redirect URLs', async () => {
  const response = await PATCH(
    new Request('http://localhost:3001/api/v1/connections', {
      method: 'PATCH',
      headers: {
        host: 'allrice.test',
        origin: 'https://allrice.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'login', workspaceId, connectionId }),
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.beginOAuth).toHaveBeenCalledWith(context, {
    action: 'login',
    workspaceId,
    connectionId,
    redirectUrl: 'https://allrice.test/api/v1/connections/callback',
  });
  expect(
    (
      await PATCH(
        request({
          action: 'login',
          workspaceId,
          connectionId,
          redirectUrl: 'https://attacker.test',
        }),
      )
    ).status,
  ).toBe(400);
});
it('bounds credential requests and never reflects server secrets', async () => {
  const response = await PATCH(
    request({
      action: 'credential',
      workspaceId,
      connectionId,
      bearerToken: 'private'.repeat(3000),
    }),
  );
  expect(response.status).toBe(413);
  expect(await response.text()).not.toContain('private');
  expect(mocks.rotate).not.toHaveBeenCalled();
  mocks.rotate.mockRejectedValue(new Error('private-token-sql-error'));
  const failed = await PATCH(
    request({
      action: 'credential',
      workspaceId,
      connectionId,
      bearerToken: 'private-test-token',
    }),
  );
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('private-token');
});
it('uses server-side owner-bound redirects and consumes OAuth callback without reflecting codes', async () => {
  mocks.oauthAuthorizationUrl.mockResolvedValue(
    'https://app.test/authorize?state=server-state',
  );
  const response = await authorize(
    new Request(
      `https://allrice.test/api/v1/connections/authorize?workspaceId=${workspaceId}&connectionId=${connectionId}`,
    ),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(mocks.oauthAuthorizationUrl).toHaveBeenCalledWith(
    context,
    workspaceId,
    connectionId,
  );
  mocks.completeOAuthCallback.mockResolvedValue({ workspaceId, connectionId });
  const resumed = await callback(
    new Request(
      'https://allrice.test/api/v1/connections/callback?state=opaque&code=private-code',
    ),
  );
  expect(mocks.completeOAuthCallback).toHaveBeenCalledWith(context, {
    state: 'opaque',
    code: 'private-code',
  });
  expect(resumed.headers.get('location')).toBe(
    `/workspace/mcp?workspaceId=${workspaceId}&connectionId=${connectionId}`,
  );
  mocks.completeOAuthCallback.mockRejectedValue(new Error('private-code'));
  const failed = await callback(
    new Request(
      'https://allrice.test/api/v1/connections/callback?state=expired&code=private-code',
    ),
  );
  expect(failed.status).toBe(400);
  expect(await failed.text()).not.toContain('private-code');
});
