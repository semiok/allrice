import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Locator,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;

suite('U1 S1 standalone employee Skill display candidate', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-skills-s1');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-skills-section-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/skills-s1-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      const asset = assets.get(path);
      response.setHeader(
        'content-type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      response.end(
        asset ??
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-skills-section-page.css"></head><body><div id="root"></div><script type="module" src="/employee-skills-section-page.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No fixture port');
    origin = `http://127.0.0.1:${address.port}`;
    const { chromium } = createRequire(resolve('apps/worker/package.json'))(
      'playwright-core',
    );
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    await mkdir(evidence, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  async function fixture(width = 1440, theme: 'light' | 'dark' = 'light') {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      isMobile: width === 390,
      hasTouch: width === 390,
      colorScheme: theme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      requests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      requests.push(route.request().method() + ' ' + route.request().url());
      await route.abort();
    });
    await page.goto(`${origin}/chatflow?theme=${theme}`);
    await page
      .getByRole('heading', { name: '技能 Skill', exact: true })
      .waitFor();
    return {
      page,
      async close() {
        await context.close();
        expect(errors).toEqual([]);
        expect(requests).toEqual([]);
      },
    };
  }

  async function events(page: Page) {
    return JSON.parse(
      await page.getByLabel('夹具回调记录').innerText(),
    ) as Array<{ action: string; instanceId: string; installationId?: string }>;
  }

  async function waitForDetailPaint(detail: Locator) {
    const sample = () =>
      detail.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const heading = node.querySelector('h2');
        const ancestors = [];
        for (
          let element: Element | null = node;
          element;
          element = element.parentElement
        ) {
          const current = getComputedStyle(element);
          ancestors.push({
            opacity: current.opacity,
            visibility: current.visibility,
            display: current.display,
          });
        }
        const root = node.parentElement;
        const rootBox = root?.getBoundingClientRect();
        const activeAnimations = (
          root?.getAnimations({ subtree: true }) ?? []
        ).filter(
          (animation) => animation.playState === 'running' || animation.pending,
        ).length;
        const target = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return {
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          background: style.backgroundColor,
          text: heading ? getComputedStyle(heading).color : null,
          modalRoot:
            root && rootBox
              ? {
                  role: root.getAttribute('role'),
                  x: rootBox.x,
                  y: rootBox.y,
                  width: root.clientWidth,
                  height: root.clientHeight,
                }
              : null,
          ancestors,
          activeAnimations,
          hitInside: target !== null && node.contains(target),
        };
      });
    let previous = '',
      stableSamples = 0;
    await expect
      .poll(
        async () => {
          const paint = await sample();
          const geometry = JSON.stringify(paint.box);
          stableSamples = geometry === previous ? stableSamples + 1 : 0;
          previous = geometry;
          return {
            opaque: paint.ancestors.every(
              (ancestor) =>
                Number(ancestor.opacity) === 1 &&
                ancestor.visibility === 'visible' &&
                ancestor.display !== 'none',
            ),
            settled: paint.activeAnimations === 0,
            stable: stableSamples >= 2,
            hitInside: paint.hitInside,
          };
        },
        { timeout: 5000, interval: 20 },
      )
      .toEqual({ opaque: true, settled: true, stable: true, hitInside: true });
    return { ...(await sample()), stableSamples };
  }

  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`renders the two groups and read-only detail at ${width}px ${theme}`, async () => {
        const f = await fixture(width, theme);
        try {
          const region = f.page.getByRole('region', { name: '技能 Skill' });
          await region.getByText('我添加的 · 1', { exact: true }).waitFor();
          expect(await region.getByText('基础技能 · 11').count()).toBe(1);
          const typography = await region
            .getByRole('button', { name: '翻译校对', exact: true })
            .evaluate((node) => {
              const style = getComputedStyle(node);
              return {
                family: style.fontFamily,
                size: style.fontSize,
                height: style.lineHeight,
                weight: style.fontWeight,
              };
            });
          expect(typography).toMatchObject({
            size: '14px',
            height: '22px',
            weight: '500',
          });
          expect(typography.family).toMatch(/sans-serif/i);
          const paint = await f.page.locator('article').evaluate((node) => ({
            background: getComputedStyle(node).backgroundColor,
            text: getComputedStyle(node).color,
            theme: document.documentElement.dataset.theme,
            dark: document.body.hasAttribute('data-ds-dark-theme'),
          }));
          expect(paint).toEqual({
            background:
              theme === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)',
            text: theme === 'dark' ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
            theme,
            dark: theme === 'dark',
          });
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await f.page.screenshot({
            path: resolve(evidence, `s1-list-${width}-${theme}.png`),
            fullPage: true,
          });
          const open = region.getByRole('button', {
            name: '行情数据',
            exact: true,
          });
          await open.click();
          const detail = f.page.getByRole('dialog', {
            name: '行情数据',
            exact: true,
          });
          await detail
            .getByRole('heading', { name: '行情数据', exact: true })
            .waitFor();
          expect(await detail.locator('footer').count()).toBe(0);
          expect(
            await detail
              .getByRole('button', { name: '关闭', exact: true })
              .count(),
          ).toBe(0);
          const detailPaint = await waitForDetailPaint(detail);
          expect(detailPaint.background).toBe(paint.background);
          expect(detailPaint.text).toBe(paint.text);
          const box = detailPaint.box;
          const modalRoot = detailPaint.modalRoot;
          if (!modalRoot) throw Error('Missing native Modal root geometry');
          expect(modalRoot.role).toBe('presentation');
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          if (width === 390) {
            expect(box).toEqual({
              x: modalRoot.x,
              y: modalRoot.y,
              width: modalRoot.width,
              height: modalRoot.height,
            });
          } else {
            expect(box.width).toBe(552);
            expect(box.x + box.width / 2).toBe(
              modalRoot.x + modalRoot.width / 2,
            );
          }
          await f.page.screenshot({
            path: resolve(evidence, `s1-base-detail-${width}-${theme}.png`),
            fullPage: true,
          });
          await writeFile(
            resolve(evidence, `s1-paint-${width}-${theme}.json`),
            JSON.stringify(
              { width, theme, typography, paint, detail: detailPaint },
              null,
              2,
            ),
          );
          await detail
            .getByRole('button', { name: '返回员工详情', exact: true })
            .click();
          await expect.poll(() => detail.count()).toBe(0);
          await expect
            .poll(() =>
              open.evaluate((node) => node === document.activeElement),
            )
            .toBe(true);
          await open.click();
          await detail.waitFor();
          await f.page.keyboard.press('Escape');
          await expect.poll(() => detail.count()).toBe(0);
          expect(await events(f.page)).toEqual([]);
        } finally {
          await f.close();
        }
      });
    }
  }

  it('keeps loading and failed host states distinct from a real empty catalog', async () => {
    const f = await fixture(390);
    try {
      const phase = f.page.getByRole('combobox', { name: '夹具状态' });
      const region = f.page.getByRole('region', { name: '技能 Skill' });
      await phase.selectOption('loading');
      await region.getByRole('status').waitFor();
      expect(await region.getByText(/我添加的|基础技能 ·/).count()).toBe(0);
      expect(
        await region.getByRole('button', { name: '添加技能' }).count(),
      ).toBe(0);
      await phase.selectOption('error');
      await region.getByRole('alert').waitFor();
      expect(await region.getByText(/我添加的|基础技能 ·/).count()).toBe(0);
      await region.getByRole('button', { name: '重试', exact: true }).click();
      await region.getByRole('status').waitFor();
      expect((await events(f.page)).map((event) => event.action)).toEqual([
        'retry',
      ]);
      await phase.selectOption('ready');
      await f.page
        .getByRole('combobox', { name: '夹具目录' })
        .selectOption('empty');
      await region.getByText('我添加的 · 0', { exact: true }).waitFor();
      expect(
        await region.getByText('还没有添加技能。', { exact: true }).count(),
      ).toBe(0);
      expect(
        await region
          .getByRole('button', { name: '添加技能', exact: true })
          .count(),
      ).toBe(1);
      await f.page
        .getByRole('combobox', { name: '夹具目录' })
        .selectOption('two-base');
      await region.getByText('基础技能 · 2', { exact: true }).waitFor();
    } finally {
      await f.close();
    }
  });

  it('requires both real catalog capability and a host callback for write affordances', async () => {
    const f = await fixture();
    try {
      const mode = f.page.getByRole('combobox', { name: '夹具目录' });
      const region = f.page.getByRole('region', { name: '技能 Skill' });
      await mode.selectOption('read-only');
      expect(
        await region.getByRole('button', { name: '添加技能' }).count(),
      ).toBe(0);
      expect(
        await region.getByRole('button', { name: '卸载', exact: true }).count(),
      ).toBe(0);
      await region
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      let detail = f.page.getByRole('dialog', {
        name: '翻译校对',
        exact: true,
      });
      await detail.waitFor();
      expect(await detail.locator('footer').count()).toBe(0);
      await f.page.keyboard.press('Escape');
      await mode.selectOption('personal');
      await f.page.getByRole('checkbox', { name: '提供写操作回调' }).uncheck();
      expect(
        await region.getByRole('button', { name: '添加技能' }).count(),
      ).toBe(0);
      expect(
        await region.getByRole('button', { name: '卸载', exact: true }).count(),
      ).toBe(0);
      await region
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      detail = f.page.getByRole('dialog', { name: '翻译校对', exact: true });
      await detail.waitFor();
      expect(await detail.locator('footer').count()).toBe(0);
      expect(await events(f.page)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('passes the exact personal target to host callbacks without mutating the catalog or claiming success', async () => {
    const f = await fixture();
    try {
      const region = f.page.getByRole('region', { name: '技能 Skill' });
      await region
        .getByRole('button', { name: '添加技能', exact: true })
        .click();
      await region.getByRole('button', { name: '卸载', exact: true }).click();
      await region
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      const detail = f.page.getByRole('dialog', {
        name: '翻译校对',
        exact: true,
      });
      await detail.getByRole('button', { name: '更新', exact: true }).click();
      await detail
        .getByRole('button', { name: '卸载这个技能', exact: true })
        .click();
      const result = await events(f.page);
      expect(result.map((event) => event.action)).toEqual([
        'add',
        'uninstall',
        'update',
        'uninstall',
      ]);
      expect(
        result.every(
          (event) =>
            event.instanceId === '00000000-0000-4000-8000-000000000007',
        ),
      ).toBe(true);
      expect(
        result
          .slice(1)
          .every(
            (event) =>
              event.installationId === '00000000-0000-4000-8000-000000000200',
          ),
      ).toBe(true);
      expect(await detail.getByText('v0.3.0', { exact: true }).count()).toBe(1);
      expect(await detail.getByText(/已更新|已卸载|更新完成/).count()).toBe(0);
      await detail
        .getByRole('button', { name: '返回员工详情', exact: true })
        .click();
      expect(
        await region.getByText('我添加的 · 1', { exact: true }).count(),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('keeps author version separate from installation sequence and preserves ZIP and GitHub source displays', async () => {
    const f = await fixture(390);
    try {
      const mode = f.page.getByRole('combobox', { name: '夹具目录' });
      const region = f.page.getByRole('region', { name: '技能 Skill' });
      expect(await region.getByText('v0.3.0', { exact: true }).count()).toBe(1);
      expect(await region.getByText('v9', { exact: true }).count()).toBe(0);
      for (const { modeName, expected } of [
        { modeName: 'prefixed-version', expected: 'v0.3.0' },
        { modeName: 'author-version', expected: 'release-candidate' },
      ]) {
        await mode.selectOption(modeName);
        await region.getByText(expected, { exact: true }).waitFor();
        await region
          .getByRole('button', { name: '翻译校对', exact: true })
          .click();
        const versionDetail = f.page.getByRole('dialog', {
          name: '翻译校对',
          exact: true,
        });
        await versionDetail.getByText(expected, { exact: true }).waitFor();
        expect(await versionDetail.getByText(/^vv|^vrelease/).count()).toBe(0);
        await versionDetail
          .getByRole('button', { name: '返回员工详情', exact: true })
          .click();
      }
      await mode.selectOption('missing-version');
      await region.getByText('未提供', { exact: true }).waitFor();
      await region
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      const detail = f.page.getByRole('dialog', {
        name: '翻译校对',
        exact: true,
      });
      await detail.getByText('未提供', { exact: true }).waitFor();
      expect(
        await detail
          .getByText('translation-review.zip', { exact: true })
          .count(),
      ).toBe(1);
      await detail
        .getByRole('button', { name: '返回员工详情', exact: true })
        .click();
      await mode.selectOption('github');
      await region
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      await detail
        .getByText('https://github.com/example/translation-review', {
          exact: true,
        })
        .waitFor();
      expect(
        await detail
          .getByText('translation-review.zip', { exact: true })
          .count(),
      ).toBe(0);
      expect(await detail.getByRole('link').count()).toBe(0);
    } finally {
      await f.close();
    }
  });
});
