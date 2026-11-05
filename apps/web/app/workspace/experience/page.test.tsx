import type { RequestContext } from '@allrice/contracts';
import { experienceReviewEnabled, resolveWorkspaceId } from '@allrice/database';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestContext } from '../../../lib/identity/session';
import ExperiencePage from './page';

vi.mock('@allrice/database', () => ({
  experienceReviewEnabled: vi.fn(),
  resolveWorkspaceId: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('../../../lib/identity/session', () => ({
  getRequestContext: vi.fn(),
}));

const workspaceId = '22222222-2222-4222-8222-222222222222';
const actor: RequestContext = {
  requestId: '55555555-5555-4555-8555-555555555555',
  sessionId: '66666666-6666-4666-8666-666666666666',
  actor: { type: 'user', id: '33333333-3333-4333-8333-333333333333' },
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId,
  authenticatedAt: '2026-09-08T00:00:00.000Z',
  memberships: [],
};

describe('retired experience page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(experienceReviewEnabled).mockReturnValue(true);
    vi.mocked(headers).mockResolvedValue(new Headers());
    vi.mocked(getRequestContext).mockResolvedValue(actor);
    vi.mocked(resolveWorkspaceId).mockResolvedValue(workspaceId);
    vi.mocked(notFound).mockImplementation(() => {
      throw new Error('test not found');
    });
    vi.mocked(redirect).mockImplementation(() => {
      throw new Error('test redirect');
    });
  });

  it('keeps the existing feature gate before authentication or redirect', async () => {
    vi.mocked(experienceReviewEnabled).mockReturnValue(false);
    await expect(
      ExperiencePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('test not found');
    expect(getRequestContext).not.toHaveBeenCalled();
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('keeps the login gate before resolving workspace access', async () => {
    vi.mocked(getRequestContext).mockResolvedValue(null);
    await expect(
      ExperiencePage({ searchParams: Promise.resolve({ workspaceId }) }),
    ).rejects.toThrow('test redirect');
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
  });

  it('does not redirect past a denied explicit workspace', async () => {
    const denied = new Error('synthetic workspace denied');
    vi.mocked(resolveWorkspaceId).mockRejectedValue(denied);
    await expect(
      ExperiencePage({ searchParams: Promise.resolve({ workspaceId }) }),
    ).rejects.toBe(denied);
    expect(resolveWorkspaceId).toHaveBeenCalledExactlyOnceWith(
      actor,
      workspaceId,
    );
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([undefined, 'old session/&?employee=another#fragment'])(
    'authorizes the workspace and carries only an encoded native session (%s)',
    async (sessionId) => {
      await expect(
        ExperiencePage({
          searchParams: Promise.resolve({ workspaceId, sessionId }),
        }),
      ).rejects.toThrow('test redirect');
      expect(resolveWorkspaceId).toHaveBeenCalledExactlyOnceWith(
        actor,
        workspaceId,
      );
      const location = vi.mocked(redirect).mock.calls[0]?.[0];
      expect(location).toBeDefined();
      const target = new URL(location!, 'https://allrice.test');
      expect(target.pathname).toBe('/chatflow');
      expect([...target.searchParams.keys()]).toEqual(
        sessionId ? ['session'] : [],
      );
      expect(target.searchParams.get('session')).toBe(sessionId ?? null);
      expect(target.hash).toBe('');
    },
  );
});
