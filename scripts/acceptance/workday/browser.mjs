/** Real screenshots only. New ephemeral context; no browser profile or live writes. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { URLSearchParams } from 'node:url';
import { browserFailure, readPage } from './browser-diagnostics.mjs';

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
      throw browserFailure('identity-http', response.status());
    const { identity: current } = await response.json();
    for (const key of ['personId', 'organizationId', ...Object.keys(selection)])
      if (current[key] !== config[key])
        throw browserFailure('identity-scope-mismatch');
    const owner = await context.request.post(
      origin + '/api/v1/d-entry/native-owner',
      {
        data: selection,
        headers: { Origin: origin },
        maxRedirects: 0,
      },
    );
    if (owner.status() !== 200)
      throw browserFailure('owner-http', owner.status());
    const { mount } = await owner.json();
    if (
      mount?.executionGeneration !== '4.0' ||
      mount.bindingRef !== config.bindingRef ||
      Object.keys(current).some((key) => mount.identity?.[key] !== current[key])
    )
      throw browserFailure('owner-binding-mismatch');
  }
  for (const [id, recipe] of Object.entries(config.ui)) {
    const page = await context.newPage();
    const screenshot = id.replaceAll('.', '-') + '.png';
    try {
      steps[id] = await readPage(page, {
        origin,
        employeeInstanceId: config.employeeInstanceId,
        recipe,
        identity,
        path: join(config.output, screenshot),
        screenshot,
      });
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
