import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ cookie: 'allrice_session=token' }),
}));
vi.mock('../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getUserPreferences: mocks.preferences,
}));
import { AppearanceScript } from './appearance-script';

const user = { actor: { type: 'user', id: 'current-user' }, memberships: [] };
const render = async () => renderToStaticMarkup(await AppearanceScript());

describe('saved appearance before the first paint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue(user);
  });

  it.each(['light', 'dark', 'system'])(
    'embeds the signed-in employee’s %s choice',
    async (appearance) => {
      mocks.preferences.mockResolvedValue({ appearance });
      const html = await render();
      expect(html).toMatch(/^<script>/);
      expect(html).toContain(`"${appearance}")`);
      expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(user);
      // The request carries the page's cookies to the session lookup.
      const request: Request = mocks.context.mock.calls[0]![0];
      expect(request.headers.get('cookie')).toBe('allrice_session=token');
    },
  );

  it('keeps the default for signed-out pages without reading preferences', async () => {
    mocks.context.mockResolvedValue(null);
    expect(await render()).toBe('');
    expect(mocks.preferences).not.toHaveBeenCalled();
  });

  it('keeps the default when the saved choice cannot be read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.preferences.mockRejectedValue(Error('private-sql'));
    expect(await render()).toBe('');
    mocks.context.mockRejectedValue(Error('private-sql'));
    expect(await render()).toBe('');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-sql');
    log.mockRestore();
  });
});
