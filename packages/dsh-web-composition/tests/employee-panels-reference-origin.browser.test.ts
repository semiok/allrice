import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import { writeEmployeePanelsBaseline } from './employee-panels-baseline';
import { panelsClock } from './fixtures/employee-panels/data';
import type {} from './fixtures/employee-panels/client';
import {
  assertCausalInvariant,
  assertCausalSampling,
} from './employee-panels-causal-proof';
import {
  causalJournal,
  causalReplayOrigin,
  observeCausalPage,
  type CausalReplayRegistration,
} from './employee-panels-causal-network';
import { compareSidebarPixels } from './sidebar-pixels';
import {
  comparePanelsOriginContent,
  cropPanelsOriginFrame,
} from './employee-panels-reference-origin';

// One reverse-origin experiment. A/B and the original 9 cases/80 pairs stay intact.
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const labels = [
  'native-start',
  'reference-original',
  'reference-zero',
  'reference-native-origin',
  'reference-return',
  'reference-restored',
  'native-end',
] as const;
const expectedPngs = labels
  .flatMap((label) =>
    ['frame', 'element', 'panel-window'].map((kind) => `${label}-${kind}.png`),
  )
  .sort();
const memory = (page: Page) =>
  page.locator('section[aria-label="Rice · 记忆"]').filter({ visible: true });
const snapshot = (page: Page) =>
  page.evaluate(() => window.__allricePanelsCausalDom!.snapshot());
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
const sha = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

// This handle owns only a new reference host. Product nodes/styles are never edited.
// Keep translate(...) present in all three formal phases, then remove this host.
async function referenceHost(page: Page, width: number, height: number) {
  return page.evaluateHandle(
    ({ width, height, nonce }) => {
      const app = document.getElementById('root'),
        panel = document.querySelector('section[aria-label="Rice · 记忆"]');
      if (
        !app ||
        app.parentNode !== document.body ||
        !panel ||
        !app.contains(panel)
      )
        throw Error('Missing isolated reference root');
      const surface = panel.parentElement!;
      const original = {
        app: app.getAttribute('style'),
        surface: surface.getAttribute('style'),
      };
      const parent = document.body,
        next = app.nextSibling,
        wrapper = document.createElement('div');
      wrapper.dataset.referenceOriginOwner = nonce;
      wrapper.style.cssText = `width:${width}px;height:${height}px;min-height:0;transform:translate(0px,0px)`;
      let expectedStyle = wrapper.getAttribute('style');
      const sameNodes = () => {
        if (
          document.getElementById('root') !== app ||
          panel.parentElement !== surface ||
          !app.contains(surface) ||
          app.getAttribute('style') !== original.app ||
          surface.getAttribute('style') !== original.surface
        )
          throw Error(
            'Reference identity or original style changed; refuse mutation',
          );
      };
      const wrapped = () => {
        sameNodes();
        if (
          wrapper.parentNode !== parent ||
          app.parentNode !== wrapper ||
          wrapper.nextSibling !== next ||
          wrapper.childNodes.length !== 1 ||
          wrapper.attributes.length !== 2 ||
          wrapper.dataset.referenceOriginOwner !== nonce ||
          wrapper.getAttribute('style') !== expectedStyle
        )
          throw Error('Reference host ownership changed; refuse mutation');
      };
      return {
        attach() {
          sameNodes();
          if (
            app.parentNode !== parent ||
            app.nextSibling !== next ||
            wrapper.parentNode
          )
            throw Error('Reference order changed before attach');
          parent.insertBefore(wrapper, app);
          wrapper.append(app);
          wrapped();
          return { original, wrapperStyle: expectedStyle };
        },
        move(x: number, y: number) {
          wrapped();
          wrapper.style.transform = `translate(${x}px,${y}px)`;
          expectedStyle = wrapper.getAttribute('style');
          return { original, wrapperStyle: expectedStyle };
        },
        restore() {
          sameNodes();
          if (app.parentNode === wrapper) {
            wrapped();
            parent.insertBefore(app, wrapper);
            wrapper.remove();
          } else if (
            wrapper.parentNode ||
            app.parentNode !== parent ||
            app.nextSibling !== next
          )
            throw Error(
              'Reference partial attachment cannot be safely restored',
            );
          sameNodes();
          const restored =
            app.parentNode === parent &&
            app.nextSibling === next &&
            !wrapper.isConnected;
          if (!restored) throw Error('Reference DOM order not restored');
          return {
            restored,
            original,
            actual: {
              app: app.getAttribute('style'),
              surface: surface.getAttribute('style'),
            },
          };
        },
      };
    },
    { width, height, nonce: randomUUID() },
  );
}

