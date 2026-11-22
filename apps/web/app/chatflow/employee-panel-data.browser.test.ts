import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type { PanelDataState } from '../../test/employee-panel-data-page';

// Business data is an explicit in-browser contract substitute. Product panels,
// hooks, forms, actions and native document components are the actual code.
// This suite proves neither authenticated BFF/PG nor production storage effects.
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const environments = [
  { width: 1440, theme: 'light' },
  { width: 1440, theme: 'dark' },
  { width: 390, theme: 'light' },
  { width: 390, theme: 'dark' },
] as const;
const root = (page: Page) =>
  page.getByRole('main', { name: '资料成果真实组件' });
const evidence = (page: Page) =>
  page.evaluate(() => window.__panelDataFixture.evidence());
const control = (
  page: Page,
  state: PanelDataState,
  kind: 'files' | 'materials',
) =>
  page.evaluate(
    ({ state, kind }) => {
      window.__panelDataFixture.setState(state);
      window.__panelDataFixture.setKind(kind);
    },
    { state, kind },
  );
const firstFile = '第四季度销售口径说明.pdf';
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

suite(
  'MET-282 bound contract -> real materials and deliverables components',
  () => {
    let browser: Browser, server: Server, origin: string;
    const output = resolve(
      process.env.ALLRICE_PANEL_DATA_ARTIFACT_DIR ??
        '.local/employee-panel-data-browser',
    );
    beforeAll(async () => {
      await mkdir(output, { recursive: true });
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        absWorkingDir: process.cwd(),
        entryPoints: ['apps/web/test/employee-panel-data-page.tsx'],
        bundle: true,
        format: 'esm',
        splitting: true,
        platform: 'browser',
        write: false,
        outdir: '/unused-employee-panel-data',
        jsx: 'automatic',
        loader: {
          '.woff2': 'dataurl',
          '.woff': 'dataurl',
          '.ttf': 'dataurl',
          '.svg': 'dataurl',
        },
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const assets = new Map<string, Uint8Array>(
        built.outputFiles.map(
          (file: { path: string; contents: Uint8Array }) => [
            file.path.slice(file.path.lastIndexOf('/')),
            file.contents,
          ],
        ),
      );
      server = createServer((request, response) => {
        const path = new URL(request.url!, origin).pathname;
        const asset = assets.get(path);
        if (asset) {
          response.writeHead(200, {
            'Content-Type': path.endsWith('.css')
              ? 'text/css'
              : 'application/javascript',
          });
          response.end(asset);
        } else if (path === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(
            '<!doctype html><html lang="zh-CN" data-allrice-framework="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-panel-data-page.css"></head><body><div id="root"></div><script type="module" src="/employee-panel-data-page.js"></script></body></html>',
          );
        } else {
          response.writeHead(404);
          response.end();
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { chromium } = require('playwright-core');
      const executablePath =
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined);
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      await writeFile(
        join(output, 'environment.json'),
        JSON.stringify(
          {
            head: execFileSync('git', ['rev-parse', 'HEAD'], {
              encoding: 'utf8',
            }).trim(),
            browser: browser.version(),
            os: process.platform,
            dpr: 1,
            data: 'explicit synthetic contract; no authenticated BFF/storage',
            components: 'current product components; unchanged rev2 CSS',
            environments,
          },
          null,
          2,
        ),
      );
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((done) => server.close(() => done()));
    });

    for (const env of environments)
      it(`${env.width}/${env.theme}: search, cross-employee favorites, exact quote, preview, download, fixed copy, upload and failure states`, async () => {
        const context = await browser.newContext({
          viewport: { width: env.width, height: 900 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          acceptDownloads: true,
        });
        const page = await context.newPage();
        const failures: string[] = [],
          legacyRequests: string[] = [];
        page.on('pageerror', (error) => failures.push(error.message));
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/api/'))
            legacyRequests.push(request.url());
        });
        const screenshot = (name: string) =>
          page.screenshot({
            path: join(output, `${env.width}-${env.theme}-${name}.png`),
            fullPage: true,
          });
        try {
          await page.goto(origin + '/?theme=' + env.theme);
          await page.waitForFunction(() => !!window.__panelDataFixture);
          await root(page).getByText(firstFile, { exact: true }).waitFor();
          expect(
            await root(page)
              .getByRole('combobox', { name: '按员工筛选' })
              .inputValue(),
          ).toBe(uid(3));
          await screenshot('files-list');
          await root(page)
            .getByRole('button', { name: '我的收藏', exact: true })
            .click();
          await root(page)
            .getByText('销售复盘与行动清单.md', { exact: true })
            .waitFor();
          expect(
            await root(page)
              .getByRole('combobox', { name: '按员工筛选' })
              .isDisabled(),
          ).toBe(true);
          const favoriteRequest = (await evidence(page)).calls
            .filter((call) => call.method === 'listDeliverables')
            .at(-1)!.input as { category: string; employeeInstanceId?: string };
          expect(favoriteRequest).toMatchObject({ category: 'favorite' });
          expect(favoriteRequest.employeeInstanceId).toBeUndefined();
          await screenshot('files-favorites');

          await root(page)
            .getByRole('button', { name: '全部', exact: true })
            .click();
          await root(page)
            .getByRole('combobox', { name: '按员工筛选' })
            .selectOption('');
          await root(page)
            .getByRole('textbox', { name: '查找文件', exact: true })
            .fill('第四季度');
          await root(page).getByText(firstFile, { exact: true }).waitFor();
          await root(page)
            .getByRole('button', {
              name: '引用到对话 ' + firstFile,
              exact: true,
            })
            .click();
          await expect
            .poll(async () => (await evidence(page)).used.length)
            .toBe(1);
          expect((await evidence(page)).used[0]).toMatchObject({
            sourceId: uid(100),
            revisionId: uid(200),
            revision: 1,
          });
          await root(page).getByText(firstFile, { exact: true }).click();
          await root(page)
            .getByText('这是固定文件第一页。', { exact: false })
            .waitFor();
          await root(page)
            .getByRole('button', { name: '下一页', exact: true })
            .click();
          await root(page)
            .getByText('这是固定文件末页。', { exact: false })
            .waitFor();
          expect(
            (await evidence(page)).calls.some(
              (call) =>
                call.method === 'previewDeliverable' &&
                (call.input as { offset?: number }).offset === 3,
            ),
          ).toBe(true);
          const download = page.waitForEvent('download');
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '下载', exact: true })
            .click();
          const received = await download;
          const path = join(output, `${env.width}-${env.theme}-download.bin`);
          await received.saveAs(path);
          expect(
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ).toBe(createHash('sha256').update('固定原件内容').digest('hex'));
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '收藏', exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await evidence(page)).files.find(
                  (f) => f.objectId === uid(300),
                )?.favorite,
            )
            .toBe(true);
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '取消收藏', exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await evidence(page)).files.find(
                  (f) => f.objectId === uid(300),
                )?.favorite,
            )
            .toBe(false);
          await root(page)
            .locator('header[aria-label="文件操作"]')
            .getByRole('button', { name: '添加为企业资料', exact: true })
            .click();
          const dialog = page.getByRole('dialog', {
            name: '添加为企业资料',
            exact: true,
          });
          await dialog
            .getByRole('radio', { name: '全公司', exact: true })
            .check();
          await dialog
            .getByRole('textbox', { name: '用途', exact: true })
            .fill('固定副本，不随原件改变');
          await screenshot('publication-dialog');
          await dialog
            .getByRole('button', { name: '确认', exact: true })
            .click();
          await dialog.waitFor({ state: 'hidden' });
          await expect
            .poll(async () => (await evidence(page)).writes.length)
            .toBe(1);
          await page.evaluate(() => window.__panelDataFixture.mutateOriginal());
          expect((await evidence(page)).copies[0]?.[1]).toBe('固定原件内容');
          await screenshot('files-detail');

          for (let i = 0; i < 2; i++) {
            await page
              .getByLabel('上传个人成果', { exact: true })
              .setInputFiles({
                name: '我的成果.txt',
                mimeType: 'text/plain',
                buffer: Buffer.from('本人独立上传'),
              });
            await expect
              .poll(
                async () =>
                  (await evidence(page)).calls.filter(
                    (call) => call.method === 'uploadDeliverable',
                  ).length,
              )
              .toBe(i + 1);
          }
          const uploaded = (await evidence(page)).files.filter((f) =>
            f.fileName.startsWith('我的成果.txt'),
          );
          expect(uploaded).toHaveLength(2);
          expect(new Set(uploaded.map((f) => f.objectId)).size).toBe(2);

          await control(page, 'list', 'materials');
          await root(page)
            .getByText(firstFile, { exact: true })
            .first()
            .waitFor();
          await root(page)
            .getByRole('textbox', { name: '查找资料（文件名、用途、正文）' })
            .fill('销售');
          await root(page).locator('mark').first().waitFor();
          expect(
            await root(page).locator('[data-file-row-scope]').allTextContents(),
          ).toEqual(expect.arrayContaining(['全公司', '销售部', '仅自己']));
          await root(page)
            .getByRole('button', { name: '引用到对话', exact: true })
            .first()
            .click();
          await expect
            .poll(async () => (await evidence(page)).used.length)
            .toBe(2);
          await screenshot('materials-search');

          for (const kind of ['files', 'materials'] as const) {
            for (const state of [
              'empty',
              'loading',
              'error',
              'denied',
              'unbound',
              'longname',
            ] as const) {
              await control(page, state, kind);
              if (state === 'loading')
                await root(page).getByRole('status').first().waitFor();
              else if (state === 'empty')
                await root(page)
                  .getByText(
                    kind === 'files' ? '还没有交付成果' : '还没有企业资料',
                    { exact: true },
                  )
                  .waitFor();
              else if (state === 'longname')
                await root(page)
                  .getByText(
                    '2026年度企业服务重点客户续约与交付情况汇总表（华东区最终确认版本）.xlsx',
                    { exact: true },
                  )
                  .waitFor();
              else {
                await root(page).getByRole('alert').waitFor();
                expect(
                  await root(page)
                    .getByText(firstFile, { exact: true })
                    .count(),
                ).toBe(0);
              }
              const overflow = await root(page).evaluate(
                (node) => node.scrollWidth - node.clientWidth,
              );
              expect(overflow).toBeLessThanOrEqual(1);
              await screenshot(`${kind}-${state}`);
            }
          }
          expect(legacyRequests).toEqual([]);
          expect(failures).toEqual([]);
          await writeFile(
            join(output, `${env.width}-${env.theme}-receipt.json`),
            JSON.stringify(
              {
                ...env,
                legacyRequests,
                failures,
                evidence: await evidence(page),
              },
              null,
              2,
            ),
          );
        } catch (error) {
          await screenshot('first-failure');
          await writeFile(
            join(output, `${env.width}-${env.theme}-first-failure.json`),
            JSON.stringify(
              {
                ...env,
                legacyRequests,
                failures,
                evidence: await evidence(page).catch(() => null),
              },
              null,
              2,
            ),
          );
          throw error;
        } finally {
          await context.close();
        }
      }, 120_000);
  },
);
