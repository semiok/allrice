import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as DatabaseModule from '@allrice/database';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  queueDiscovery: vi.fn(),
  grant: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  createMcpStore: () => mocks,
}));
import { GET, POST, PATCH } from './route';
const workspaceId = randomUUID(),
  connectionId = randomUUID();
const request = (
  payload: unknown,
  method = 'POST',
  origin = 'https://allrice.test',
) =>
  new Request('https://allrice.test/api/v1/admin/mcp', {
    method,
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(payload),
  });
describe('P16 MCP management HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    mocks.context.mockResolvedValue({
      actor: { type: 'user', id: randomUUID() },
    });
    mocks.list.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('returns no-store protocol/auth metadata without exposing token fields', async () => {
    const result = await GET(
      new Request(
        `https://allrice.test/api/v1/admin/mcp?workspaceId=${workspaceId}`,
      ),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({
      enabled: true,
      protocol: '2025-11-25',
      auth: 'tenant_bearer',
      connections: [],
    });
  });
  it('cannot mutate when feature is off', async () => {
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '0');
    expect((await POST(request({ workspaceId }))).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    mocks.context.mockRejectedValue(
      new DataAccessError('authentication_required'),
    );
    expect((await POST(request({ workspaceId }))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutations before touching credentials', async () => {
    expect(
      (await POST(request({ workspaceId }, 'POST', 'https://attacker.test')))
        .status,
    ).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects oversized bodies without reflecting the secret', async () => {
    const result = await POST(request({ bearerToken: 'private'.repeat(3000) }));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('private');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('routes exact grants without allowing arbitrary execution actions', async () => {
    mocks.grant.mockResolvedValue({ id: connectionId });
    const result = await PATCH(
      request(
        {
          action: 'grant',
          workspaceId,
          connectionId,
          revisionId: randomUUID(),
          allowed: true,
          risk: 'read_only',
        },
        'PATCH',
      ),
    );
    expect(result.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledOnce();
    expect(
      (
        await PATCH(
          request({ action: 'call', workspaceId, connectionId }, 'PATCH'),
        )
      ).status,
    ).toBe(400);
  });
  it('returns only bounded generic errors, never raw crypto/SQL/transport messages', async () => {
    mocks.create.mockRejectedValue(
      new Error('bearer-secret-in-underlying-error'),
    );
    const result = await POST(request({ workspaceId }));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('bearer-secret');
  });
});
