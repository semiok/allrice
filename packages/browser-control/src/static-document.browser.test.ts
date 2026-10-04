import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { describe, it, expect } from 'vitest';
import {
  BrowserProfileSchema,
  StaticBrowserTargetSchema,
} from '@allrice/contracts';
import {
  createControlledBrowserRenderer,
  verifyStaticBrowser,
} from './index.js';
const suite =
  process.env.ALLRICE_TEST_STATIC_BROWSER === '1' ? describe : describe.skip;
suite('saved-document real browser boundary', () => {
  it('executes only the saved inline document; blocks HTTP, WebSocket and popup access with fresh login state', async () => {
    let http = 0,
      upgrades = 0;
    const server = createServer((_q, s) => {
      http++;
      s.end('unexpected external access');
    });
    server.on('upgrade', (_q, s) => {
      upgrades++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('owned port required');
    const external = '127.0.0.1:' + address.port;
    const html = `<!doctype html><title>Saved only</title><button onclick="document.querySelector('output').textContent=42;window.open('http://${external}/popup')">Compute</button><output>0</output><img src="http://${external}/image"><script>fetch('http://${external}/fetch').catch(()=>document.body.append(' Network denied'));try{new WebSocket('ws://${external}/ws')}catch{}document.body.append(' Cookies:'+document.cookie)</script>`;
    const target = StaticBrowserTargetSchema.parse({
      version: 1,
      versionId: randomUUID(),
      objectId: randomUUID(),
      sourceSessionId: randomUUID(),
      sourceOperationId: null,
      fileName: 'boundary.html',
      mediaType: 'text/html',
      sizeBytes: Buffer.byteLength(html),
      checksum: 'sha256:' + createHash('sha256').update(html).digest('hex'),
    });
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    let alive = true,
      driver:
        Awaited<ReturnType<typeof createControlledBrowserRenderer>> | undefined;
    try {
      driver = await createControlledBrowserRenderer(
        context,
        browser,
        {
          profileId: randomUUID(),
          profile: BrowserProfileSchema.parse({
            version: 1,
            network: 'public_https',
            origins: [],
          }),
          staticDocument: {
            target,
            contentBase64: Buffer.from(html).toString('base64'),
          },
          authorizeUrl: () => true,
          assertCurrent: async () => {
            if (!alive) throw Error('AUTHORITY_LOST');
          },
          requestStarted: () => () => {},
          requestSent: () => {},
          requestApproval: async () => {
            throw Error('NO_EXTERNAL_WRITES');
          },
        },
        async () => {},
      );
      const report = await verifyStaticBrowser({
        target,
        plan: {
          version: 1,
          timeoutMs: 30000,
          steps: [
            { type: 'click', selector: { tag: 'button', label: 'Compute' } },
            { type: 'text_contains', expected: '42' },
            { type: 'text_contains', expected: 'Network denied' },
          ],
        },
        assertCurrent: async () => {},
        observe: async () => (await driver!.observe(1)).observation,
        perform: async (a, o) => {
          await driver!.perform(a, o);
        },
      });
      expect(report.verdict).toBe('passed');
      expect(http).toBe(0);
      expect(upgrades).toBe(0);
      expect(context.pages()).toHaveLength(1);
      expect(await context.cookies()).toEqual([]);
      alive = false;
      await expect(
        driver.perform({ type: 'navigate', url: 'https://example.com/' }, null),
      ).rejects.toThrow();
      expect(http).toBe(0);
    } finally {
      await driver?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60000);
});
