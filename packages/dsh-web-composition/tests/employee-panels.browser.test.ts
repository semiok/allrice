import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright-core';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { writeEmployeePanelsFixture } from './employee-panels-fixture';
import {
  panelsRev2Head,
  writeEmployeePanelsBaseline,
} from './employee-panels-baseline';
import { compareSidebarPixels } from './sidebar-pixels';
import {
  createSyntheticPanelsData,
  panelsClock,
  panelStates,
  type PanelsState,
} from './fixtures/employee-panels/data';
import type { PanelsIntegration } from './fixtures/employee-panels/client';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const kinds = ['files', 'materials', 'experience', 'workflow'] as const;
const names = {
  files: '交付成果',
  materials: '企业资料',
  experience: 'Rice · 记忆',
  workflow: 'Rice · 能力',
};
const labels = {
  files: '交付成果',
  materials: '企业资料',
  experience: '记忆',
  workflow: '能力',
};
const sessions = [
  'session-00000000-0000-4000-8000-000000000036',
  'session-00000000-0000-4000-8000-000000000038',
] as SessionIdOf[];
type Kind = (typeof kinds)[number];
const body = (page: Page, kind: Kind) =>
  page
    .locator(`section[aria-label="${names[kind]}"]`)
    .filter({ visible: true });
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
const catalogResponse = (page: Page, kind: Kind, state: PanelsState) =>
  state === 'loading' || (kind !== 'materials' && kind !== 'files')
    ? Promise.resolve()
    : page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          (kind === 'materials'
            ? '/api/v1/references/publications'
            : '/api/v1/workbench/files'),
      );
const contentReady = async (page: Page, kind: Kind, state: PanelsState) => {
  const root = body(page, kind);
  if (state === 'loading') {
    if (kind === 'materials')
      await root
        .getByRole('status', { name: '正在读取企业资料', exact: true })
        .waitFor({ state: 'visible' });
    else await root.getByRole('status').waitFor({ state: 'visible' });
  } else if (state === 'denied') {
    // Materials keeps its existing generic catalog failure wording.
    if (kind === 'materials')
      await root.getByRole('alert').waitFor({ state: 'visible' });
    else
      await root
        .getByText('无权访问', { exact: false })
        .first()
        .waitFor({ state: 'visible' });
  } else if (state === 'empty') {
    await root
      .getByText(
        {
          files: '还没有交付成果',
          materials: '还没有企业资料',
          experience: '还没有记忆',
          workflow: '暂无插件',
        }[kind],
        { exact: true },
      )
      .waitFor({ state: 'visible' });
  } else if (kind === 'materials' || kind === 'files') {
    await root
      .getByText(
        createSyntheticPanelsData(state).catalog.references[0]!.fileName,
        { exact: true },
      )
      .first()
      .waitFor({ state: 'visible' });
  }
};
const inspectContent = (page: Page, kind: Kind) =>
  body(page, kind).evaluate((node) => {
    const box = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const s = getComputedStyle(element);
      return {
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 100),
        x,
        y,
        width,
        height,
        display: s.display,
        position: s.position,
        boxSizing: s.boxSizing,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        color: s.color,
        background: s.backgroundColor,
        padding: s.padding,
        border: s.borderWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    };
    return {
      root: box(node),
      parent: box(node.parentElement!),
      elements: [...node.querySelectorAll('h2,p,input,button,strong')]
        .filter((item) => item.getBoundingClientRect().width > 0)
        .slice(0, 30)
        .map(box),
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
    };
  });

