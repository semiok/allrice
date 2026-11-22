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
import {
  assertPlacementAncestors,
  classifyNativePlacementEffect,
  placementWrapperIdentity,
} from './employee-panels-native-placement';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const labels = [
  'native-original',
  'reference-start',
  'native-attached',
  'native-transform',
  'native-layout',
  'native-transform-return',
  'native-restored',
  'reference-end',
] as const;
const phases = [
  'native-transform',
  'native-layout',
  'native-transform-return',
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

// This closure owns a new DOM host only. Existing product nodes/styles are never edited.
async function nativeHost(page: Page, offset: { x: number; y: number }) {
  return page.evaluateHandle(
    ({ offset, nonce }) => {
      const panel = document.querySelector('section[aria-label="Rice · 记忆"]');
      if (!(panel instanceof HTMLElement))
        throw Error('Missing isolated native panel');
      const surface = panel.parentElement!;
      let app = panel;
      while (app.parentElement && app.parentElement !== document.body)
        app = app.parentElement;
      if (app.parentElement !== document.body)
        throw Error('Missing native application root');
      const parent = document.body,
        next = app.nextSibling;
      const original = {
        app: app.getAttribute('style'),
        surface: surface.getAttribute('style'),
      };
      const wrapper = document.createElement('div');
      wrapper.dataset.nativePlacementOwner = nonce;
      wrapper.style.cssText =
        'width:100%;height:100%;min-height:0;position:relative;left:0;top:0;transform:translate(0px,0px)';
      let expectedStyle = wrapper.getAttribute('style');
      let mode: 'identity' | 'transform' | 'layout' = 'identity';
      const sameNodes = () => {
        if (
          panel.parentElement !== surface ||
          !app.contains(surface) ||
          app.getAttribute('style') !== original.app ||
          surface.getAttribute('style') !== original.surface
        )
          throw Error('Native identity/style changed; refuse mutation');
      };
      const wrapped = () => {
        sameNodes();
        if (
          wrapper.parentNode !== parent ||
          app.parentNode !== wrapper ||
          wrapper.nextSibling !== next ||
          wrapper.childNodes.length !== 1 ||
          wrapper.attributes.length !== 2 ||
          wrapper.dataset.nativePlacementOwner !== nonce ||
          wrapper.getAttribute('style') !== expectedStyle
        )
          throw Error('Native host ownership changed; refuse mutation');
      };
      const measure = () => {
        const rect = (node: Element) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        const clipMetrics = [];
        for (
          let node: HTMLElement | null = panel.parentElement;
          node;
          node = node.parentElement
        )
          clipMetrics.push({
            tag: node.tagName,
            className: node.getAttribute('class'),
            ownedWrapper: node === wrapper,
            rect: rect(node),
            clientLeft: node.clientLeft,
            clientTop: node.clientTop,
            clientWidth: node.clientWidth,
            clientHeight: node.clientHeight,
            scrollLeft: node.scrollLeft,
            scrollTop: node.scrollTop,
            scrollWidth: node.scrollWidth,
            scrollHeight: node.scrollHeight,
            offsetWidth: node.offsetWidth,
            offsetHeight: node.offsetHeight,
          });
        const scroll = document.scrollingElement,
          viewport = window.visualViewport;
        return {
          clipMetrics,
          document: {
            innerWidth,
            innerHeight,
            scrollX,
            scrollY,
            scrollWidth: scroll?.scrollWidth,
            scrollHeight: scroll?.scrollHeight,
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
            viewport: viewport && {
              width: viewport.width,
              height: viewport.height,
              offsetLeft: viewport.offsetLeft,
              offsetTop: viewport.offsetTop,
              pageLeft: viewport.pageLeft,
              pageTop: viewport.pageTop,
              scale: viewport.scale,
            },
          },
        };
      };
      const inspect = () => {
        wrapped();
        const style = getComputedStyle(wrapper);
        const placement = {
          position: style.position,
          left: style.left,
          top: style.top,
          transform: style.transform,
        };
        const x = mode === 'layout' ? offset.x : 0,
          y = mode === 'layout' ? offset.y : 0;
        const tx = mode === 'transform' ? offset.x : 0,
          ty = mode === 'transform' ? offset.y : 0;
        if (
          placement.position !== 'relative' ||
          placement.left !== `${x}px` ||
          placement.top !== `${y}px` ||
          placement.transform !== `matrix(1, 0, 0, 1, ${tx}, ${ty})`
        )
          throw Error('Owned placement does not equal the declared mechanism');
        return {
          mode,
          offset,
          original,
          rawStyle: expectedStyle,
          placement,
          metrics: measure(),
        };
      };
      return {
        attach() {
          sameNodes();
          if (
            app.parentNode !== parent ||
            app.nextSibling !== next ||
            wrapper.parentNode
          )
            throw Error('Native order changed before attachment');
          parent.insertBefore(wrapper, app);
          wrapper.append(app);
          return inspect();
        },
        place(value: 'transform' | 'layout') {
          wrapped();
          wrapper.style.left = `${value === 'layout' ? offset.x : 0}px`;
          wrapper.style.top = `${value === 'layout' ? offset.y : 0}px`;
          wrapper.style.transform = `translate(${value === 'transform' ? offset.x : 0}px,${value === 'transform' ? offset.y : 0}px)`;
          mode = value;
          expectedStyle = wrapper.getAttribute('style');
          return inspect();
        },
        inspect,
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
            throw Error('Native attachment cannot be safely restored');
          const restored =
            app.parentNode === parent &&
            app.nextSibling === next &&
            !wrapper.isConnected;
          if (!restored) throw Error('Native DOM order not restored');
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
    { offset, nonce: randomUUID() },
  );
}

suite(
  'diagnostic-only fixed-origin native placement; no acceptance claim',
  () => {
    let browser: Browser, artifacts: string;
    beforeAll(async () => {
      const parent = resolve(
        process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ??
          join(tmpdir(), 'allrice-composition-evidence'),
      );
      await mkdir(parent, { recursive: true });
      artifacts = await mkdtemp(
        join(parent, 'employee-panels-native-placement-'),
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
            phases,
            expectedPngs,
            captureOrder: [
              'fullPage PNG',
              'lossless saved-frame ROI PNG',
              'formal element PNG',
            ],
            protocol: {
              networkAndLog: true,
              layerTreeFromBeforeNavigation: true,
              domSnapshotAfterEveryCapture: true,
            },
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

    it('D: compares transform and layout placement of the same native host at a fixed final origin', async () => {
      const out = join(artifacts, 'd');
      await mkdir(out);
      const save = (name: string, value: unknown) =>
        writeFile(join(out, name), JSON.stringify(value, null, 2));
      const journal = causalJournal(),
        observers: Awaited<ReturnType<typeof observeCausalPage>>[] = [];
      const captures: Record<string, unknown> = {},
        phaseRecords: unknown[] = [],
        cleanup: unknown[] = [],
        failures: unknown[] = [];
      let context: Awaited<ReturnType<Browser['newContext']>> | undefined,
        host: Awaited<ReturnType<typeof startInstalledProfile>> | undefined;
      let native: Page | undefined,
        reference: Page | undefined,
        owner: Awaited<ReturnType<typeof nativeHost>> | undefined;
      let original: Awaited<ReturnType<typeof capture>> | undefined,
        refStart: Awaited<ReturnType<typeof capture>> | undefined;
      let baseline: Awaited<ReturnType<typeof capture>> | undefined,
        transform: Awaited<ReturnType<typeof capture>> | undefined,
        layout: Awaited<ReturnType<typeof capture>> | undefined,
        returned: Awaited<ReturnType<typeof capture>> | undefined;
      let valid = false,
        wrapperIdentity: number | undefined;
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
        const pixels = compare(a, b),
          pngShaMatches = {
            formalElement: sha(a.element) === sha(b.element),
            fullFramePanelWindow: sha(a.window) === sha(b.window),
            fullFrame: sha(a.frame) === sha(b.frame),
          };
        for (const [kind, value] of Object.entries(pixels))
          expect(value.changedPixels, label + '/' + kind).toBe(0);
        expect(pngShaMatches, label + '/PNG bytes').toEqual({
          formalElement: true,
          fullFramePanelWindow: true,
          fullFrame: true,
        });
        return { ...pixels, pngShaMatches };
      };
      async function capture(
        page: Page,
        label: (typeof labels)[number],
        inspectOwner = false,
      ) {
        const value = await snapshot(page),
          ownerBefore = inspectOwner
            ? await owner!.evaluate((handle) => handle.inspect())
            : null;
        assertCausalSampling(value);
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
        const after = await snapshot(page),
          ownerAfter = inspectOwner
            ? await owner!.evaluate((handle) => handle.inspect())
            : null;
        await save(label + '.json', {
          beforeCapture: value,
          afterCapture: after,
          ownerBefore,
          ownerAfter,
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
        expect(after.ancestors).toEqual(value.ancestors);
        expect(ownerAfter).toEqual(ownerBefore);
        for (const observer of observers) {
          journal.record(
            observer.side,
            label + '-DOMSnapshot',
            await observer.session.send('DOMSnapshot.captureSnapshot', {
              computedStyles: [],
              includeDOMRects: true,
              includePaintOrder: true,
            }),
          );
          journal.record(
            observer.side,
            label + '-compositingReasons',
            await observer.layers(),
          );
        }
        return { value, frame, window, element, owner: ownerBefore };
      }
      try {
        const fixture = await writeEmployeePanelsFixture(out),
          baselinePath = await writeEmployeePanelsBaseline(out),
          html = await readFile(baselinePath, 'utf8');
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
          const observer = await observeCausalPage(page, side, journal);
          observers.push(observer);
          // Required diagnostics are enabled on blank pages, before either UI navigates.
          // There is no optional capability toggle between baselines or formal phases.
          await observer.session.send('LayerTree.enable');
          journal.record(side, 'placement-protocol-ready', {
            beforeNavigation: true,
            layerTreeEnabled: true,
          });
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
        const proceed = native.getByRole('button', {
          name: /^(Continue|继续)$/,
        });
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
        const nativeRoot = (await snapshot(native)).root;
        expect(nativeRoot).toEqual({ x: 793, y: 38, width: 647, height: 962 });
        const replay: CausalReplayRegistration = {
          id: randomUUID(),
          origin: causalReplayOrigin,
          navigationUrl:
            causalReplayOrigin +
            '/?' +
            new URLSearchParams({
              kind: 'experience',
              state: 'list',
              theme: 'light',
              paneWidth: String(nativeRoot.width),
              paneHeight: String(nativeRoot.height),
            }),
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
          reference.goto(replay.navigationUrl).then((navigation) =>
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
        for (const page of [native, reference]) {
          await page.mouse.move(720, 0);
          await page.evaluate(async () => {
            if (document.activeElement instanceof HTMLElement)
              document.activeElement.blur();
            await document.fonts.ready;
          });
          await settle(page);
        }
        original = await capture(native, 'native-original');
        refStart = await capture(reference, 'reference-start');
        expect(refStart.value.root).toEqual({ ...nativeRoot, x: 0, y: 0 });
        const offset = { x: -nativeRoot.x, y: -nativeRoot.y };
        owner = await nativeHost(native, offset);
        await save(
          'host-attach.json',
          await owner.evaluate((handle) => handle.attach()),
        );
        await settle(native);
        baseline = await capture(native, 'native-attached', true);
        assertCausalInvariant(original.value, baseline.value);
        wrapperIdentity = placementWrapperIdentity(
          original.value,
          baseline.value,
        );
        await save(
          'attachment-control.json',
          unchanged(original, baseline, 'native host identity attachment'),
        );
        for (const [label, mode] of [
          ['native-transform', 'transform'],
          ['native-layout', 'layout'],
          ['native-transform-return', 'transform'],
        ] as const) {
          await owner.evaluate((handle, mode) => handle.place(mode), mode);
          await settle(native);
          const current = await capture(native, label, true);
          expect(current.value.root).toEqual({ ...nativeRoot, x: 0, y: 0 });
          assertCausalInvariant(baseline.value, current.value, offset);
          if (!transform) transform = current;
          else {
            assertCausalInvariant(transform.value, current.value);
            assertPlacementAncestors(
              transform.value,
              current.value,
              wrapperIdentity,
              offset,
            );
            expect(current.owner!.metrics).toEqual(transform.owner!.metrics);
          }
          if (mode === 'layout') layout = current;
          else if (label === 'native-transform-return') returned = current;
          const referenceValue = await snapshot(reference);
          assertCausalInvariant(refStart.value, referenceValue);
          expect(referenceValue.ancestors).toEqual(refStart.value.ancestors);
          const differences = comparePanelsOriginContent(
            current.value,
            referenceValue,
          );
          await save(label + '-content.json', {
            native: current.value,
            reference: referenceValue,
            differences,
          });
          expect(
            differences.filter(
              (row) => !row.field.endsWith('.--dsw-corner-shape'),
            ),
          ).toEqual([]);
          phaseRecords.push({
            phase: label,
            mode,
            nativeRoot: current.value.root,
            referenceRoot: referenceValue.root,
            allMeasuredDifferences: differences,
          });
        }
        await save(
          'transform-return-control.json',
          unchanged(transform!, returned!, 'same mechanism exact return'),
        );
        expect(returned!.owner).toEqual(transform!.owner);
        await save('comparisons.json', {
          baseline: compare(refStart, baseline),
          transform: compare(refStart, transform!),
          layout: compare(refStart, layout!),
          returned: compare(refStart, returned!),
          mechanism: compare(transform!, layout!),
          note: 'Formal element and lossless saved-frame panel window remain separate. No mechanism is required to match reference; full-page background is retained.',
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
            const restoration = await owner.evaluate((handle) =>
              handle.restore(),
            );
            cleanup.push(restoration);
            await save('host-restored.json', restoration);
            if (native && original) {
              await settle(native);
              const restored = await capture(native, 'native-restored');
              assertCausalInvariant(original.value, restored.value);
              expect(restored.value.ancestors).toEqual(
                original.value.ancestors,
              );
              await save(
                'restored-control.json',
                unchanged(original, restored, 'native exact detach'),
              );
            }
          }
        } catch (error) {
          valid = false;
          failures.push(error);
          cleanup.push({ restorationError: String(error) });
        }
        try {
          if (reference && refStart) {
            const end = await capture(reference, 'reference-end');
            assertCausalInvariant(refStart.value, end.value);
            expect(end.value.ancestors).toEqual(refStart.value.ancestors);
            await save(
              'reference-control.json',
              unchanged(refStart, end, 'untouched reference'),
            );
          }
        } catch (error) {
          valid = false;
          failures.push(error);
          cleanup.push({ referenceError: String(error) });
        }
        try {
          for (const observer of observers) {
            await observer.flush();
            observer.assertClean();
          }
        } catch (error) {
          valid = false;
          failures.push(error);
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
          failures.push(Error('Unknown public/CDP outcomes remain'));
        }
        const actualPngs = (await readdir(out))
          .filter((name) => name.endsWith('.png'))
          .sort();
        if (
          valid &&
          JSON.stringify(actualPngs) !== JSON.stringify(expectedPngs)
        ) {
          valid = false;
          failures.push(Error('Exact D PNG inventory differs'));
        }
        const values = {
          baseline: refStart && baseline ? compare(refStart, baseline) : null,
          transform:
            refStart && transform ? compare(refStart, transform) : null,
          layout: refStart && layout ? compare(refStart, layout) : null,
          returned: refStart && returned ? compare(refStart, returned) : null,
          mechanism: transform && layout ? compare(transform, layout) : null,
        };
        const effect = classifyNativePlacementEffect(valid, values, {
          formalElement:
            !!transform &&
            !!returned &&
            sha(transform.element) === sha(returned.element),
          fullFramePanelWindow:
            !!transform &&
            !!returned &&
            sha(transform.window) === sha(returned.window),
        });
        await save('network-audit.json', audits);
        await save('events.json', journal.events);
        await save('result.json', {
          diagnosticOnly: true,
          acceptanceSatisfied: false,
          valid,
          effect,
          wrapperIdentity,
          phases: phaseRecords,
          captures,
          comparisons: values,
          expectedPngs,
          actualPngs,
          cleanup,
          measuredScope:
            'One native 1440/light/list/experience panel. Fixed-final-origin placement mechanism only; discrete sampling, not whole-domain visibility or product repair. Current baseline required; no historical pixels used.',
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
          'Native placement diagnostic invalid/cleanup failed',
        );
      expect(valid).toBe(true);
      expect(
        classifyNativePlacementEffect(
          valid,
          {
            baseline: compare(refStart!, baseline!),
            transform: compare(refStart!, transform!),
            layout: compare(refStart!, layout!),
            returned: compare(refStart!, returned!),
            mechanism: compare(transform!, layout!),
          },
          {
            formalElement: sha(transform!.element) === sha(returned!.element),
            fullFramePanelWindow:
              sha(transform!.window) === sha(returned!.window),
          },
        ).status,
      ).not.toBe('invalid-experiment');
      // A completed no-effect/not-supported diagnostic is valid evidence, not UI acceptance.
    }, 180_000);
  },
);
