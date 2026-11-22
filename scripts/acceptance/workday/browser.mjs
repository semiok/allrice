/** Real screenshots only. New ephemeral context; no browser profile or live writes. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Same pinned Worker dependency as the existing browser-qa.fixture.ts. No
// package install/download, user profile, remote debugging or browser reuse.
const { chromium } = createRequire(
  new URL(
    '../../../apps/worker/src/harness/browser-qa.fixture.ts',
    import.meta.url,
  ),
)('playwright-core');

let input = '';
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const origin = new URL(config.baseUrl).origin;
const token = process.env.ALLRICE_ACCEPTANCE_SESSION;
if (!token) throw new Error('Explicit test session required');
const browser = await chromium.launch({
  headless: true,
  executablePath: config.browserExecutable,
});
let context;
const steps = {};
let closed = false;
let closePromise;
function close() {
  return (closePromise ??= (async () => {
    try {
      await context?.close();
    } finally {
      await browser.close();
    }
    closed = true;
  })());
}
process.once('SIGTERM', () => {
  void close().catch(() => {});
});
try {
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  await context.addCookies([
    {
      name: 'allrice_session',
      value: token,
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
      secure: origin.startsWith('https:'),
    },
  ]);
  // No mutation/model/VM endpoint, downloads, external origin or opaque WS.
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()))
      await route.abort('blockedbyclient');
    else await route.continue();
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  const selection = Object.fromEntries(
    ['workspaceId', 'employeeInstanceId', 'threadId'].map((key) => [
      key,
      config[key],
    ]),
  );
  async function identity() {
    const response = await context.request.get(
      origin + '/api/v1/d-entry/identity?' + new URLSearchParams(selection),
      { maxRedirects: 0 },
    );
    if (response.status() !== 200)
      throw new Error('Current identity unavailable');
    const { identity: current } = await response.json();
    for (const key of ['personId', 'organizationId', ...Object.keys(selection)])
      if (current[key] !== config[key])
        throw new Error('Authorized scope changed');
    const owner = await context.request.post(
      origin + '/api/v1/d-entry/native-owner',
      {
        data: selection,
        headers: { Origin: origin },
        maxRedirects: 0,
      },
    );
    if (owner.status() !== 200)
      throw new Error('Current 4.0 owner unavailable');
    const { mount } = await owner.json();
    if (
      mount?.executionGeneration !== '4.0' ||
      mount.bindingRef !== config.bindingRef ||
      Object.keys(current).some((key) => mount.identity?.[key] !== current[key])
    )
      throw new Error('Native generation or exact owner changed');
  }
  for (const [id, recipe] of Object.entries(config.ui)) {
    const page = await context.newPage();
    const screenshot = id.replaceAll('.', '-') + '.png';
    try {
      await identity();
      const response = await page.goto(new URL(recipe.path, origin).href);
      if (
        !response ||
        response.status() !== 200 ||
        new URL(page.url()).origin !== origin
      )
        throw new Error('Owner route did not produce a same-origin page');
      // Locator comes from the sealed UI owner, never guessed by this runner.
      await page.locator(recipe.locator).first().waitFor({ state: 'visible' });
      const scope = await page
        .locator(recipe.scopeLocator)
        .first()
        .getAttribute(recipe.scopeAttribute);
      if (scope !== config.employeeInstanceId)
        throw new Error('Displayed employee scope differs');
      if (recipe.text !== undefined)
        await page
          .getByText(recipe.text, { exact: true })
          .first()
          .waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      await identity();
      await page.screenshot({
        path: join(config.output, screenshot),
        fullPage: true,
      });
      steps[id] = {
        status: 'passed',
        screenshot,
        reason:
          '真实浏览器当前授权read-only页面/owner locator可见；禁写/禁WS，不证明模型过程或业务读写闭环',
      };
    } catch {
      let captured = null;
      try {
        await page.screenshot({
          path: join(config.output, screenshot),
          fullPage: true,
        });
        captured = screenshot;
      } catch {
        /* no synthetic image */
      }
      steps[id] = {
        status: 'failed',
        screenshot: captured,
        reason:
          '真实页面/当前资格/owner locator检查失败；无截图时是浏览器捕获不可用，未生成示意图',
      };
    } finally {
      await page.close();
    }
  }
} finally {
  try {
    await close();
  } finally {
    await writeFile(
      join(config.output, 'browser.json'),
      JSON.stringify({ steps, closed }) + '\n',
    );
  }
}
