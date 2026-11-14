import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(
  new URL('../apps/worker/package.json', import.meta.url),
);
const { chromium } = require('playwright-core');
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const args = ['--host-resolver-rules=MAP *.allrice.test 127.0.0.1'];

suite('shared test browser proxy routing', () => {
  it('ESM and require launches reach named fixture origins with inherited system proxy settings', async () => {
    const esm = await import(
      pathToFileURL(require.resolve('playwright-core').replace(/\.js$/, '.mjs'))
        .href
    );
    expect(esm.chromium).toBe(chromium);
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.headers.host);
      res.end('fixture reached');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let browser;
    try {
      browser = await esm.chromium.launch({ headless: true, args });
      const page = await browser.newPage();
      for (const host of [
        'employee.allrice.test',
        'nested.preview.allrice.test',
        '127.0.0.1',
      ]) {
        const response = await page.goto(
          'http://' + host + ':' + server.address().port,
        );
        expect(response.status()).toBe(200);
        expect(await response.text()).toBe('fixture reached');
      }
      expect(hits).toHaveLength(3);
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('persistent contexts use the same default fixture routing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'allrice-proxy-profile-'));
    const server = createServer((_req, res) => res.end('persistent fixture'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let context;
    try {
      context = await chromium.launchPersistentContext(directory, {
        headless: true,
        args,
      });
      const page = await context.newPage();
      const response = await page.goto(
        'http://employee.allrice.test:' + server.address().port,
      );
      expect(await response.text()).toBe('persistent fixture');
    } finally {
      await context?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('explicit proxy routes still intercept loopback requests', async () => {
    const hits = [];
    const proxy = createServer((req, res) => {
      hits.push(req.url);
      res.end('proxy reached');
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: {
          server: 'http://127.0.0.1:' + proxy.address().port,
          bypass: '<-loopback>',
        },
      });
      const page = await browser.newPage();
      const response = await page.goto('http://127.0.0.1:49152/proxy-check');
      expect(await response.text()).toBe('proxy reached');
      expect(hits).toContain('http://127.0.0.1:49152/proxy-check');
    } finally {
      await browser?.close();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
