import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import { LoginForm } from './login-form';
import { AcceptInvitationForm } from '../accept-invitation/accept-form';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const password = 'synthetic-test-password';

suite('auth submission before and after hydration', () => {
  let server: Server, browser: Browser, origin: string;
  const submitted: { method: string; url: string; body: string }[] = [];
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const built = await build({
      absWorkingDir: process.cwd(),
      stdin: {
        contents: `import {createElement} from 'react'; import {hydrateRoot} from 'react-dom/client'; import {LoginForm} from './app/login/login-form'; import {AcceptInvitationForm} from './app/accept-invitation/accept-form'; hydrateRoot(document.getElementById('root'),location.pathname==='/login'?createElement(LoginForm):createElement(AcceptInvitationForm,{token:'synthetic-token'}));`,
        resolveDir: resolve('apps/web'),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    server = createServer(async (request, response) => {
      const url = request.url!;
      if (request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += chunk;
        submitted.push({ method: request.method, url, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ homePath: '/chatflow' }));
        return;
      }
      if (url === '/app.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end(built.outputFiles[0].contents);
        return;
      }
      const form = url.startsWith('/login')
        ? createElement(LoginForm)
        : createElement(AcceptInvitationForm, { token: 'synthetic-token' });
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        url === '/chatflow'
          ? '<p>Logged in</p>'
          : `<html><body><div id="root">${renderToString(form)}</div><script src="/app.js" defer></script></body></html>`,
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No server');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  it.each(['/login', '/accept-invitation?token=synthetic-token'])(
    'protects unhydrated %s including native submission',
    async (path) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.goto(origin + path);
        const form = page.locator('form');
        expect(await form.getAttribute('method')).toBe('post');
        expect(await form.locator('[type="submit"]').isDisabled()).toBe(true);
        await form.locator('input').first().fill('synthetic-user');
        await form.locator('[name="password"]').fill(password);
        const before = submitted.length;
        await form.locator('[name="password"]').press('Enter');
        expect(submitted.length).toBe(before);
        const response = page.waitForResponse(
          (r) => r.request().method() === 'POST',
        );
        await form.evaluate((node) => (node as HTMLFormElement).submit());
        await response;
        const request = submitted.at(-1)!;
        expect(request.method).toBe('POST');
        expect(request.url).not.toContain(password);
        expect(request.url).not.toContain('password=');
        expect(request.body).toContain(`password=${password}`);
      } finally {
        await context.close();
      }
    },
  );

  it.each([
    ['/login', '/api/v1/auth/login'],
    [
      '/accept-invitation?token=synthetic-token',
      '/api/v1/auth/invitations/accept',
    ],
  ])('submits hydrated %s through the JSON API', async (path, endpoint) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin + path);
      const form = page.locator('form');
      await expect
        .poll(() => form.locator('[type="submit"]').isEnabled())
        .toBe(true);
      await form.locator('input').first().fill('synthetic-user');
      await form.locator('[name="password"]').fill(password);
      await form.locator('[type="submit"]').click();
      await page.waitForURL(origin + '/chatflow');
      const request = submitted.at(-1)!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe(endpoint);
      expect(JSON.parse(request.body).password).toBe(password);
      expect(page.url()).not.toContain(password);
    } finally {
      await context.close();
    }
  });
});
