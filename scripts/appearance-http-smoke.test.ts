import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { Appearance } from '@allrice/contracts';
import {
  appearanceScript,
  themeScript,
} from '../apps/web/lib/theme/theme-script';

const source = readFileSync(
  new URL('./appearance-http-smoke.mjs', import.meta.url),
  'utf8',
);
const defaults = `<script>${themeScript}</script>`;
const workspace = (choice: Appearance) =>
  `<script>${appearanceScript({ choice, viewer: 'viewer-a' })}</script>`;
const page = (body: string) => `<html><head></head><body>${body}</body></html>`;

// Run the complete CLI against HTTP responses, including its login assertion
// and restoration of the original preference on either success or failure.
async function smoke({
  chatflow = (choice: Appearance) =>
    page(`${defaults}${workspace(choice)}<main>Chat</main>`),
  login = page(`${defaults}<form>Login</form>`),
} = {}) {
  let saved: Appearance = 'system';
  const log = vi.fn();
  const fetch = async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/v1/auth/login')
      return new Response('{}', {
        headers: { 'set-cookie': 'session=test; Path=/' },
      });
    if (path === '/api/v1/me/preferences') {
      if (init.method === 'PATCH')
        saved = JSON.parse(init.body as string).appearance;
      return Response.json({ preferences: { appearance: saved } });
    }
    if (path === '/chatflow') return new Response(chatflow(saved));
    if (path === '/login') return new Response(login);
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await runInNewContext(`(async () => {\n${source}\n})()`, {
      process: { env: { ALLRICE_SMOKE_BASE_URL: 'http://appearance.test' } },
      fetch,
      URL,
      console: { log },
    });
  } finally {
    expect(saved).toBe('system');
  }
  expect(log).toHaveBeenCalledWith('Appearance first-paint smoke passed');
}

describe('appearance HTTP smoke', () => {
  it('accepts the theme scripts before content and a login page with only the default', async () => {
    await smoke();
  });

  it.each([
    'hidden id="x"',
    'id="x" hidden',
    'id="x" hidden=""',
    "id='x' hidden='hidden'",
    'id="x" HIDDEN',
  ])('skips the entire hidden subtree with %s', async (attributes) => {
    await smoke({
      chatflow: (choice) =>
        page(
          `<div ${attributes}><div><span>Hidden</span><img src="x"><br><input></div></div>${defaults}${workspace(choice)}<main>Chat</main>`,
        ),
    });
  });

  it.each([
    'hidden-extra',
    'data-hidden',
    'aria-hidden="true"',
    'title="hidden"',
    'title="a hidden value"',
  ])('does not treat %s as a hidden attribute', async (attributes) => {
    await expect(
      smoke({
        chatflow: (choice) =>
          page(
            `<div ${attributes}>Visible</div>${defaults}${workspace(choice)}`,
          ),
      }),
    ).rejects.toThrow('/chatflow first paint');
  });

  it('rejects an employee script after the first visible content', async () => {
    await expect(
      smoke({
        chatflow: (choice) =>
          page(`${defaults}<main>Chat</main>${workspace(choice)}`),
      }),
    ).rejects.toThrow('/chatflow first paint');
  });

  it('rejects an employee script after the login form', async () => {
    await expect(
      smoke({
        login: page(`${defaults}<form>Login</form>${workspace('dark')}`),
      }),
    ).rejects.toThrow('/login first paint');
  });

  it('rejects an employee script in the login head', async () => {
    await expect(
      smoke({
        login: `<html><head>${workspace('dark')}</head><body>${defaults}<form>Login</form></body></html>`,
      }),
    ).rejects.toThrow('/login first paint');
  });
});
