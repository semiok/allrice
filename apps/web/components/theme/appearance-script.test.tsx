import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'allrice.example.test' }),
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
// The workspace argument the inline script was built with.
const render = async () => {
  const html = renderToStaticMarkup(await AppearanceScript());
  expect(html).toMatch(/^<script>[\s\S]*<\/script>$/);
  return JSON.parse(html.match(/,(\{"choice":[^}]*\})\)<\/script>$/)![1]!);
};

describe('saved appearance before the first paint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue(user);
  });

  it.each(['light', 'dark', 'system'])(
    'embeds the signed-in employee’s %s choice and account',
    async (appearance) => {
      mocks.preferences.mockResolvedValue({ appearance });
      expect(await render()).toEqual({
        choice: appearance,
        viewer: 'current-user',
      });
      expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(user);
      // The session lookup tells the portals apart by the page's host.
      const request: Request = mocks.context.mock.calls[0]![0];
      expect(request.headers.get('host')).toBe('allrice.example.test');
    },
  );

  it('keeps the default for signed-out pages without reading preferences', async () => {
    mocks.context.mockResolvedValue(null);
    expect(await render()).toEqual({ choice: null, viewer: null });
    expect(mocks.preferences).not.toHaveBeenCalled();
  });

  it('keeps the default but still marks the page when the read fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.preferences.mockRejectedValue(Error('private-sql'));
    expect(await render()).toEqual({ choice: null, viewer: 'current-user' });
    mocks.context.mockRejectedValue(Error('private-sql'));
    expect(await render()).toEqual({ choice: null, viewer: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-sql');
    log.mockRestore();
  });
});
