import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CompanyDeliverable } from '@allrice/contracts';
import { nativeExcelAssetResponse } from '../../lib/chatflow/native-document-asset';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const integration =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('shared administration shell and dialogs', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/admin-design-page.tsx'],
      bundle: true,
      format: 'esm',
      splitting: true,
      platform: 'browser',
      write: false,
      outdir: '/admin-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      const asset = assets.get(path);
      if (path === '/api/dsh-ui/excel') {
        void nativeExcelAssetResponse(
          new Request(`http://fixture${req.url}`, {
            headers: {
              'accept-encoding': String(req.headers['accept-encoding'] ?? ''),
            },
          }),
        )
          .then(async (response) => {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(() => {
            res.statusCode = 500;
            res.end();
          });
      } else if (asset) {
        res.setHeader(
          'Content-Type',
          path.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        res.end(asset);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/admin-design-page.css"><div id="root"></div><script type="module" src="/admin-design-page.js"></script>',
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../worker/package.json', import.meta.url),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_BROWSER_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
  });
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('keeps navigation available at 320px and scopes the dark theme to the admin', async () => {
    const page = await browser.newPage({
      viewport: { width: 320, height: 800 },
    });
    try {
      await page.goto(origin);
      await page.getByRole('heading', { name: '组织管理' }).waitFor();
      const colors = await page.evaluate(() => ({
        outside: getComputedStyle(document.querySelector('[data-outside]')!)
          .color,
        admin: getComputedStyle(document.querySelector('[data-admin-theme]')!)
          .color,
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      }));
      expect(colors.admin).not.toBe(colors.outside);
      expect(colors.overflow).toBe(false);
      await page.getByRole('button', { name: 'AI 员工', exact: true }).click();
      await page
        .getByRole('heading', { name: 'AI 员工', exact: true })
        .waitFor();
      expect(
        await page
          .getByRole('button', { name: 'AI 员工', exact: true })
          .getAttribute('aria-current'),
      ).toBe('page');
    } finally {
      await page.close();
    }
  });
  it('traps modal focus, restores the trigger and prevents closing during submission', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      const trigger = page.getByRole('button', {
        name: '添加员工',
        exact: true,
      });
      await trigger.click();
      await page
        .getByRole('dialog', { name: '添加员工', exact: true })
        .waitFor();
      for (let i = 0; i < 7; i++) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(
            () => !!document.activeElement?.closest('dialog'),
          ),
        ).toBe(true);
      }
      await page.getByLabel('提交中').check();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(1);
      await page.getByLabel('提交中').uncheck();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(
        await trigger.evaluate((el) => el === document.activeElement),
      ).toBe(true);
      await page.getByLabel('员工操作', { exact: true }).first().click();
      await page.getByRole('button', { name: '编辑员工' }).waitFor();
      await trigger.click();
      expect(await page.locator('details[open]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it.each([1440, 390])(
    'folds skill history and exposes arriving failures at %ipx',
    async (width) => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}?skills=1`);
        const group = page.locator('[data-skill-phase="ready"]');
        const summary = group.locator('summary');
        const rows = group.locator('ol > li');
        await summary.waitFor();
        expect(await summary.getAttribute('aria-expanded')).toBe('false');
        expect(await rows.first().isVisible()).toBe(false);
        await summary.press('Enter');
        expect(await rows.count()).toBe(13);
        expect(await rows.first().isVisible()).toBe(true);
        const measured = await rows.first().evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          font: getComputedStyle(element).fontSize,
          overflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        }));
        expect(measured).toEqual({ height: 28, font: '12px', overflow: false });
        expect(
          await group.getByText('Skill 已就绪', { exact: true }).count(),
        ).toBe(0);
        await summary.click();
        await page.getByRole('button', { name: '切换失败记录' }).click();
        expect(await summary.getAttribute('aria-expanded')).toBe('true');
        expect(await summary.innerText()).toContain('1 项失败');
        await summary.click();
        expect(await summary.innerText()).toContain('1 项失败');
        expect(await rows.first().isVisible()).toBe(false);
        await page.getByRole('button', { name: '切换汇总格式' }).click();
        expect(await summary.innerText()).toContain('技能已就绪 · 13 个');
        expect(await rows.first().isVisible()).toBe(false);
        await summary.click();
        expect(await rows.count()).toBe(13);
        expect(await rows.last().innerText()).toContain('workspace-briefing');
      } finally {
        await page.close();
      }
    },
  );
  it.each([1440, 390])(
    'keeps the actual fixed-version Excel grid usable with expanded evidence at %ipx',
    async (width) => {
      const ExcelJS = createRequire(
        new URL('../../../worker/package.json', import.meta.url),
      )('exceljs');
      const versions = await Promise.all(
        [2, 1].map(async (version) => {
          const book = new ExcelJS.Workbook();
          const sheet = book.addWorksheet('Totals');
          sheet.addRow(['Left', 'Right', 'Total']);
          sheet.addRow([
            20 * version,
            22 * version,
            { formula: 'A2+B2', result: 42 * version },
          ]);
          book
            .addWorksheet(`Version ${version}`)
            .addRow([`Immutable version ${version}`]);
          const bytes = Buffer.from(await book.xlsx.writeBuffer());
          const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          const row: CompanyDeliverable = {
            id: `00000000-0000-4000-8000-00000000000${version + 1}`,
            seriesId: '00000000-0000-4000-8000-000000000010',
            workspaceId: '00000000-0000-4000-8000-000000000011',
            ownerId: '00000000-0000-4000-8000-000000000012',
            ownerName: 'Preview fixture owner',
            sessionId: '00000000-0000-4000-8000-000000000013',
            sessionTitle: 'Static browser fixture, no model run',
            runId: null,
            runStatus: null,
            employeeId: null,
            employeeName: null,
            fileName: 'fixed-version.xlsx',
            format: 'xlsx',
            version,
            latestPublishedVersion: 2,
            createdAt: '2026-10-20T00:00:00.000Z',
            sizeBytes: bytes.length,
            state: 'ready',
          };
          return { row, bytes, checksum };
        }),
      );
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [],
        methods: string[] = [],
        requests: string[] = [];
      page.on('pageerror', (error) =>
        errors.push(error.stack ?? error.message),
      );
      await page.route(
        '**/api/v1/admin/organizations/*/deliverables?**',
        async (route) => {
          methods.push(route.request().method());
          const query = new URL(route.request().url()).searchParams;
          const version = versions.find(
            (item) => item.row.id === query.get('artifactId'),
          );
          if (version) {
            requests.push(version.row.id);
            if (query.has('download'))
              return route.fulfill({
                contentType:
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                headers: {
                  'content-disposition':
                    'attachment; filename="fixed-version.xlsx"',
                },
                body: version.bytes,
              });
            if (query.has('metadata'))
              return route.fulfill({
                json: {
                  objectId: version.row.id,
                  checksum: version.checksum,
                  sourceFile: null,
                  office: {
                    quality: {
                      status: 'checked',
                      format: 'xlsx',
                      pageCount: 1,
                      formulaCount: 1,
                      formulaErrorCount: 0,
                      layout: 'rendered_not_visually_reviewed',
                    },
                    warnings: [
                      '已生成页面预览；转换成功不代表排版已人工检查，数值结果不代替业务核对。',
                      'Preview fixture warning: retained bytes and the chosen version must not change when evidence expands.',
                    ],
                  },
                },
              });
            return route.fulfill({
              json: {
                kind: 'spreadsheet',
                format: 'xlsx',
                base64: version.bytes.toString('base64'),
              },
            });
          }
          return route.fulfill({
            json: {
              organizationId: '00000000-0000-4000-8000-000000000001',
              deliverables: query.has('seriesId')
                ? versions.map((item) => item.row)
                : [versions[0]!.row],
              nextCursor: null,
              seriesId: query.get('seriesId'),
            },
          });
        },
      );
      try {
        await page.goto(`${origin}?company-files=1`);
        await page
          .getByRole('button', { name: '查看成果', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: '公司成果预览',
          exact: true,
        });
        const selected = dialog.getByLabel('成果版本', { exact: true });
        const native = dialog.locator('[data-excel-preview]');
        await dialog
          .getByText('Totals', { exact: true })
          .waitFor({ timeout: 30_000 });
        await dialog.getByText('文件来源与质量', { exact: true }).click();
        await dialog
          .getByText(versions[0]!.checksum, { exact: true })
          .waitFor();
        const metrics = async () =>
          native.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const canvases = [...element.querySelectorAll('canvas')].map(
              (canvas) => ({
                width: canvas.getBoundingClientRect().width,
                height: canvas.getBoundingClientRect().height,
              }),
            );
            const modal = element.closest('dialog')!;
            const dialogBox = modal.getBoundingClientRect();
            return {
              height: box.height,
              width: box.width,
              canvases,
              dialog: {
                x: dialogBox.x,
                y: dialogBox.y,
                width: dialogBox.width,
                height: dialogBox.height,
              },
              dialogScrollable: modal.scrollHeight > modal.clientHeight,
              documentOverflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            };
          });
        await expect
          .poll(async () => (await metrics()).canvases.length, {
            timeout: 5000,
          })
          .toBeGreaterThan(0);
        const expanded = await metrics();
        const screenshotDir = process.env.ALLRICE_BROWSER_SCREENSHOT_DIR;
        if (screenshotDir) {
          await mkdir(screenshotDir, { recursive: true });
          await native.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(screenshotDir, `admin-preview-${width}.png`),
            fullPage: true,
          });
          await writeFile(
            resolve(screenshotDir, `admin-preview-${width}.json`),
            JSON.stringify(expanded, null, 2),
          );
        }
        expect(expanded.height).toBeGreaterThanOrEqual(280);
        expect(expanded.height).toBeLessThanOrEqual(640);
        expect(
          Math.max(...expanded.canvases.map((canvas) => canvas.height)),
        ).toBeGreaterThan(200);
        expect(expanded.dialog.x).toBeGreaterThanOrEqual(0);
        expect(expanded.dialog.x + expanded.dialog.width).toBeLessThanOrEqual(
          width,
        );
        expect(expanded.dialog.y).toBeGreaterThanOrEqual(0);
        expect(expanded.dialog.y + expanded.dialog.height).toBeLessThanOrEqual(
          900,
        );
        expect(expanded.documentOverflow).toBe(false);
        await selected.selectOption(versions[1]!.row.id);
        await dialog
          .getByText('Version 1', { exact: true })
          .waitFor({ timeout: 30_000 });
        await dialog
          .getByText(versions[1]!.checksum, { exact: true })
          .waitFor();
        expect(
          await dialog.getByText('Version 2', { exact: true }).count(),
        ).toBe(0);
        const prior = await metrics();
        expect(prior.height).toBe(expanded.height);
        expect(
          Math.max(...prior.canvases.map((canvas) => canvas.height)),
        ).toBeGreaterThan(200);
        await dialog.getByText('Version 1', { exact: true }).click();
        await dialog.getByText('Totals', { exact: true }).click();
        const downloaded = page.waitForEvent('download');
        await dialog
          .getByRole('link', { name: '下载原文件', exact: true })
          .click();
        const download = await downloaded;
        expect(await download.failure()).toBeNull();
        expect(
          `sha256:${createHash('sha256')
            .update(await readFile((await download.path())!))
            .digest('hex')}`,
        ).toBe(versions[1]!.checksum);
        expect(await selected.inputValue()).toBe(versions[1]!.row.id);
        expect(
          await dialog
            .getByText(versions[1]!.checksum, { exact: true })
            .count(),
        ).toBe(1);
        expect(requests).toContain(versions[1]!.row.id);
        expect(methods.every((method) => method === 'GET')).toBe(true);
        // The native spreadsheet announces the selected cell with role=alert.
        // Application load errors live outside that loaded spreadsheet surface.
        const alertTexts = await dialog
          .getByRole('alert')
          .evaluateAll((elements) =>
            elements
              .filter((element) => !element.closest('[data-excel-preview]'))
              .map((element) => element.textContent?.trim())
              .filter(Boolean),
          );
        expect(alertTexts).toEqual([]);
        if (screenshotDir) {
          await native.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(screenshotDir, `admin-preview-v1-${width}.png`),
            fullPage: true,
          });
        }
        await page.setViewportSize({ width, height: 400 });
        await expect.poll(async () => (await metrics()).height).toBe(280);
        await expect
          .poll(async () =>
            Math.max(
              ...(await metrics()).canvases.map((canvas) => canvas.height),
            ),
          )
          .toBeGreaterThan(200);
        const short = await metrics();
        expect(short.dialog.height).toBeLessThanOrEqual(368);
        expect(short.dialogScrollable).toBe(true);
        expect(short.documentOverflow).toBe(false);
        if (screenshotDir) {
          await native.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(screenshotDir, `admin-preview-short-${width}.png`),
            fullPage: true,
          });
          await writeFile(
            resolve(screenshotDir, `admin-preview-final-${width}.json`),
            JSON.stringify(
              {
                expanded,
                prior,
                short,
                selectedId: await selected.inputValue(),
                downloadChecksum: versions[1]!.checksum,
                alertTexts,
                requestMethods: methods,
                browserErrors: errors,
              },
              null,
              2,
            ),
          );
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
