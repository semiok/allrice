/** Offline acceptance helper: actual ChatFlow renderer and isolated Chrome.
 * All page requests are intercepted; no tenant server or personal profile.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const origin = 'https://allrice-acceptance.invalid';

export async function verifyRenderedDownloadLink(input: {
  answer: string;
  downloadUrl: string;
  objectId: string;
}) {
  const expected = new URL(input.downloadUrl, origin);
  assert.equal(expected.origin, origin, 'Expected a same-origin file link');
  assert.equal(expected.pathname, `/api/v1/files/${input.objectId}/download`);
  assert.equal(expected.hash, '');
  const { createElement } = webRequire('react') as {
    createElement(component: unknown, props: { text: string }): unknown;
  };
  const { renderToStaticMarkup } = webRequire('react-dom/server') as {
    renderToStaticMarkup(element: unknown): string;
  };
  const { AssistantMarkdown } = await tsImport(
    '../../../apps/web/app/chatflow/assistant-markdown.tsx',
    {
      parentURL: import.meta.url,
      tsconfig: join(root, 'apps/web/tsconfig.json'),
    },
  );
  const html = renderToStaticMarkup(
    createElement(AssistantMarkdown, { text: input.answer }),
  );
  const { chromium } = workerRequire('playwright-core') as typeof Playwright;
  const browser = await chromium.launch({
    executablePath:
      process.env.ALLRICE_TEST_CHROME ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    args: ['--disable-background-networking', '--disable-component-update'],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const requested: string[] = [];
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      requested.push(url);
      if (url === `${origin}/replay`)
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: html,
        });
      else if (url === expected.href)
        await route.fulfill({
          contentType: 'text/plain',
          body: 'offline click proof',
        });
      else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await page.goto(`${origin}/replay`);
    const anchors = await page.locator('a').evaluateAll((nodes) =>
      nodes.map((node) => {
        if (!(node instanceof HTMLAnchorElement))
          throw new Error('Expected an HTML download anchor');
        return {
          attribute: node.getAttribute('href'),
          href: node.href,
          pathname: new URL(node.href).pathname,
          search: new URL(node.href).search,
          label: node.textContent,
        };
      }),
    );
    const index = anchors.findIndex((anchor) => anchor.href === expected.href);
    assert.ok(
      index >= 0,
      'Rendered anchor matches the exact returned download URL',
    );
    const anchor = anchors[index]!;
    assert.equal(anchor.pathname, `/api/v1/files/${input.objectId}/download`);
    assert.equal(anchor.search, expected.search);
    await page.locator('a').nth(index).click({ timeout: 5000 });
    await page.waitForURL(expected.href, { timeout: 5000 });
    assert.equal(page.url(), expected.href);
    assert.ok(
      requested.includes(expected.href),
      'Click targets the full expected URL',
    );
    return {
      renderer: 'apps/web/app/chatflow/assistant-markdown.tsx',
      mode: 'isolated Chrome; all requests intercepted, no server download',
      exactUrlMatch: true,
      objectId: input.objectId,
      expectedDownloadUrl: input.downloadUrl,
      anchor,
      clickedUrl: page.url(),
      rawStringMatched: input.answer.includes(input.downloadUrl),
    };
  } finally {
    await browser.close();
  }
}
