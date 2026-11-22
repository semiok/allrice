import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
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
  createSyntheticPanelsData,
  panelsClock,
} from './fixtures/employee-panels/data';
import type { PanelsIntegration } from './fixtures/employee-panels/client';
import { childPaneBrowserCases } from './child-pane.browser-cases';

declare global {
  interface Window {
    __allriceCompositionTest?: {
      openSession: (id: string) => void;
      setTheme: (mode: 'light' | 'dark') => void;
    };
  }
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const labels = ['企业资料', '交付成果', '记忆', '能力'];
const descriptions = [
  '公司、部门和你自己可用的参考资料',
  '员工交付的文件和你在对话中上传的文件',
  '员工记住的你的偏好和工作习惯',
  '打开这位员工的业务工作台',
];
const kinds = ['materials', 'files', 'experience', 'workflow'];
const session = 'session-00000000-0000-4000-8000-000000000036';
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

suite('installed employee topbar and native Start', () => {
  let browser: Browser, context: BrowserContext, page: Page;
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  let artifacts: string;
  const runtimeErrors: string[] = [];
  const command = <K extends keyof PanelsIntegration>(
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
  const right = () =>
    page.locator(
      `[data-sidebar-right-session="${session}"][data-sidebar-right-panel]`,
    );
  const entries = () => page.locator('[aria-label="工作台入口"]');
  const collapse = () =>
    right().getByRole('button', { name: '收起右侧边栏', exact: true }).click();
  const openStart = async () => {
    await page
      .getByRole('button', { name: '打开右侧边栏', exact: true })
      .click();
    await right().getByRole('tab', { name: '开始', exact: true }).waitFor();
    await right().getByText(descriptions[0]!, { exact: true }).waitFor();
  };
  const card = (label: string) =>
    right()
      .getByRole('button')
      .filter({
        has: page.locator('strong').getByText(label, { exact: true }),
      });
  const fourVisible = async () => {
    for (const label of labels) {
      const button = entries().getByRole('button', {
        name: new RegExp(`^${label}(?:，|$)`),
      });
      expect(await button.isVisible(), `${label} must remain visible`).toBe(
        true,
      );
      // isVisible alone does not detect the native narrow overlay covering the
      // parent header. A real pointer must still reach the requested launcher.
      expect(
        await button.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          return hit !== null && node.contains(hit);
        }),
        `${label} must remain pointer-reachable`,
      ).toBe(true);
    }
  };
  const shot = async (name: string) => {
    await settle(page);
    await page.screenshot({
      path: join(artifacts, `${name}.png`),
      fullPage: true,
    });
  };

  beforeAll(async () => {
    const parent = resolve(
      process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ??
        join(tmpdir(), 'allrice-composition-evidence'),
    );
    await mkdir(parent, { recursive: true });
    artifacts = await mkdtemp(join(parent, 'employee-topbar-'));
    console.info(`Installed employee topbar evidence: ${artifacts}`);
    host = await startInstalledProfile(
      await writeEmployeePanelsFixture(artifacts),
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
          browser: browser.version(),
          node: process.version,
          nativeVersion: '0.2.1-rc.2',
          dpr: 1,
          clock: panelsClock,
          reducedMotion: 'reduce',
          fixture:
            'existing synthetic panels owner; native installed Host/registry/child history',
          authenticatedHost: 'not exercised; MET-271 remains a separate gate',
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
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
    });
    await context.addInitScript((clock) => {
      Date.now = () => Date.parse(clock);
      // The reviewed child helper uses this older fixture name. Delegate only
      // to the existing owner public navigation; no product/store replacement.
      Object.defineProperty(window, '__allriceCompositionTest', {
        configurable: true,
        get: () =>
          window.__allricePanelsIntegration
            ? {
                openSession: (id: string) =>
                  window.__allricePanelsIntegration!.openSession(
                    id as Parameters<PanelsIntegration['openSession']>[0],
                  ),
                setTheme: (mode: 'light' | 'dark') =>
                  window.__allricePanelsIntegration!.setTheme(mode),
              }
            : undefined,
      });
    }, panelsClock);
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.method() !== 'GET') {
        await route.fulfill({
          status: 403,
          json: { error: { code: 'SYNTHETIC_READ_ONLY' } },
        });
        return;
      }
      const data = createSyntheticPanelsData('list');
      if (url.pathname === '/api/v1/references/publications')
        await route.fulfill({ json: data.catalog });
      else if (url.pathname === '/api/v1/workbench/files')
        await route.fulfill({ json: data.files });
      else
        await route.fulfill({
          status: 404,
          json: { error: { code: 'SYNTHETIC_NOT_PROVIDED' } },
        });
    });
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
      const id = test.task.id.replace(/\W/g, '-');
      await shot(`first-failure-${id}`);
      await writeFile(
        join(artifacts, `first-failure-${id}.json`),
        JSON.stringify(
          {
            test: test.task.name,
            errors: runtimeErrors,
            evidence: await command('evidence').catch(String),
          },
          null,
          2,
        ),
      );
    }
    await context?.close();
    await writeFile(
      join(artifacts, 'runtime-errors.json'),
      JSON.stringify(runtimeErrors, null, 2),
    );
  });
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      it(`keeps controls in native order, opens Start, switches panels and returns closed ${width} ${theme}`, async () => {
        await page.setViewportSize({ width, height: 1000 });
        await command('setTheme', theme);
        expect(await page.getByText('标准模式', { exact: true }).count()).toBe(
          0,
        );
        await fourVisible();
        const launchers = entries().getByRole('button');
        expect((await launchers.all()).length).toBe(4);
        expect(
          (
            await launchers.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute('aria-label')),
            )
          ).map((label) => label?.split('，')[0]),
        ).toEqual(labels);
        const count = page.getByRole('button', {
          name: '1 个子智能体',
          exact: true,
        });
        const corner = page.getByRole('button', {
          name: '打开右侧边栏',
          exact: true,
        });
        const countBox = (await count.boundingBox())!,
          firstBox = (await launchers.first().boundingBox())!,
          lastBox = (await launchers.last().boundingBox())!,
          cornerBox = (await corner.boundingBox())!;
        expect(countBox.x + countBox.width).toBeLessThanOrEqual(firstBox.x);
        expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(cornerBox.x);
        await shot(`topbar-closed-${width}-${theme}`);
        await openStart();
        const cards = right()
          .getByRole('button')
          .filter({ has: page.locator('strong') });
        expect(await cards.locator('strong').allTextContents()).toEqual(labels);
        for (const description of descriptions)
          expect(
            await right().getByText(description, { exact: true }).isVisible(),
          ).toBe(true);
        expect(
          await page.getByRole('button', { name: /新建终端/ }).count(),
        ).toBe(0);
        await shot(`start-${width}-${theme}`);
        for (const [index, kind] of kinds.entries()) {
          if (index > 0) {
            await collapse();
            await openStart();
          }
          await card(labels[index]!).click();
          await page.waitForFunction(
            (kind) =>
              window.__allricePanelsIntegration!.evidence().activeKind ===
              `allrice-employee-panels.${kind}`,
            kind,
          );
          await right()
            .getByRole('tab', { name: labels[index], exact: true })
            .waitFor();
          if (index === 0) await shot(`topbar-open-${width}-${theme}`);
        }
        expect(
          await right()
            .getByRole('button', { name: '分栏', exact: true })
            .count(),
        ).toBe(1);
        expect(await right().locator('[data-sidebar-right-mode]').count()).toBe(
          1,
        );
        expect(
          await right()
            .getByRole('button', { name: '收起右侧边栏', exact: true })
            .count(),
        ).toBe(1);
        // This deliberately remains a strict regression at 390. Native fullscreen
        // currently covers the main header; do not weaken it to DOM existence.
        await fourVisible();
        for (const [index, kind] of kinds.entries()) {
          await entries()
            .getByRole('button', {
              name: new RegExp(`^${labels[index]}(?:，|$)`),
            })
            .click();
          await page.waitForFunction(
            (kind) =>
              window.__allricePanelsIntegration!.evidence().activeKind ===
              `allrice-employee-panels.${kind}`,
            kind,
          );
          await fourVisible();
        }
        await collapse();
        await fourVisible();
        await openStart(); // Reopening after a selected business tab must be Start.
        await collapse();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        expect(runtimeErrors).toEqual([]);
      });
    }

  it('preserves the native catalog trailing arrow and opens the same read-only right child', async () => {
    await page
      .getByRole('button', { name: '1 个子智能体', exact: true })
      .click();
    const tree = page.getByRole('tree', { name: '子智能体会话' });
    await tree.getByRole('button', { name: /在侧边栏打开/ }).click();
    const child = page.locator('[data-sidebar-chat]');
    await child
      .getByRole('status')
      .filter({ hasText: '只读会话 · 由主员工安排后续工作' })
      .waitFor();
    expect(
      await child
        .locator('textarea:visible,[contenteditable=true]:visible')
        .count(),
    ).toBe(0);
    await page.getByRole('tab', { name: /复核三条销售记录/ }).waitFor();
    expect(
      await page
        .locator(`[data-conversation-session="${session}"]`)
        .isVisible(),
    ).toBe(true);
  });

  childPaneBrowserCases(() => page);
});
