import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import {
  deliveryName,
  documentSession,
  processSession,
} from './native-history.mjs';

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
suite('installed AllRice native Web composition', () => {
  let browser: Browser, page: Page;
  let host: Awaited<ReturnType<typeof startInstalledProfile>>;
  const errors: string[] = [];

  beforeAll(async () => {
    host = await startInstalledProfile();
    const { origin, authUrl } = host;
    // The generated Web token stays in memory; no credential file is read/copied.
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(authUrl);
    const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await page.goto(origin);
    await page.waitForFunction(() => !!window.__allriceCompositionTest);
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await host?.close();
    }
  });

  it('keeps native disclosure, drafts, answered questions and document preview after actual installation', async () => {
    try {
      await page
        .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
          exact: true,
        })
        .waitFor();
      for (const width of [1440, 390])
        for (const theme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            (mode) => window.__allriceCompositionTest!.setTheme(mode),
            theme,
          );
          const group = page.getByRole('button', {
            name: '已完成，用时 10秒',
            exact: true,
          });
          if ((await group.getAttribute('aria-expanded')) === 'false')
            await group.click();
          const tool = page.getByRole('button', {
            name: '执行了命令',
            exact: true,
          });
          if ((await tool.getAttribute('aria-expanded')) === 'false')
            await tool.click();
          const command = page
            .getByRole('button', { name: /^运行命令/ })
            .first();
          if ((await command.getAttribute('aria-expanded')) === 'false')
            await command.click();
          expect(
            await page
              .getByText('node tasks/pair/action.cjs', { exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByText(/"totalCents":5630/)
              .first()
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('button', { name: '1 个子智能体', exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('tab', { name: /^(Chat|Trajectory|对话|轨迹)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('button', { name: /^(更多操作|More actions)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page
              .locator('button:visible')
              .filter({
                hasText: /^(完全访问|选择模型|Full access|Select model)$/,
              })
              .count(),
          ).toBe(0);
          expect(
            await page.getByRole('button', { name: /上下文已用/ }).isVisible(),
          ).toBe(true); // documented upstream gap
          expect(await page.locator('body').innerText()).not.toMatch(
            /Open In|(?:Usage|Cache|用量|缓存)\s*[\d:]/,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          await command.click();
          await tool.click();
          await group.click();
        }
      const editor = page
        .locator('textarea:visible,[contenteditable=true]:visible')
        .first();
      await editor.fill('未发送的原生草稿');
      await page
        .getByRole('button', { name: '已完成，用时 10秒', exact: true })
        .click();
      expect(
        await editor.evaluate((node) =>
          node instanceof HTMLTextAreaElement ? node.value : node.textContent,
        ),
      ).toContain('未发送的原生草稿');
      await editor.fill('');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        documentSession,
      );
      await page
        .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
        .waitFor();
      const questionProcess = page
        .getByRole('button', { name: /^已完成，用时/ })
        .first();
      if ((await questionProcess.getAttribute('aria-expanded')) === 'false')
        await questionProcess.click();
      const questionStep = page.getByRole('button', {
        name: '向用户提出了问题并已调用工具',
        exact: true,
      });
      if ((await questionStep.getAttribute('aria-expanded')) === 'false')
        await questionStep.click();
      // The fixture follows the standard preset's legacy ask-user tool. Its
      // answered transcript opens inline; timed calls alone have View answers.
      const questionRow = page.getByRole('button', { name: /^提问/ });
      const questionExpanded = await questionRow.getAttribute('aria-expanded');
      expect(
        await page.getByText('1/1 已回答', { exact: true }).isVisible(),
      ).toBe(true);
      if (questionExpanded === 'false') await questionRow.click();
      expect(
        await page
          .getByText('核对说明采用哪种格式？', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await page.getByText('Markdown', { exact: true }).first().isVisible(),
      ).toBe(true);
      await page
        .getByRole('button', {
          name: new RegExp(`^在侧边栏预览 .*${deliveryName}$`),
        })
        .click();
      await page.getByText('原生文档保留验证', { exact: true }).waitFor();
      expect(
        await page.getByText('56.30 元', { exact: true }).isVisible(),
      ).toBe(true);
      await page.reload();
      await page.waitForFunction(() => !!window.__allriceCompositionTest);
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        processSession,
      );
      await page
        .getByText(/命令已执行一次，结果为 P4_ACTION_DONE=true/)
        .waitFor();
      expect(errors).toEqual([]);
    } catch (error) {
      // Optional screenshots contain the rendered UI only, never login URL or credentials.
      if (process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR) {
        const target = resolve(
          process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
        );
        await mkdir(target, { recursive: true });
        const attempt = await mkdtemp(
          join(target, 'installed-profile-failure-'),
        );
        await page.screenshot({
          path: join(attempt, 'page.png'),
          fullPage: true,
        });
        await writeFile(
          join(attempt, 'body.txt'),
          await page.locator('body').innerText(),
        );
      }
      throw error;
    }
  }, 60_000);
});
