import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import { LoginForm } from './login-form';

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
        contents: `import {createElement} from 'react'; import {hydrateRoot} from 'react-dom/client'; import {LoginForm} from './app/login/login-form'; hydrateRoot(document.getElementById('root'),createElement(LoginForm));`,
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
      const form = createElement(LoginForm);
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

  it.each(['/login'])(
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

  it.each([['/login', '/api/v1/auth/login']])(
    'submits hydrated %s through the JSON API',
    async (path, endpoint) => {
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
    },
  );
});

type Page = Awaited<ReturnType<Browser['newPage']>>;
type Route = Parameters<Parameters<Page['route']>[1]>[0];

suite('login failures in plain words', () => {
  let server: Server, browser: Browser, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/login-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((request, response) => {
      const path = new URL(request.url!, origin).pathname;
      const asset = assets.get(path);
      if (asset) {
        response.setHeader(
          'content-type',
          path.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        response.end(asset);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/login-page.css"><div id="root"></div><script type="module" src="/login-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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

  const problem =
    (status: number, code: string, message: string) => (route: Route) =>
      route.fulfill({
        status,
        json: {
          error: { code, message, requestId: 'synthetic', retryable: false },
        },
      });
  // Adjacent cases differ in wording, so each one proves a fresh answer.
  const failures: [string, (route: Route) => Promise<void>, string][] = [
    [
      'wrong password',
      problem(401, 'AUTHENTICATION_REQUIRED', 'Authentication failed'),
      '账号或密码不对，请检查后重新输入。',
    ],
    [
      'server error',
      (route) =>
        route.fulfill({ status: 502, body: '<html>Bad gateway</html>' }),
      '暂时登录不了，请稍后再试。',
    ],
    [
      'too many attempts',
      (route) => route.fulfill({ status: 429, body: 'Too Many Requests' }),
      '尝试次数太多，请稍后再试。',
    ],
    [
      'offline',
      (route) => route.abort('internetdisconnected'),
      '暂时登录不了，请稍后再试。',
    ],
    [
      'malformed account',
      problem(400, 'VALIDATION_FAILED', 'Request validation failed'),
      '账号或密码不对，请检查后重新输入。',
    ],
    [
      'wrong entry',
      problem(403, 'AUTHORIZATION_DENIED', 'Access denied'),
      '此账号无法登录这个入口。管理员请从 allrice-admin.bplabs.xyz 登录；员工请从 allrice.bplabs.xyz 登录。',
    ],
  ];
  const contrast = (a: string, b: string) => {
    const luminance = (value: string) => {
      const [r, g, b] = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map((v) => {
          const c = Number(v) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`explains each failure and re-enables login at ${width}px in the ${theme} theme`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        try {
          let reply = failures[0]![1];
          let answered = 0;
          await page.route('**/api/v1/auth/login', (route) => {
            answered += 1;
            return reply(route);
          });
          await page.goto(`${origin}/?theme=${theme}`);
          const form = page.locator('form');
          const submit = form.locator('[type="submit"]');
          await expect.poll(() => submit.isEnabled()).toBe(true);
          await form.locator('[name="username"]').fill('synthetic-user');
          await form.locator('[name="password"]').fill(password);
          for (const [index, [name, handler, text]] of failures.entries()) {
            reply = handler;
            await submit.click();
            const alert = form.getByRole('alert');
            await expect
              .poll(() => alert.textContent().catch(() => ''), {
                message: name,
              })
              .toBe(text);
            expect(answered).toBe(index + 1);
            await expect.poll(() => submit.isEnabled()).toBe(true);
            expect(await submit.innerText()).toBe('登录');
            if (name !== 'wrong entry')
              expect(text, name).not.toMatch(/[A-Za-z0-9]/);
            const screen = await page.locator('main').innerText();
            for (const word of [
              '登录失败',
              'Authentication',
              'Request',
              'Failed to fetch',
              'Too Many',
              'Bad gateway',
              '401',
              '429',
              '502',
            ])
              expect(screen, name).not.toContain(word);
            const look = await alert.evaluate((node) => {
              let element: Element | null = node;
              let ground = 'rgba(0, 0, 0, 0)';
              while (element && /rgba\(0, 0, 0, 0\)/.test(ground)) {
                ground = getComputedStyle(element).backgroundColor;
                element = element.parentElement;
              }
              const box = node.getBoundingClientRect();
              const panel = node
                .closest('.auth-panel')!
                .getBoundingClientRect();
              return {
                text: getComputedStyle(node).color,
                ground,
                inside: box.left >= panel.left && box.right <= panel.right,
              };
            });
            expect(contrast(look.text, look.ground)).toBeGreaterThanOrEqual(
              4.5,
            );
            expect(look.inside).toBe(true);
            expect(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth >
                  document.documentElement.clientWidth,
              ),
            ).toBe(false);
          }
        } finally {
          await page.close();
        }
      });
});
