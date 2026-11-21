import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import { writeEmployeePanelsBaseline } from './employee-panels-baseline';
import { panelsClock } from './fixtures/employee-panels/data';
import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';
import type {} from './fixtures/employee-panels/client';
import {
  assertCausalInvariant,
  assertToolFaviconOutcome,
} from './employee-panels-causal-proof';
import {
  causalJournal,
  observeCausalPage,
} from './employee-panels-causal-network';
import { compareSidebarPixels } from './sidebar-pixels';
import { readPanelsRenderingDiagnostics } from './employee-panels-rendering-diagnostics';

// Exactly two diagnostic cases. A valid experiment is never UI acceptance.
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const memory = (page: Page) =>
  page.locator('section[aria-label="Rice · 记忆"]').filter({ visible: true });
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
const snapshot = (page: Page) =>
  page.evaluate(() => window.__allricePanelsCausalDom!.snapshot());
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const phases = [
  'N0',
  'H',
  'L',
  'T',
  'L-return',
  'N-return',
  'C',
  'N-final',
] as const;
const expectedPngs = [
  'original-native.png',
  'original-rev2.png',
  'unwrapped-native-frame.png',
  'restored-native-frame.png',
  'N0-rev2-frame.png',
  'H-rev2-frame.png',
  ...phases.map((name) => name + '-native-frame.png'),
].sort();