// Real installed product/native renderer, with explicitly synthetic BFF data.
// No authentication, model submission, or 4.0 carrier delivery is asserted.
suite('installed native employee panels with synthetic business owner', () => {
  let browser: Browser, context: BrowserContext, page: Page, artifacts: string;
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  let baselineHtml: string;
  let state: PanelsState = 'list';
  const pending: Route[] = [],
    requests: { url: string; method: string; state: PanelsState }[] = [];
  const errors: { test: string | null; source: string; message: string }[] = [];
  let currentTest: string | null = null;
  const evidence = () =>
    page.evaluate(() => window.__allricePanelsIntegration!.evidence());
  const command = async <K extends keyof PanelsIntegration>(
    name: K,
    ...args: Parameters<PanelsIntegration[K]>
  ) =>
    page.evaluate(
      ({ name, args }) => {
        const fn = window.__allricePanelsIntegration![name] as (
          ...values: unknown[]
        ) => unknown;
        return fn(...args);
      },
      { name, args },
    );
  const businessRoute = async (route: Route) => {
    const url = new URL(route.request().url()),
      method = route.request().method();
    requests.push({ url: url.pathname + url.search, method, state });
    if (method !== 'GET') {
      await route.fulfill({
        status: 403,
        json: {
          error: {
            code: 'SYNTHETIC_READ_ONLY',
            message: '合成夹具不接受业务写入',
          },
        },
      });
      return;
    }
    if (state === 'loading') {
      pending.push(route);
      return;
    }
    if (state === 'denied') {
      await route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: '无权访问' } },
      });
      return;
    }
    const data = createSyntheticPanelsData(state);
    if (url.pathname === '/api/v1/references/publications')
      await route.fulfill({ json: data.catalog });
    else if (url.pathname === '/api/v1/workbench/files')
      await route.fulfill({ json: data.files });
    else if (url.pathname.endsWith('/selection'))
      await route.fulfill({
        json: data.selection(url.pathname.split('/').at(-2)!),
      });
    else {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: 'SYNTHETIC_NOT_PROVIDED',
            message: '此业务响应未由测试夹具提供',
          },
        },
      });
    }
  };
  const changeState = async (value: PanelsState) => {
    for (const route of pending.splice(0)) await route.abort().catch(() => {});
    state = value;
    await command('setState', value);
  };
  const open = async (kind: Kind) => {
    const entries = page.locator('[aria-label="工作台入口"]');
    const launcher = entries.getByRole('button', {
      name: new RegExp(`^${labels[kind]}(?:，|$)`),
    });
    // Native narrow presentation covers the Conversation header. Return via
    // its real chrome before clicking the next original AllRice entry.
    const exposed =
      (await launcher.isVisible()) &&
      (await launcher.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const top = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return top !== null && node.contains(top);
      }));
    if (!exposed) {
      await page
        .getByRole('button', { name: '收起右侧边栏', exact: true })
        .click();
      await entries.waitFor({ state: 'visible' });
    }
    await Promise.all([catalogResponse(page, kind, state), launcher.click()]);
    await body(page, kind).waitFor({ state: 'visible' });
    await page.waitForFunction(
      (kind) =>
        window.__allricePanelsIntegration!.evidence().activeKind ===
        `allrice-employee-panels.${kind}`,
      kind,
    );
    await contentReady(page, kind, state);
    await settle(page);
  };
  beforeAll(async () => {
    const parent = resolve(
      process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ??
        join(tmpdir(), 'allrice-composition-evidence'),
    );
    await mkdir(parent, { recursive: true });
    artifacts = await mkdtemp(join(parent, 'employee-panels-'));
    console.info(`Synthetic-owner native panels evidence: ${artifacts}`);
    const fixture = await writeEmployeePanelsFixture(artifacts);
    const baseline = await writeEmployeePanelsBaseline(artifacts);
    baselineHtml = await readFile(baseline, 'utf8');
    host = await startInstalledProfile(fixture);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    await writeFile(
      join(artifacts, 'browser-identity.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          node: process.version,
          nativeVersion: '0.2.1-rc.2',
          dpr: 1,
          clock: panelsClock,
          reducedMotion: 'reduce',
          businessOwner: 'synthetic only; no authenticated BFF/MCP or model',
          rev2Head: panelsRev2Head,
          productSha256: createHash('sha256')
            .update(
              await readFile(new URL('../dist/client.js', import.meta.url)),
            )
            .digest('hex'),
        },
        null,
        2,
      ),
    );
  }, 180_000);
  beforeEach(async (test) => {
    currentTest = test.task.name;
    state = 'list';
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
    });
    await context.addInitScript((clock) => {
      Date.now = () => Date.parse(clock);
    }, panelsClock);
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) =>
      errors.push({
        test: currentTest,
        source: 'pageerror',
        message: error.message,
      }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push({
          test: currentTest,
          source: 'console',
          message: message.text(),
        });
    });
    await page.route('**/api/v1/**', businessRoute);
    await page.goto(host.authUrl);
    const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await page.waitForFunction(
      () =>
        window.__allricePanelsIntegration?.evidence().nativeInputReady &&
        !!document.querySelector('[aria-label="工作台入口"]'),
    );
    await command('clearInput');
  });
  afterEach(async (test) => {
    if (test.task.result?.state === 'fail') {
      const name = test.task.id.replace(/\W/g, '-');
      await writeFile(
        join(artifacts, `first-failure-${name}.json`),
        JSON.stringify(
          {
            test: test.task.name,
            state,
            evidence: await evidence().catch(String),
            errors,
            requests,
          },
          null,
          2,
        ),
      );
      await page.screenshot({
        path: join(artifacts, `first-failure-${name}.png`),
        fullPage: true,
      });
    }
    await context?.close();
    pending.length = 0;
    await writeFile(
      join(artifacts, 'runtime-errors.json'),
      JSON.stringify(errors, null, 2),
    );
    await writeFile(
      join(artifacts, 'business-requests.json'),
      JSON.stringify(requests, null, 2),
    );
    currentTest = null;
  });
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  it('uses four original entries and native tabs/close while unknown owner data fails closed', async () => {
    const entries = page.locator('[aria-label="工作台入口"]');
    expect(await entries.getByRole('button').count()).toBe(4);
    expect(
      await entries
        .getByRole('button', { name: '交付成果，5 项新增', exact: true })
        .count(),
    ).toBe(1);
    expect(
      await entries
        .getByRole('button', { name: '展开工作台', exact: true })
        .count(),
    ).toBe(0);
    for (const kind of kinds) {
      await open(kind);
      expect((await evidence()).expanded).toBe(true);
      expect(await body(page, kind).count()).toBe(1);
    }
    await page
      .getByRole('tab', { name: /能力/ })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await body(page, 'workflow').waitFor({ state: 'hidden' });
    await command('unknownFiles', true);
    await entries.waitFor({ state: 'hidden' });
    await command('unknownFiles', false);
    await entries.waitFor({ state: 'visible' });
    expect(
      await entries
        .getByRole('button', { name: '企业资料', exact: true })
        .count(),
    ).toBe(1);
    expect(
      await entries.getByRole('button', { name: '记忆', exact: true }).count(),
    ).toBe(1);
    expect(
      await entries.getByRole('button', { name: '能力', exact: true }).count(),
    ).toBe(1);
  });

  it('keeps enterprise ＋ and uses actual native insertion acceptance and stale-span refusal', async () => {
    await open('materials');
    const plus = body(page, 'materials').getByRole('button', {
      name: '引用到对话',
      exact: true,
    });
    expect(await plus.count()).toBe(5);
    await plus.first().click();
    await page.waitForFunction(
      () =>
        window.__allricePanelsIntegration!.evidence().accepted === 1 &&
        window.__allricePanelsIntegration!.input().occurrences.length === 1,
    );
    const inserted = await page.evaluate(() =>
      window.__allricePanelsIntegration!.input(),
    );
    expect(inserted.occurrences).toHaveLength(1);
    expect(inserted.occurrences[0]).toMatchObject({
      source: 'allrice-synthetic-reference',
      ref: createSyntheticPanelsData().references[0]!.revisionId,
    });
    const received = await evidence();
    expect(received.lastReference).toMatchObject({
      sessionId: sessions[0],
      checksum: createSyntheticPanelsData().references[0]!.checksum,
    });
    await command('rejectNextReference');
    await plus.nth(1).click();
    await page.waitForFunction(
      () => window.__allricePanelsIntegration!.evidence().refused === 1,
    );
    const refused = await page.evaluate(() =>
      window.__allricePanelsIntegration!.input(),
    );
    expect(refused.occurrences).toHaveLength(1);
    expect(refused.draftRev).toBeGreaterThan(inserted.draftRev);
    expect((await evidence()).accepted).toBe(1);
    await body(page, 'materials')
      .getByRole('alert')
      .waitFor({ state: 'visible' });
  });

  it('rejects detached scope/main intents and disposes/rebinds the explicit owner without duplicate seats', async () => {
    await open('workflow');
    await command('setMainMode', 'held');
    await body(page, 'workflow')
      .getByRole('button', { name: '品牌内容助手', exact: true })
      .click();
    await page.waitForFunction(
      () => window.__allricePanelsIntegration!.evidence().heldMain,
    );
    const previous = (await evidence()).scopeKey;
    await command('switchScope');
    await page.waitForFunction(
      (old) => window.__allricePanelsIntegration!.evidence().scopeKey !== old,
      previous,
    );
    await command('releaseMain');
    await page.waitForFunction(() =>
      window
        .__allricePanelsIntegration!.evidence()
        .events.some((event) => event.startsWith('main-rejected:')),
    );
    expect(
      await page
        .locator('section[aria-label="合成能力的实际 native main"]')
        .count(),
    ).toBe(0);
    await command('unload');
    await page
      .locator('[aria-label="工作台入口"]')
      .waitFor({ state: 'hidden' });
    const disposed = await evidence();
    expect(disposed.oldOwnerAborted).toBe(true);
    expect(disposed.listeners).toBe(0);
    expect(disposed.panelEntries).toEqual([]);
    await command('rebind');
    await page
      .locator('[aria-label="工作台入口"]')
      .waitFor({ state: 'visible' });
    expect((await evidence()).panelEntries).toHaveLength(4);
    expect(
      (await evidence()).headerEntries.filter(
        (id) => id === 'allrice-employee-panels.header',
      ),
    ).toHaveLength(1);
    await command('openSession', sessions[1]!);
    await page.waitForFunction(
      (id) => window.__allricePanelsIntegration!.evidence().sessionId === id,
      sessions[1],
    );
    await open('experience');
    expect((await evidence()).scopeKey).toContain(sessions[1]);
    await command('available', false);
    await body(page, 'experience').waitFor({ state: 'hidden' });
    await page
      .locator('[aria-label="工作台入口"]')
      .waitFor({ state: 'hidden' });
  });

  it('opens only the actually registered capability main and refuses an unknown key', async () => {
    await open('workflow');
    await command('setMainMode', 'missing');
    await body(page, 'workflow')
      .getByRole('button', { name: '品牌内容助手', exact: true })
      .click();
    await page.waitForFunction(() =>
      window
        .__allricePanelsIntegration!.evidence()
        .events.some((event) => event.startsWith('main-rejected:')),
    );
    expect(
      await page
        .locator('section[aria-label="合成能力的实际 native main"]')
        .count(),
    ).toBe(0);
    expect((await evidence()).registeredMain).toBe(true);
    await command('setMainMode', 'registered');
    await body(page, 'workflow')
      .getByRole('button', { name: '品牌内容助手', exact: true })
      .click();
    await page
      .getByRole('heading', {
        name: '合成能力 main（仅接线测试）',
        exact: true,
      })
      .waitFor({ state: 'visible' });
    expect((await evidence()).events).toContain('synthetic-main-selected');
    await page
      .getByRole('button', { name: '返回真实原生会话', exact: true })
      .click();
    await page
      .locator('[aria-label="工作台入口"]')
      .waitFor({ state: 'visible' });
  });

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      it(`compares original rev2 content at ${width}/${theme} across all applicable states`, async () => {
        await page.setViewportSize({ width, height: 1000 });
        await command('setTheme', theme);
        const baseline = await context.newPage();
        baseline.on('pageerror', (error) =>
          errors.push({
            test: currentTest,
            source: 'rev2-pageerror',
            message: error.message,
          }),
        );
        await baseline.route(
          'http://allrice-panels-rev2.invalid/**',
          async (route) => {
            if (new URL(route.request().url()).pathname.startsWith('/api/v1/'))
              await businessRoute(route);
            else
              await route.fulfill({
                contentType: 'text/html',
                body: baselineHtml,
              });
          },
        );
        await baseline.setViewportSize({ width, height: 1000 });
        const comparisons: unknown[] = [];
        for (const value of panelStates)
          for (const kind of kinds) {
            const prefix = `${width}-${theme}-${value}-${kind}`;
            try {
              await changeState(value);
              await open(kind);
              const budget = await inspectContent(page, kind);
              const query = new URLSearchParams({
                kind,
                state: value,
                theme,
                paneWidth: String(budget.parent.width),
                paneHeight: String(budget.parent.height),
              });
              await Promise.all([
                catalogResponse(baseline, kind, value),
                baseline.goto('http://allrice-panels-rev2.invalid/?' + query),
              ]);
              await body(baseline, kind).waitFor({ state: 'visible' });
              await contentReady(baseline, kind, value);
              await page.mouse.move(0, 0);
              await baseline.mouse.move(0, 0);
              for (const view of [page, baseline]) {
                await view.evaluate(async () => {
                  if (document.activeElement instanceof HTMLElement)
                    document.activeElement.blur();
                  await document.fonts.ready;
                });
                await settle(view);
              }
              const actual = await inspectContent(page, kind);
              const expected = await inspectContent(baseline, kind);
              const actualPng = await body(page, kind).screenshot({
                path: join(artifacts, `${prefix}-native.png`),
                animations: 'disabled',
              });
              const expectedPng = await body(baseline, kind).screenshot({
                path: join(artifacts, `${prefix}-rev2.png`),
                animations: 'disabled',
              });
              const pixels = compareSidebarPixels(expectedPng, actualPng);
              const result = {
                prefix,
                state: value,
                kind,
                actual,
                expected,
                pixels,
              };
              comparisons.push(result);
              // Preserve both screenshots, full frames and every detailed geometry
              // before any width/style/pixel guard; subsequent pairs still execute.
              await writeFile(
                join(artifacts, `${prefix}-geometry.json`),
                JSON.stringify(result, null, 2),
              );
              await page.screenshot({
                path: join(artifacts, `${prefix}-native-frame.png`),
                fullPage: true,
              });
              await baseline.screenshot({
                path: join(artifacts, `${prefix}-rev2-frame.png`),
                fullPage: true,
              });
              expect
                .soft(
                  Math.abs(actual.root.width - expected.root.width),
                  prefix + ' content width',
                )
                .toBeLessThanOrEqual(0.5);
              expect
                .soft(
                  Math.abs(actual.root.height - expected.root.height),
                  prefix + ' content height',
                )
                .toBeLessThanOrEqual(0.5);
              expect
                .soft(actual.root.x, prefix + ' viewport left')
                .toBeGreaterThanOrEqual(-0.5);
              expect
                .soft(
                  actual.root.x + actual.root.width,
                  prefix + ' viewport right',
                )
                .toBeLessThanOrEqual(width + 0.5);
              expect
                .soft(
                  actual.elements.map(
                    ({
                      tag,
                      text,
                      fontFamily,
                      fontSize,
                      fontWeight,
                      lineHeight,
                      letterSpacing,
                      color,
                    }) => ({
                      tag,
                      text,
                      fontFamily,
                      fontSize,
                      fontWeight,
                      lineHeight,
                      letterSpacing,
                      color,
                    }),
                  ),
                  prefix + ' typography',
                )
                .toEqual(
                  expected.elements.map(
                    ({
                      tag,
                      text,
                      fontFamily,
                      fontSize,
                      fontWeight,
                      lineHeight,
                      letterSpacing,
                      color,
                    }) => ({
                      tag,
                      text,
                      fontFamily,
                      fontSize,
                      fontWeight,
                      lineHeight,
                      letterSpacing,
                      color,
                    }),
                  ),
                );
              expect
                .soft(pixels.dimensionsMatch, prefix + ' image dimensions')
                .toBe(true);
              expect.soft(pixels.changedPixels, prefix + ' exact RGBA').toBe(0);
            } catch (error) {
              const failure = {
                prefix,
                error: String(error),
                evidence: await evidence().catch(String),
              };
              comparisons.push(failure);
              await writeFile(
                join(artifacts, `${prefix}-failure.json`),
                JSON.stringify(failure, null, 2),
              );
              await page.screenshot({
                path: join(artifacts, `${prefix}-native-failure.png`),
                fullPage: true,
              });
              await baseline.screenshot({
                path: join(artifacts, `${prefix}-rev2-failure.png`),
                fullPage: true,
              });
              expect.soft(false, prefix + ': ' + String(error)).toBe(true);
            }
            await appendFile(
              join(artifacts, `${width}-${theme}-progress.jsonl`),
              JSON.stringify({ prefix, recorded: comparisons.length }) + '\n',
            );
          }
        await writeFile(
          join(artifacts, `${width}-${theme}-comparisons.json`),
          JSON.stringify(comparisons, null, 2),
        );
        expect(comparisons).toHaveLength(panelStates.length * kinds.length);
        await baseline.close();
      }, 180_000);
    }

  it('keeps all native/runtime errors visible for the whole file', () => {
    expect(errors).toEqual([]);
  });
});
