import { renderToStaticMarkup } from 'react-dom/server';
import type { RequestContext } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError, resolveWorkspaceId } from '@allrice/database';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestContext } from '../../../lib/identity/session';
import WorkspaceMcpPage from './page';

vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  resolveWorkspaceId: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../../../lib/identity/session', () => ({
  getRequestContext: vi.fn(),
}));
vi.mock('../../runtime-console/mcp-settings', () => ({
  McpSettings: ({ workspaceId }: { workspaceId: string }) => (
    <section data-workspace-id={workspaceId}>MCP settings</section>
  ),
}));

const organizationId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';

function context(workspace: string | null = null): RequestContext {
  return {
    requestId: '55555555-5555-4555-8555-555555555555',
    sessionId: '66666666-6666-4666-8666-666666666666',
    actor: { type: 'user', id: userId },
    organizationId,
    workspaceId: workspace,
    authenticatedAt: '2026-09-08T00:00:00.000Z',
    memberships: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        userId,
        organizationId,
        workspaceId: workspace,
        role: 'admin',
        active: true,
      },
    ],
  };
}

describe('workspace MCP page access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'localhost' }) as Awaited<ReturnType<typeof headers>>,
    );
    vi.mocked(redirect).mockImplementation(() => {
      throw new Error('test redirect');
    });
    vi.mocked(resolveWorkspaceId).mockResolvedValue(workspaceId);
  });

  it('resolves an organization-scoped email/password session without redirecting to login', async () => {
    const actor = context();
    vi.mocked(getRequestContext).mockResolvedValue(actor);
    const html = renderToStaticMarkup(await WorkspaceMcpPage());
    expect(resolveWorkspaceId).toHaveBeenCalledExactlyOnceWith(actor);
    expect(html).toContain(`data-workspace-id="${workspaceId}"`);
    expect(redirect).not.toHaveBeenCalled();
    expect(actor.workspaceId).toBeNull();
  });

  it('preserves the explicit portal workspace and workspace-admin scope', async () => {
    const actor = context(workspaceId);
    vi.mocked(getRequestContext).mockResolvedValue(actor);
    const html = renderToStaticMarkup(await WorkspaceMcpPage());
    expect(resolveWorkspaceId).toHaveBeenCalledExactlyOnceWith(actor);
    expect(html).toContain(`data-workspace-id="${workspaceId}"`);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('lets a workspace admin resolve its workspace from an organization-scoped session', async () => {
    const actor = context();
    actor.memberships[0]!.workspaceId = workspaceId;
    vi.mocked(getRequestContext).mockResolvedValue(actor);
    const html = renderToStaticMarkup(await WorkspaceMcpPage());
    expect(html).toContain(`data-workspace-id="${workspaceId}"`);
  });

  it('preserves the explicit workspace from the capability entry and still authorizes it', async () => {
    vi.mocked(getRequestContext).mockResolvedValue(context());
    const html = renderToStaticMarkup(
      await WorkspaceMcpPage({
        searchParams: Promise.resolve({ workspaceId }),
      }),
    );
    expect(resolveWorkspaceId).toHaveBeenCalledWith(
      expect.anything(),
      workspaceId,
    );
    expect(html).toContain(`data-workspace-id="${workspaceId}"`);
  });

  it.each([
    ['member', { role: 'member' as const }],
    ['viewer', { role: 'viewer' as const }],
    ['inactive admin', { active: false }],
    ['other user', { userId: otherId }],
    ['other organization', { organizationId: otherId }],
    ['other workspace', { workspaceId: otherId }],
  ])('does not grant MCP administration to a %s', async (_label, patch) => {
    const actor = context();
    Object.assign(actor.memberships[0]!, patch);
    vi.mocked(getRequestContext).mockResolvedValue(actor);
    const html = renderToStaticMarkup(await WorkspaceMcpPage());
    expect(html).toContain('只有当前租户管理员可以管理 MCP 连接。');
    expect(html).not.toContain('MCP settings');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects only the unauthenticated visitor before resolving workspace access', async () => {
    vi.mocked(getRequestContext).mockResolvedValue(null);
    await expect(WorkspaceMcpPage()).rejects.toThrow('test redirect');
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
  });

  it('shows an explicit denied state when no accessible active workspace exists', async () => {
    vi.mocked(getRequestContext).mockResolvedValue(context());
    vi.mocked(resolveWorkspaceId).mockRejectedValue(
      new DataAccessError('authorization_denied'),
    );
    const html = renderToStaticMarkup(await WorkspaceMcpPage());
    expect(html).toContain('当前租户没有你可访问的工作区');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('MCP settings');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not misreport an unexpected database failure as a login or permission problem', async () => {
    vi.mocked(getRequestContext).mockResolvedValue(context());
    const failure = new Error('synthetic database unavailable');
    vi.mocked(resolveWorkspaceId).mockRejectedValue(failure);
    await expect(WorkspaceMcpPage()).rejects.toBe(failure);
    expect(redirect).not.toHaveBeenCalled();
  });
});
