import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserProfileSchema } from '@allrice/contracts';
import {
  attachControlledContext,
  type BrowserDriverOptions,
} from './driver.js';
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let browser: Browser;
const origin = 'https://controlled.example.test';
const html = `<!doctype html><title>Synthetic site</title><form id="f" method="post" action="/submit"><input name="username" aria-label="username"><input name="password" type="password" aria-label="password"><button type="submit">Save</button></form>
<input type="file" aria-label="Upload"><a href="/download" download>Download</a><div id="result"></div>
<script>f.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/submit',{method:'POST',body:new URLSearchParams(new FormData(f))});document.querySelector('#result').textContent=await r.text()})</script>`;
const hash = (b: Buffer) =>
  'sha256:' + createHash('sha256').update(b).digest('hex');
suite(
  'P21 real isolated Chromium DOM/request interception (synthetic origin, not production DNS)',
  () => {
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath:
          process.env.ALLRICE_MANAGED_BROWSER_EXECUTABLE ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        chromiumSandbox: true,
      });
    }, 30000);
    afterAll(async () => {
      await browser?.close();
    });
    async function setup(overrides: Partial<BrowserDriverOptions> = {}) {
      const context = await browser.newContext({
          acceptDownloads: true,
          serviceWorkers: 'block',
        }),
        requests: { method: string; path: string }[] = [];
      await context.route('**/*', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        requests.push({ method: request.method(), path });
        if (path === '/submit')
          await route.fulfill({
            status: 200,
            contentType: 'text/plain',
            body: 'saved:synthetic',
          });
        else if (path === '/download')
          await route.fulfill({
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-disposition': 'attachment; filename="synthetic.txt"',
            },
            body: 'synthetic-download',
          });
        else
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: html,
          });
      });
      // Explicit test context injection covers renderer behavior, never the public pinned proxy.
      const driver = await attachControlledContext(
        context,
        {
          close: async () => {
            await context.close();
          },
        } as Browser,
        {
          profileId: randomUUID(),
          profile: BrowserProfileSchema.parse({
            version: 1,
            origins: [origin],
            allowHumanCredentials: true,
            allowDownloads: true,
            allowUploads: true,
          }),
          assertCurrent: async () => {},
          requestApproval: async () => ({ complete: async () => {} }),
          requestSent: () => {},
          requestStarted: () => () => {},
          ...overrides,
        },
        async () => {},
      );
      return { driver, context, requests };
    }
    it('real fill/click cannot send form POST until exact request approval; passwords never appear in observation', async () => {
      let allow!: () => void;
      const pending = new Promise<void>((r) => {
          allow = r;
        }),
        effects: unknown[] = [];
      let finished = false;
      const f = await setup({
        requestApproval: async (effect) => {
          effects.push(effect);
          await pending;
          return {
            complete: async (confirmed) => {
              finished = confirmed;
            },
          };
        },
      });
      try {
        await f.driver.perform({ type: 'navigate', url: origin + '/' }, null);
        let o = (await f.driver.observe(1)).observation;
        const password = o.elements.find((e) => e.sensitive)!;
        await expect(
          f.driver.perform(
            { type: 'fill', elementId: password.id, value: 'forbidden' },
            o,
          ),
        ).rejects.toThrow('BROWSER_SENSITIVE_INPUT_DENIED');
        const bytes = Buffer.from('SyntheticPrivateValue');
        await f.driver.perform(
          {
            type: 'sensitive_fill',
            elementId: password.id,
            inputId: randomUUID(),
          },
          o,
          bytes,
        );
        expect(bytes.every((v) => v === 0)).toBe(true);
        o = (await f.driver.observe(1)).observation;
        expect(JSON.stringify(o)).not.toContain('SyntheticPrivateValue');
        await f.driver.perform(
          {
            type: 'click',
            elementId: o.elements.find((e) => e.tag === 'button')!.id,
          },
          o,
        );
        for (let i = 0; i < 40 && !effects.length; i++) await delay(25);
        expect(effects).toHaveLength(1);
        expect(f.requests.some((r) => r.method === 'POST')).toBe(false);
        expect(effects[0]).toMatchObject({
          url: origin + '/submit',
          method: 'POST',
          urlDigest: hash(Buffer.from(origin + '/submit')),
        });
        expect(JSON.stringify(effects)).not.toContain('SyntheticPrivateValue');
        allow();
        for (let i = 0; i < 80 && !finished; i++) await delay(25);
        expect(finished).toBe(true);
        expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
        expect((await f.driver.observe(1)).observation.text).toContain(
          'saved:synthetic',
        );
      } finally {
        allow();
        await f.driver.close();
      }
    }, 30000);
    it('changed DOM/link, stale observation and different profile elements never execute', async () => {
      const f = await setup();
      try {
        await f.driver.perform({ type: 'navigate', url: origin + '/' }, null);
        const o = (await f.driver.observe(1)).observation;
        const link = o.elements.find((e) => e.tag === 'a')!;
        await f.context
          .pages()[0]!
          .evaluate(() =>
            document.querySelector('a')!.setAttribute('href', '/changed'),
          );
        await expect(
          f.driver.perform({ type: 'click', elementId: link.id }, o),
        ).rejects.toThrow('BROWSER_PAGE_CHANGED');
        await expect(
          f.driver.perform(
            { type: 'click', elementId: link.id },
            { ...o, id: randomUUID() },
          ),
        ).rejects.toThrow('BROWSER_OBSERVATION_STALE');
        expect(f.requests.filter((r) => r.path === '/changed')).toHaveLength(0);
      } finally {
        await f.driver.close();
      }
    }, 30000);
    it('cross-origin subresource and navigation are blocked; revocation denies next request/input', async () => {
      let revoked = false;
      const f = await setup({
        assertCurrent: async () => {
          if (revoked) throw Error('REVOKED');
        },
      });
      try {
        await f.driver.perform({ type: 'navigate', url: origin + '/' }, null);
        const response = await f.context.pages()[0]!.evaluate(async () => {
          try {
            await fetch('https://other.example.test/exfil');
            return 'sent';
          } catch {
            return 'blocked';
          }
        });
        expect(response).toBe('blocked');
        expect(f.requests.some((r) => r.path === '/exfil')).toBe(false);
        await expect(
          f.driver.perform(
            { type: 'navigate', url: 'https://other.example.test/' },
            null,
          ),
        ).rejects.toThrow('BROWSER_ORIGIN_DENIED');
        const o = (await f.driver.observe(1)).observation;
        revoked = true;
        await expect(
          f.driver.perform(
            {
              type: 'click',
              elementId: o.elements.find((e) => e.tag === 'button')!.id,
            },
            o,
          ),
        ).rejects.toThrow('REVOKED');
      } finally {
        await f.driver.close();
      }
    }, 30000);
    it('real file input upload uses bounded checked bytes, never a model-supplied local path', async () => {
      const f = await setup();
      try {
        await f.driver.perform({ type: 'navigate', url: origin + '/' }, null);
        const o = (await f.driver.observe(1)).observation;
        const bytes = Buffer.from('synthetic-upload'),
          file = o.elements.find((e) => e.inputType === 'file')!;
        await f.driver.perform(
          {
            type: 'upload',
            elementId: file.id,
            objectId: randomUUID(),
            checksum: hash(bytes),
            fileName: 'fixture.txt',
          },
          o,
          bytes,
        );
        expect(
          await f.context
            .pages()[0]!
            .locator('input[type=file]')
            .evaluate((el) => (el as HTMLInputElement).files?.[0]?.name),
        ).toBe('fixture.txt');
        // Downloads require the actual HTTPS transport: covered by driver.production.integration.
      } finally {
        await f.driver.close();
      }
    }, 30000);
  },
);