suite('diagnostic-only reverse reference origin; no acceptance claim', () => {
  let browser: Browser, artifacts: string;
  beforeAll(async () => {
    const parent = resolve(
      process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ??
        join(tmpdir(), 'allrice-composition-evidence'),
    );
    await mkdir(parent, { recursive: true });
    artifacts = await mkdtemp(
      join(parent, 'employee-panels-reference-origin-'),
    );
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
          cases: 1,
          phases: [
            'reference-zero',
            'reference-native-origin',
            'reference-return',
          ],
          expectedPngs,
          captureOrder: [
            'fullPage PNG',
            'lossless saved-frame ROI PNG',
            'formal element PNG',
          ],
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
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

  it('C: reversibly moves only the reference host to the untouched native slot origin', async () => {
    const out = join(artifacts, 'c');
    await mkdir(out);
    const save = (name: string, value: unknown) =>
      writeFile(join(out, name), JSON.stringify(value, null, 2));
    const journal = causalJournal(),
      observers: Awaited<ReturnType<typeof observeCausalPage>>[] = [];
    const captures: Record<string, unknown> = {},
      phases: unknown[] = [],
      cleanup: unknown[] = [],
      failures: unknown[] = [];
    let host: Awaited<ReturnType<typeof startInstalledProfile>> | undefined;
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    let native: Page | undefined, reference: Page | undefined;
    let owner: Awaited<ReturnType<typeof referenceHost>> | undefined;
    let start: Awaited<ReturnType<typeof capture>> | undefined,
      original: Awaited<ReturnType<typeof capture>> | undefined;
    let zero: Awaited<ReturnType<typeof capture>> | undefined,
      aligned: Awaited<ReturnType<typeof capture>> | undefined;
    let returned: Awaited<ReturnType<typeof capture>> | undefined;
    let valid = false;
    const compare = (
      a: Awaited<ReturnType<typeof capture>>,
      b: Awaited<ReturnType<typeof capture>>,
    ) => ({
      formalElement: compareSidebarPixels(a.element, b.element),
      fullFramePanelWindow: compareSidebarPixels(a.window, b.window),
      fullFrame: compareSidebarPixels(a.frame, b.frame),
    });
    const unchanged = (
      a: Awaited<ReturnType<typeof capture>>,
      b: Awaited<ReturnType<typeof capture>>,
      label: string,
    ) => {
      const result = compare(a, b);
      for (const [kind, pixels] of Object.entries(result))
        expect(pixels.changedPixels, label + '/' + kind).toBe(0);
      const pngShaMatches = {
        formalElement: sha(a.element) === sha(b.element),
        fullFramePanelWindow: sha(a.window) === sha(b.window),
        fullFrame: sha(a.frame) === sha(b.frame),
      };
      expect(pngShaMatches, label + '/exact PNG bytes').toEqual({
        formalElement: true,
        fullFramePanelWindow: true,
        fullFrame: true,
      });
      return { ...result, pngShaMatches };
    };
    async function capture(page: Page, label: (typeof labels)[number]) {
      const value = await snapshot(page);
      assertCausalSampling(value);
      // Save the actual full frame before any element screenshot. The ROI below
      // is decoded from these bytes, not a second clip/element capture.
      const frame = await page.screenshot({
        path: join(out, label + '-frame.png'),
        fullPage: true,
      });
      expect(compareSidebarPixels(frame, frame).expected).toEqual({
        width: 1440,
        height: 1000,
      });
      const window = cropPanelsOriginFrame(frame, value.root);
      await writeFile(join(out, label + '-panel-window.png'), window);
      const element = await memory(page).screenshot({
        path: join(out, label + '-element.png'),
        animations: 'disabled',
      });
      const after = await snapshot(page);
      await save(label + '.json', {
        beforeCapture: value,
        afterCapture: after,
        frameSha256: sha(frame),
        fullFrameWindow: {
          rect: value.root,
          sourceFrameSha256: sha(frame),
          pngSha256: sha(window),
        },
        formalElementSha256: sha(element),
      });
      captures[label] = {
        root: value.root,
        frameSha256: sha(frame),
        windowSha256: sha(window),
        elementSha256: sha(element),
      };
      assertCausalInvariant(value, after);
      return { value, frame, window, element };
    }
    try {
      const fixture = await writeEmployeePanelsFixture(out);
      const baseline = await writeEmployeePanelsBaseline(out),
        html = await readFile(baseline, 'utf8');
      await save('baseline-transport.json', {
        htmlSha256: sha(html),
        source:
          'unmodified writeEmployeePanelsBaseline output; original bytes fulfilled',
      });
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
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
      });
      await context.addInitScript((clock) => {
        Date.now = () => Date.parse(clock);
      }, panelsClock);
      native = await context.newPage();
      reference = await context.newPage();
      for (const [side, page] of [
        ['native', native],
        ['reference', reference],
      ] as const) {
        page.setDefaultTimeout(15_000);
        await page.addInitScript({ content: script });
        observers.push(await observeCausalPage(page, side, journal));
      }
      await native.route('**/api/v1/**', async (route) => {
        journal.record('native', 'unprovided-business-request', {
          url: route.request().url(),
          method: route.request().method(),
        });
        await route.abort('blockedbyclient');
      });
      await native.goto(host.authUrl);
      await native.waitForFunction(
        () =>
          window.__allricePanelsIntegration?.evidence().nativeInputReady ===
            true ||
          [...document.querySelectorAll('button')].some((button) =>
            ['Continue', '继续'].includes(button.textContent?.trim() ?? ''),
          ),
      );
      const proceed = native.getByRole('button', { name: /^(Continue|继续)$/ });
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
      await native.mouse.move(720, 0);
      await native.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        await document.fonts.ready;
      });
      await settle(native);
      start = await capture(native, 'native-start');
      // Bind this reverse test to the exact representative diagnosed by A.
      expect(start.value.root).toEqual({
        x: 793,
        y: 38,
        width: 647,
        height: 962,
      });
      const navigationUrl =
        causalReplayOrigin +
        '/?' +
        new URLSearchParams({
          kind: 'experience',
          state: 'list',
          theme: 'light',
          paneWidth: String(start.value.root.width),
          paneHeight: String(start.value.root.height),
        });
      const replay: CausalReplayRegistration = {
        id: randomUUID(),
        origin: causalReplayOrigin,
        navigationUrl,
        method: 'GET',
        bodySha256: sha(html),
      };
      journal.record('reference', 'replay-registration', replay);
      await reference.route(replay.origin + '/**', async (route) => {
        const receipt = {
          ...replay,
          url: route.request().url(),
          method: route.request().method(),
        };
        journal.record('reference', 'route-entry', receipt);
        if (receipt.url !== replay.navigationUrl || receipt.method !== 'GET')
          throw Error('Unprovided reference resource');
        journal.record('reference', 'route-fulfill-issued', {
          ...receipt,
          status: 200,
        });
        await route.fulfill({
          contentType: 'text/html',
          body: html,
          headers: { 'x-allrice-causal-replay': replay.id },
        });
        journal.record('reference', 'route-fulfilled', {
          ...receipt,
          status: 200,
        });
      });
      await Promise.all([
        observers[1]!.terminal(replay.origin + '/favicon.ico'),
        reference.goto(navigationUrl).then((navigation) =>
          journal.record('reference', 'replay-navigation-complete', {
            ...replay,
            url: reference!.url(),
            method: navigation?.request().method(),
            status: navigation?.status(),
            mainFrame: navigation?.frame() === reference!.mainFrame(),
          }),
        ),
      ]);
      await memory(reference).waitFor({ state: 'visible' });
      await reference.mouse.move(720, 0);
      await reference.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
        await document.fonts.ready;
      });
      await settle(reference);
      original = await capture(reference, 'reference-original');
      expect(original.value.root).toEqual({ ...start.value.root, x: 0, y: 0 });
      owner = await referenceHost(
        reference,
        original.value.root.width,
        original.value.root.height,
      );
      const attachedHost = await owner.evaluate((value) => value.attach());
      await save('reference-host-attach.json', attachedHost);
      await settle(reference);
      zero = await capture(reference, 'reference-zero');
      assertCausalInvariant(original.value, zero.value);
      await save(
        'zero-wrapper-control.json',
        unchanged(original, zero, 'wrapper/translate-zero control'),
      );
      const dx = start.value.root.x - zero.value.root.x,
        dy = start.value.root.y - zero.value.root.y;
      const recordContent = async (
        label: string,
        current: Awaited<ReturnType<typeof capture>>,
      ) => {
        const nativeValue = await snapshot(native!);
        assertCausalInvariant(start!.value, nativeValue);
        const differences = comparePanelsOriginContent(
          nativeValue,
          current.value,
        );
        await save(label + '-content.json', {
          native: nativeValue,
          reference: current.value,
          differences,
          knownRawCornerTokenDifferences: differences.filter((entry) =>
            entry.field.endsWith('.--dsw-corner-shape'),
          ),
        });
        phases.push({
          phase: label,
          nativeRoot: nativeValue.root,
          referenceRoot: current.value.root,
          allMeasuredDifferences: differences,
        });
        expect(
          differences.filter(
            (entry) => !entry.field.endsWith('.--dsw-corner-shape'),
          ),
        ).toEqual([]);
      };
      await recordContent('reference-zero', zero);
      for (const [label, x, y] of [
        ['reference-native-origin', dx, dy],
        ['reference-return', 0, 0],
      ] as const) {
        const movedHost = await owner.evaluate(
          (value, point) => value.move(point.x, point.y),
          {
            x,
            y,
          },
        );
        await save(label + '-host.json', movedHost);
        if (label === 'reference-return')
          expect(movedHost.wrapperStyle).toBe(attachedHost.wrapperStyle);
        await settle(reference);
        const current = await capture(reference, label);
        if (label === 'reference-native-origin') aligned = current;
        else returned = current;
        assertCausalInvariant(zero.value, current.value, { x, y });
        await recordContent(label, current);
      }
      await save(
        'reference-return-control.json',
        unchanged(zero, returned!, 'reference return'),
      );
      await save('comparisons.json', {
        before: compare(start, original),
        atZero: compare(start, zero),
        aligned: compare(start, aligned!),
        returned: compare(start, returned!),
        note: 'Full-frame background/layout is retained and reported separately; fullFramePanelWindow is a lossless ROI of each original fullPage PNG. No pixels are masked or tolerated.',
      });
      valid = true;
    } catch (error) {
      failures.push(error);
      await save('failure.json', {
        message: String(error),
        stack: error instanceof Error ? error.stack : null,
      });
    } finally {
      try {
        if (owner) {
          cleanup.push(await owner.evaluate((value) => value.restore()));
          if (reference && original) {
            await settle(reference);
            const restored = await capture(reference, 'reference-restored');
            assertCausalInvariant(original.value, restored.value);
            await save(
              'reference-restored-control.json',
              unchanged(original, restored, 'reference exact detach'),
            );
          }
        }
      } catch (error) {
        valid = false;
        failures.push(error);
        cleanup.push({ restorationError: String(error) });
      }
      try {
        if (native && start) {
          const end = await capture(native, 'native-end');
          assertCausalInvariant(start.value, end.value);
          await save(
            'native-unchanged-control.json',
            unchanged(start, end, 'untouched native before/after'),
          );
        }
      } catch (error) {
        valid = false;
        failures.push(error);
        cleanup.push({ nativeControlError: String(error) });
      }
      try {
        for (const observer of observers) {
          await observer.flush();
          observer.assertClean();
        }
      } catch (error) {
        valid = false;
        failures.push(error);
        cleanup.push({ networkError: String(error) });
      }
      try {
        try {
          for (const observer of observers) await observer.close();
        } finally {
          try {
            await context?.close();
          } finally {
            await host?.close();
          }
        }
      } catch (error) {
        valid = false;
        failures.push(error);
        cleanup.push({ closeError: String(error) });
      }
      const audits = observers.map((observer) => ({
        side: observer.side,
        ...observer.audit(),
      }));
      if (
        audits.some(
          (audit) =>
            audit.publicErrors.length ||
            audit.issues.length ||
            audit.unknownCdpFailures.length,
        )
      ) {
        valid = false;
        failures.push(
          Error('Unknown public/CDP outcomes remain after cleanup'),
        );
      }
      const actualPngs = (await readdir(out))
        .filter((name) => name.endsWith('.png'))
        .sort();
      if (
        valid &&
        JSON.stringify(actualPngs) !== JSON.stringify(expectedPngs)
      ) {
        valid = false;
        failures.push(Error('Exact reverse-origin PNG inventory differs'));
      }
      const alignedPixels = start && aligned ? compare(start, aligned) : null;
      const supportsReferenceOrigin =
        valid &&
        alignedPixels?.formalElement.changedPixels === 0 &&
        alignedPixels.fullFramePanelWindow.changedPixels === 0;
      await save('network-audit.json', audits);
      await save('events.json', journal.events);
      await save('result.json', {
        diagnosticOnly: true,
        acceptanceSatisfied: false,
        valid,
        supportsReferenceOrigin,
        measuredScope:
          'One 1440/light/list/experience panel; existing discrete sampling validity only. No whole-domain visibility, other79 pairs or product fix is proved.',
        nativeNeverWrappedOrMoved: true,
        phases,
        captures,
        alignedPixels,
        expectedPngs,
        actualPngs,
        cleanup,
        failures: failures.map((error) => ({
          message: String(error),
          stack: error instanceof Error ? error.stack : null,
        })),
      });
      await owner?.dispose();
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Reverse-origin diagnostic/cleanup failed',
      );
    expect(valid).toBe(true);
    expect(
      compare(start!, aligned!).formalElement.changedPixels,
      'same-origin formal element pixels',
    ).toBe(0);
    expect(
      compare(start!, aligned!).fullFramePanelWindow.changedPixels,
      'same-origin saved full-frame panel pixels',
    ).toBe(0);
  }, 180_000);
});
