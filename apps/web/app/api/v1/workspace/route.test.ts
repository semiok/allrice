import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  workspace: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock('../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getEmployeeWorkspace: mocks.workspace,
  getUserPreferences: mocks.preferences,
}));
import { GET } from './route';
describe('workspace viewer identity for layout preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preferences.mockResolvedValue({
      streamingOutput: false,
      updatedAt: null,
    });
    mocks.workspace.mockResolvedValue({
      workspaceId: 'workspace',
      organizationId: 'organization',
    });
  });
  it('uses the authenticated user, never a request-provided preference identity, and is uncacheable', async () => {
    const context = {
      actor: { type: 'user', id: 'authenticated-user' },
      organizationId: 'organization',
      memberships: [],
    };
    mocks.context.mockResolvedValue(context);
    const response = await GET(
      new Request(
        'https://allrice.test/api/v1/workspace?viewerId=someone-else',
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      workspace: {
        workspaceId: 'workspace',
        organizationId: 'organization',
        viewerId: 'authenticated-user',
        canAdminister: false,
        preferences: { streamingOutput: false, updatedAt: null },
      },
    });
    expect(mocks.workspace).toHaveBeenCalledWith(context, undefined);
  });
  it('does not create a shared identity for non-user actors and still rejects missing authentication', async () => {
    mocks.context.mockResolvedValue({
      actor: { type: 'agent', id: 'agent' },
      memberships: [],
    });
    expect(
      (
        await (
          await GET(new Request('https://allrice.test/api/v1/workspace'))
        ).json()
      ).workspace.viewerId,
    ).toBeNull();
    mocks.context.mockResolvedValue(null);
    expect(
      (await GET(new Request('https://allrice.test/api/v1/workspace'))).status,
    ).toBe(401);
  });
});