suite('diagnostic-only panels causal probes; no acceptance claim', () => {
  let browser: Browser, artifacts: string;
  beforeAll(async () => {
    const parent = resolve(
      process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ??
        join(tmpdir(), 'allrice-composition-evidence'),
    );
    await mkdir(parent, { recursive: true });
    artifacts = await mkdtemp(join(parent, 'employee-panels-causal-'));
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    await writeFile(
      join(artifacts, 'identity.json'),
      JSON.stringify(
        {
          diagnosticOnly: true,
          acceptanceSatisfied: false,
          cases: 2,
          expectedPaintPhases: phases,
          expectedACompletePngs: expectedPngs,
          expectedBCompletePhases: ['OFF', 'ON'],
          browser: browser.version(),
          node: process.version,
          productSha256: sha(
            await readFile(new URL('../dist/client.js', import.meta.url)),
          ),
        },
        null,
        2,
      ),
    );
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('A: isolates reversible hover/layer/origin/token factors on one real registered panel', async () => {
    const out = join(artifacts, 'a');
    await mkdir(out);
    const journal = causalJournal(),
      contexts: BrowserContext[] = [],
      observers: Awaited<ReturnType<typeof observeCausalPage>>[] = [];
    let host: Awaited<ReturnType<typeof startInstalledProfile>> | undefined;
    let native: Page | undefined, reference: Page | undefined;
    let original: PanelsCausalSnapshot | undefined,
      originalReference: PanelsCausalSnapshot | undefined,
      originalFrame: Buffer | undefined;
    let valid = false;
    const failures: unknown[] = [];
    const records: {
        phase: string;
        snapshot: PanelsCausalSnapshot;
        pngSha256: string;
      }[] = [],
      cleanup: unknown[] = [];
    const frames = new Map<string, Buffer>();
    const save = (name: string, value: unknown) =>
      writeFile(join(out, name), JSON.stringify(value, null, 2));
    try {
      const fixture = await writeEmployeePanelsFixture(out);
      const baseline = await writeEmployeePanelsBaseline(out),
        html = await readFile(baseline, 'utf8');
      const dom = await build({
        entryPoints: [
          fileURLToPath(
            new URL('./employee-panels-causal-dom.ts', import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'AllriceCausalDom',
        platform: 'browser',
        metafile: true,
      });
      const script =
        dom.outputFiles[0]!.text +
        '\nwindow.__allricePanelsCausalDom=AllriceCausalDom.createPanelsCausalDom();';
      await writeFile(join(out, 'causal-dom-client.js'), script);
      await save('causal-dom-build.json', {
        inputs: dom.metafile.inputs,
        sha256: sha(script),
      });
      host = await startInstalledProfile(fixture);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
      });
      contexts.push(context);
      await context.addInitScript((clock) => {
        Date.now = () => Date.parse(clock);
      }, panelsClock);
      native = await context.newPage();
      reference = await context.newPage();
      for (const [name, page] of [
        ['native', native],
        ['reference', reference],
      ] as const) {
        page.setDefaultTimeout(15_000);
        await page.addInitScript({ content: script });
        observers.push(await observeCausalPage(page, name, journal));
      }
      await native.route('**/api/v1/**', async (route) => {
        journal.record('native', 'unprovided-business-request', {
          url: route.request().url(),
          method: route.request().method(),
        });
        await route.abort('blockedbyclient');
      });
      await native.goto(host.authUrl);
      const proceed = native.getByRole('button', { name: /^(Continue|继续)$/ });
      await native.waitForFunction(
        () =>
          window.__allricePanelsIntegration?.evidence().nativeInputReady ===
            true ||
          [...document.querySelectorAll('button')].some((button) =>
            ['Continue', '继续'].includes(button.textContent?.trim() ?? ''),
          ),
      );
      if (await proceed.isVisible()) await proceed.click();
      await native.waitForFunction(
        () =>
          window.__allricePanelsIntegration?.evidence().nativeInputReady ===
          true,
      );
      await native.evaluate(() =>
        window.__allricePanelsIntegration!.setTheme('light'),
      );
      await native
        .locator('[aria-label="工作台入口"]')
        .getByRole('button', { name: /^记忆(?:，|$)/ })
        .click();
      await memory(native).waitFor({ state: 'visible' });
      await native.mouse.move(0, 0);
      await native.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        await document.fonts.ready;
      });
      await settle(native);
      original = await snapshot(native);
      const origin = 'http://allrice-panels-causal-replay.invalid';
      await reference.route(origin + '/**', async (route) => {
        journal.record('reference', 'route-entry', {
          url: route.request().url(),
          method: route.request().method(),
        });
        if (
          new URL(route.request().url()).pathname !== '/' ||
          route.request().method() !== 'GET'
        )
          throw Error('Unprovided reference resource');
        await route.fulfill({ contentType: 'text/html', body: html });
      });
      await reference.goto(
        origin +
          '/?' +
          new URLSearchParams({
            kind: 'experience',
            state: 'list',
            theme: 'light',
            paneWidth: String(original.root.width),
            paneHeight: String(original.root.height),
          }),
      );
      await memory(reference).waitFor({ state: 'visible' });
      await reference.mouse.move(0, 0);
      await reference.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        await document.fonts.ready;
      });
      await settle(reference);
      originalReference = await snapshot(reference);
      const expected = await memory(reference).screenshot({
        path: join(out, 'original-rev2.png'),
        animations: 'disabled',
      });
      const actual = await memory(native).screenshot({
        path: join(out, 'original-native.png'),
        animations: 'disabled',
      });
      await save('original.json', {
        native: original,
        reference: originalReference,
        pixels: compareSidebarPixels(expected, actual),
        interpretation:
          'Original failure retained; diagnostic case never substitutes for the zero-pixel acceptance gate.',
      });
      // Unknown capability failures retain the original element evidence. Keep
      // instrumentation enabled and constant for every full-frame control.
      await save(
        'browser-rendering.json',
        await readPanelsRenderingDiagnostics(
          await browser.newBrowserCDPSession(),
        ),
      );
      for (const observer of observers)
        await observer.session.send('LayerTree.enable');
      await settle(native);
      await settle(reference);
      const protocol = async (name: string) => {
        for (const observer of observers) {
          journal.record(
            observer.side,
            name + '-DOMSnapshot',
            await observer.session.send('DOMSnapshot.captureSnapshot', {
              computedStyles: [],
              includeDOMRects: true,
              includePaintOrder: true,
            }),
          );
          journal.record(
            observer.side,
            name + '-compositingReasons',
            await observer.layers(),
          );
        }
      };
      originalFrame = await native.screenshot({
        path: join(out, 'unwrapped-native-frame.png'),
        fullPage: true,
      });
      await native.evaluate(
        (nonce) => window.__allricePanelsCausalDom!.attach(nonce),
        randomUUID(),
      );
      await settle(native);
      const inspect = async (name: (typeof phases)[number]) => {
        const value = await snapshot(native!);
        const png = await native!.screenshot({
          path: join(out, name + '-native-frame.png'),
          fullPage: true,
        });
        frames.set(name, png);
        await save(name + '.json', value);
        records.push({ phase: name, snapshot: value, pngSha256: sha(png) });
        await protocol(name);
        return { value, png };
      };
      const n0 = await inspect('N0');
      assertCausalInvariant(original, n0.value);
      expect(compareSidebarPixels(originalFrame, n0.png).changedPixels).toBe(0);
      await reference.screenshot({
        path: join(out, 'N0-rev2-frame.png'),
        fullPage: true,
      });
      await native.mouse.move(720, 0);
      await reference.mouse.move(720, 0);
      await settle(native);
      await settle(reference);
      const h = await inspect('H'),
        referenceH = await snapshot(reference);
      await reference.screenshot({
        path: join(out, 'H-rev2-frame.png'),
        fullPage: true,
      });
      await save('H-reference.json', referenceH);
      expect(h.value.pointerOutside && referenceH.pointerOutside).toBe(true);
      assertCausalInvariant(n0.value, h.value, { hover: true });
      assertCausalInvariant(originalReference, referenceH, { hover: true });
      for (const [name, transform] of [
        ['L', 'translate(0px,0px)'],
        ['T', `translate(${-original.root.x}px,${-original.root.y}px)`],
        ['L-return', 'translate(0px,0px)'],
        ['N-return', null],
      ] as const) {
        await native.evaluate(
          (value) => window.__allricePanelsCausalDom!.transform(value),
          transform,
        );
        await settle(native);
        const current = await inspect(name);
        assertCausalInvariant(
          h.value,
          current.value,
          name === 'T' ? { x: -original.root.x, y: -original.root.y } : {},
        );
      }
      await native.evaluate(() =>
        window.__allricePanelsCausalDom!.corner(true),
      );
      await settle(native);
      const c = await inspect('C');
      assertCausalInvariant(h.value, c.value, { corner: true });
      await native.evaluate(() =>
        window.__allricePanelsCausalDom!.corner(false),
      );
      await settle(native);
      const end = await inspect('N-final');
      assertCausalInvariant(h.value, end.value);
      for (const [a, b] of [
        ['L', 'L-return'],
        ['H', 'N-return'],
        ['H', 'N-final'],
      ] as const)
        expect(
          compareSidebarPixels(frames.get(a)!, frames.get(b)!).changedPixels,
          `restoration control ${a}/${b}`,
        ).toBe(0);
      for (const observer of observers) {
        await observer.flush();
        expect(observer.errors).toEqual([]);
      }
      valid = true;
    } catch (error) {
      failures.push(error);
      await save('failure.json', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
        valid: false,
      });
    } finally {
      try {
        if (native && !native.isClosed()) {
          const result = await native.evaluate(
            () =>
              window.__allricePanelsCausalDom?.restore() ?? {
                allocated: false,
                restored: true,
              },
          );
          cleanup.push(result);
          await native.mouse.move(0, 0);
          await settle(native);
          const restored = await snapshot(native);
          await save('restored.json', restored);
          const png = await native.screenshot({
            path: join(out, 'restored-native-frame.png'),
            fullPage: true,
          });
          if (original) assertCausalInvariant(original, restored);
          if (originalFrame)
            expect(compareSidebarPixels(originalFrame, png).changedPixels).toBe(
              0,
            );
          expect(result.restored).toBe(true);
        }
        if (reference && !reference.isClosed() && originalReference) {
          await reference.mouse.move(0, 0);
          await settle(reference);
          assertCausalInvariant(originalReference, await snapshot(reference));
        }
        if (valid)
          expect(
            (await readdir(out)).filter((name) => name.endsWith('.png')).sort(),
          ).toEqual(expectedPngs);
      } catch (error) {
        valid = false;
        cleanup.push({ error: String(error) });
        failures.push(error);
      } finally {
        try {
          try {
            for (const observer of observers) await observer.close();
          } finally {
            try {
              for (const context of contexts) await context.close();
            } finally {
              await host?.close();
            }
          }
        } catch (error) {
          valid = false;
          failures.push(error);
          cleanup.push({ closeError: String(error) });
        } finally {
          for (const observer of observers)
            if (observer.errors.length) {
              valid = false;
              cleanup.push({
                side: observer.side,
                publicErrors: observer.errors,
              });
              failures.push(
                new Error(
                  'Unknown public runtime/network errors remain after diagnostic cleanup',
                ),
              );
            }
          await save('events.json', journal.events);
          await save('result.json', {
            diagnosticOnly: true,
            acceptanceSatisfied: false,
            valid,
            failures: failures.map((error) => ({
              message: String(error),
              stack: error instanceof Error ? error.stack : null,
            })),
            phases: records,
            cleanup,
            expectedPngs,
            actualPngs: (await readdir(out))
              .filter((name) => name.endsWith('.png'))
              .sort(),
          });
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Causal experiment/cleanup failed');
  }, 180_000);

  it('B: proves route OFF/ON favicon order using only the same local HTTP entities', async () => {
    const out = join(artifacts, 'b');
    await mkdir(out);
    const journal = causalJournal(),
      results: unknown[] = [],
      contexts: BrowserContext[] = [];
    const icon = await readFile(
      new URL('../../../apps/web/public/favicon.ico', import.meta.url),
    );
    const html =
      '<!doctype html><html><head><title>Tool-only route probe</title></head><body>Not panel acceptance.</body></html>';
    let active: 'OFF' | 'ON' = 'OFF',
      valid = false;
    const failures: unknown[] = [];
    const hits: {
      mode: string;
      path: string;
      method: string;
      status: number;
      sha256: string;
    }[] = [];
    const unknown: unknown[] = [];
    const server = createServer((request, response) => {
      const path = request.url,
        provided =
          request.method === 'GET' && (path === '/' || path === '/favicon.ico');
      const body = path === '/favicon.ico' ? icon : Buffer.from(html),
        status = provided ? 200 : 404;
      const record = {
        mode: active,
        path: path ?? '',
        method: request.method ?? '',
        status,
        sha256: sha(body),
      };
      hits.push(record);
      journal.record('server', 'request', record);
      if (!provided) unknown.push(record);
      response.writeHead(status, {
        'Content-Type':
          path === '/favicon.ico' ? 'image/x-icon' : 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      response.on('finish', () => journal.record('server', 'finish', record));
      response.end(body);
    });
    server.on('error', (error) => {
      unknown.push(String(error));
      journal.record('server', 'error', String(error));
    });
    server.on('clientError', (error, socket) => {
      unknown.push(String(error));
      journal.record('server', 'clientError', String(error));
      socket.destroy();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Missing owned loopback HTTP address');
      const origin = `http://127.0.0.1:${address.port}`;
      for (const mode of ['OFF', 'ON'] as const) {
        active = mode;
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          timezoneId: 'UTC',
        });
        contexts.push(context);
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const trace = await observeCausalPage(page, mode, journal),
          routes: string[] = [];
        if (mode === 'ON')
          await page.route(origin + '/**', async (route) => {
            routes.push(route.request().url());
            journal.record(mode, 'route-entry', {
              url: route.request().url(),
              method: route.request().method(),
            });
            await route.continue();
            journal.record(mode, 'route-continued', {
              url: route.request().url(),
            });
          });
        await Promise.all([
          trace.terminal(origin + '/favicon.ico'),
          page.goto(origin),
        ]);
        await trace.flush();
        await trace.close();
        await context.close();
        const requests = [...trace.requests.values()];
        const found = requests.filter(
          (request) => request.url === origin + '/favicon.ico',
        );
        const outcome = {
          mode,
          starts: found.length,
          method: found[0]?.method ?? '',
          status: found[0]?.status,
          finished: found[0]?.finished,
          failure: found[0]?.failure,
          canceled: found[0]?.canceled,
          routeEntries: routes.filter((url) => url === origin + '/favicon.ico')
            .length,
          serverHits: hits.filter(
            (hit) => hit.mode === mode && hit.path === '/favicon.ico',
          ).length,
          unknownErrors: unknown.length + trace.errors.length,
        };
        results.push({
          ...outcome,
          requests,
          routeEntriesRaw: routes,
          publicErrors: trace.errors,
        });
        assertToolFaviconOutcome(outcome);
        expect(requests.map((request) => request.url).sort()).toEqual(
          [origin + '/', origin + '/favicon.ico'].sort(),
        );
        expect(requests.every((request) => request.method === 'GET')).toBe(
          true,
        );
        const document = requests.find(
          (request) => request.url === origin + '/',
        );
        expect(document?.status).toBe(200);
        expect(document?.finished).toBe(true);
        expect(document?.failure).toBeUndefined();
        expect(routes).toEqual(mode === 'ON' ? [origin + '/'] : []);
        expect(
          hits.filter((hit) => hit.mode === mode && hit.path === '/'),
        ).toEqual([
          { mode, path: '/', method: 'GET', status: 200, sha256: sha(html) },
        ]);
      }
      expect(
        hits.map((hit) => hit.sha256).filter((value) => value === sha(icon)),
      ).toHaveLength(1);
      valid = true;
    } catch (error) {
      failures.push(error);
      journal.record('experiment', 'failure', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
      });
    } finally {
      try {
        try {
          for (const context of contexts) await context.close();
        } finally {
          server.closeAllConnections();
          if (server.listening)
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
        }
      } catch (error) {
        valid = false;
        failures.push(error);
        journal.record('cleanup', 'failure', String(error));
      } finally {
        if (unknown.length) {
          valid = false;
          failures.push(new Error('Unknown owned HTTP fixture errors remain'));
        }
        await writeFile(
          join(out, 'result.json'),
          JSON.stringify(
            {
              diagnosticOnly: true,
              acceptanceSatisfied: false,
              valid,
              phases: results,
              hits,
              unknown,
              htmlSha256: sha(html),
              iconSha256: sha(icon),
              events: journal.events,
            },
            null,
            2,
          ),
        );
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Tool experiment/cleanup failed');
  }, 180_000);
});
