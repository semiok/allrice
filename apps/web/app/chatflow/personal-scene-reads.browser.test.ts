/** Existing UI components and exact HTTP reads; synthetic responses, no model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import type {
  PersonalSceneSkill,
  PersonalSceneReadHistory,
} from '@allrice/contracts';
import { skillBytesChecksum } from '../../../../packages/database/src/skill-bundles.ts';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instanceId = id(1),
  sceneId = id(20),
  readAt = '2026-11-04T12:00:00.000Z';
const bytes = (version: string) =>
  Buffer.from(
    `<script>window.workflowExecuted=1</script>\n固定资源 ${version}\n`,
  );
function skill(version: string): PersonalSceneSkill {
  return {
    sceneId,
    name: '本人周报',
    description: '核对来源后整理',
    nativeName: `allrice-scene-${sceneId}`,
    contentRef: `exact-${version}`,
    revision: version === '1.0.0' ? 1 : 2,
    content: `准确正文 ${version}`,
    contentChecksum: skillBytesChecksum(`准确正文 ${version}`),
    bundleVersion: version,
    bundleChecksum: skillBytesChecksum(`bundle-${version}`),
    resources: [
      {
        path: 'references/template.md',
        mediaType: 'text/markdown',
        byteLength: bytes(version).length,
        checksum: skillBytesChecksum(bytes(version)),
      },
    ],
    sources: [],
  };
}
function history(): PersonalSceneReadHistory {
  const read = skill('1.0.0');
  return {
    instanceId,
    runs: [
      {
        runId: id(30),
        sessionId: id(31),
        messageId: id(32),
        createdAt: readAt,
        status: 'failed',
        error: {
          code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
          message: '工作要求或其引用资料已失效，请确认当前版本后重新发起任务。',
        },
        reads: [
          {
            receiptId: id(40),
            sceneId,
            contentRef: read.contentRef,
            contentChecksum: read.contentChecksum,
            bundleChecksum: read.bundleChecksum,
            contentRead: true,
            resources: read.resources.map(({ path, checksum }) => ({
              path,
              checksum,
            })),
            generationId: id(41),
            readAt,
          },
        ],
      },
    ],
    nextCursor: null,
  };
}
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
suite(
  'owner distinguishes availability, actual reads and unproven injection',
  () => {
    let browser: Browser, server: Server, origin: string;
    const screenshots = resolve('.local/met227-a5-preview');
    beforeAll(async () => {
      const require = createRequire(import.meta.url),
        { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        entryPoints: ['apps/web/test/personal-scene-reads-page.tsx'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        write: false,
        outdir: '/fixture',
        jsx: 'automatic',
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
        define: {
          'process.env.NODE_ENV': '"development"',
          'process.env': '{}',
        },
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
        const path = new URL(request.url!, 'http://localhost').pathname,
          asset = assets.get(path);
        response.setHeader(
          'Content-Type',
          asset
            ? path.endsWith('.css')
              ? 'text/css'
              : 'text/javascript'
            : 'text/html',
        );
        response.end(
          asset ??
            '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/personal-scene-reads-page.css"><div id="root"></div><script type="module" src="/personal-scene-reads-page.js"></script>',
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const { chromium } = createRequire(
        new URL('../../../worker/package.json', import.meta.url),
      )('playwright-core');
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
      await mkdir(screenshots, { recursive: true });
    }, 60000);
    afterAll(async () => {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 30000);

    async function open(width = 1280, dark = false) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      page.setDefaultTimeout(8000);
      const initializationErrors: string[] = [];
      let rejectInitialization!: (error: Error) => void;
      const initializationFailed = new Promise<never>((resolve, reject) => {
        void resolve;
        rejectInitialization = reject;
      });
      page.on('pageerror', (error) => {
        initializationErrors.push(error.message);
        console.error(
          'Personal Workflow read fixture pageerror:',
          error.message,
        );
        rejectInitialization(error);
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        initializationErrors.push(message.text());
        console.error(
          'Personal Workflow read fixture consoleerror:',
          message.text(),
        );
      });
      const state = {
        revoked: false,
        ledgerReads: 0,
        contentRefs: [] as string[],
      };
      await page.route('**/scene-skills/reads?**', async (route) => {
        state.ledgerReads++;
        const other = route.request().url().includes(id(2));
        await route.fulfill(
          json(
            other
              ? { instanceId: id(2), runs: [], nextCursor: null }
              : history(),
          ),
        );
      });
      await page.route('**/scene-skills/content?**', async (route) => {
        const ref = new URL(route.request().url()).searchParams.get(
          'contentRef',
        )!;
        state.contentRefs.push(ref);
        await route.fulfill(
          state.revoked
            ? json(
                {
                  error: {
                    code: 'RESOURCE_NOT_FOUND',
                    message: 'secret token=do-not-display',
                  },
                },
                404,
              )
            : json(skill(ref === 'exact-1.0.0' ? '1.0.0' : '2.0.0')),
        );
      });
      await page.route('**/scene-skills?**', async (route) => {
        const url = new URL(route.request().url()),
          query = url.searchParams,
          other = url.pathname.includes(id(2));
        if (query.has('resourcePath')) {
          const ref = query.get('contentRef')!,
            version = ref === 'exact-1.0.0' ? '1.0.0' : '2.0.0',
            exact = skill(version);
          state.contentRefs.push(ref);
          await route.fulfill(
            state.revoked
              ? json({ error: { code: 'RESOURCE_NOT_FOUND' } }, 404)
              : json({
                  ...exact.resources[0],
                  contentRef: exact.contentRef,
                  bundleChecksum: exact.bundleChecksum,
                  contentBase64: bytes(version).toString('base64'),
                }),
          );
        } else if (query.has('sceneId'))
          await route.fulfill(json(skill('2.0.0')));
        else
          await route.fulfill(
            json({
              instanceId: other ? id(2) : instanceId,
              revision: 2,
              skills:
                other || state.revoked
                  ? []
                  : [
                      {
                        sceneId,
                        name: '本人周报',
                        description: '核对来源后整理',
                        nativeName: `allrice-scene-${sceneId}`,
                      },
                      {
                        sceneId: id(21),
                        name: '尚未读取的 Workflow',
                        description: '仅在目录可用',
                        nativeName: `allrice-scene-${id(21)}`,
                      },
                    ],
            }),
          );
      });
      try {
        await Promise.race([
          (async () => {
            await page.goto(origin);
            if (dark)
              await page.evaluate(() =>
                document.body.setAttribute('data-ds-dark-theme', ''),
              );
            await page
              .getByText('本人 Workflow · 目录与读取记录', { exact: true })
              .click();
            await page
              .getByRole('button', {
                name: '查看当前包：本人周报',
                exact: true,
              })
              .waitFor();
            await page.getByRole('region', { name: '准确读取回执' }).waitFor();
          })(),
          initializationFailed,
        ]);
      } catch (error) {
        await page.close();
        throw new Error(
          `Workflow read fixture initialization failed: ${initializationErrors.join(' | ') || 'no page/console error'}`,
          { cause: error },
        );
      }
      return { page, state };
    }
    for (const width of [1280, 390])
      for (const dark of [false, true])
        it(`opens exact current and historical bytes without fabricating reads at ${width}px ${dark ? 'dark' : 'light'}`, async () => {
          const { page, state } = await open(width, dark);
          try {
            expect(
              await page
                .getByRole('region', { name: '当前可用 Workflow 目录' })
                .getByRole('article')
                .count(),
            ).toBe(2);
            expect(
              await page.getByRole('region', { name: '准确读取回执' }).count(),
            ).toBe(1);
            expect(await page.locator('body').innerText()).toContain(
              '当前记录未提供准确注入或原生调用关联',
            );
            expect(await page.locator('body').innerText()).not.toContain(
              '已注入',
            );
            const originalReads = state.ledgerReads;
            await page
              .getByRole('button', {
                name: '查看当前包：本人周报',
                exact: true,
              })
              .click();
            await page.getByText('准确正文 2.0.0', { exact: true }).waitFor();
            await page
              .getByRole('button', {
                name: '读取资源：references/template.md',
                exact: true,
              })
              .click();
            await page
              .getByRole('region', { name: '已核验的资源文件' })
              .waitFor();
            expect(
              await page
                .getByRole('region', { name: '已核验的资源文件' })
                .innerText(),
            ).toContain('固定资源 2.0.0');
            expect(
              await page.evaluate(() =>
                Reflect.get(window, 'workflowExecuted'),
              ),
            ).toBeUndefined();
            expect(state.ledgerReads).toBe(originalReads);
            const typography = await page
              .getByRole('region', { name: '查看的 Workflow 正文' })
              .locator('pre')
              .evaluate((node) => ({
                font: Number.parseFloat(getComputedStyle(node).fontSize),
                line: Number.parseFloat(getComputedStyle(node).lineHeight),
              }));
            expect(typography).toEqual({ font: 13, line: 20 });
            const contrast = await page
              .getByRole('region', { name: '查看的 Workflow 正文' })
              .locator('pre')
              .evaluate((node) => {
                const css = getComputedStyle(node);
                const luminance = (color: string) =>
                  color
                    .match(/[\d.]+/g)!
                    .slice(0, 3)
                    .map(Number)
                    .map((value) => value / 255)
                    .map((value) =>
                      value <= 0.04045
                        ? value / 12.92
                        : ((value + 0.055) / 1.055) ** 2.4,
                    )
                    .reduce(
                      (sum, value, index) =>
                        sum + value * [0.2126, 0.7152, 0.0722][index]!,
                      0,
                    );
                const fg = luminance(css.color),
                  bg = luminance(css.backgroundColor);
                return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
              });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
            await page
              .getByRole('button', { name: '查看这次读取的包', exact: true })
              .click();
            await page.getByText('准确正文 1.0.0', { exact: true }).waitFor();
            expect(state.contentRefs).toContain('exact-1.0.0');
            await page
              .getByRole('button', {
                name: '读取资源：references/template.md',
                exact: true,
              })
              .click();
            await page
              .getByRole('region', { name: '已核验的资源文件' })
              .waitFor();
            expect(
              await page
                .getByRole('region', { name: '已核验的资源文件' })
                .innerText(),
            ).toContain('固定资源 1.0.0');
            expect(
              await page.evaluate(() =>
                Reflect.get(window, 'workflowExecuted'),
              ),
            ).toBeUndefined();
            expect(state.ledgerReads).toBe(originalReads);
            expect(
              await page
                .getByRole('link', { name: '回到原工作记录', exact: true })
                .getAttribute('href'),
            ).toBe(`/chatflow?session=${id(31)}#message-${id(32)}`);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            await page.screenshot({
              path: resolve(
                screenshots,
                `reads-${width}-${dark ? 'dark' : 'light'}.png`,
              ),
              fullPage: true,
            });
          } finally {
            await page.close();
          }
        });
    it('clears a prior body after a revoked exact read while keeping safe audit metadata', async () => {
      const { page, state } = await open();
      try {
        await page
          .getByRole('button', { name: '查看当前包：本人周报', exact: true })
          .click();
        await page.getByText('准确正文 2.0.0', { exact: true }).waitFor();
        state.revoked = true;
        await page
          .getByRole('button', { name: '查看这次读取的包', exact: true })
          .click();
        await page.getByRole('alert').waitFor();
        expect(
          await page.getByRole('region', { name: '本人包与精确资源' }).count(),
        ).toBe(0);
        expect(
          await page.getByRole('region', { name: '准确读取回执' }).count(),
        ).toBe(1);
        expect(await page.locator('body').innerText()).not.toContain(
          'do-not-display',
        );
        await page
          .getByRole('button', { name: '重新读取目录', exact: true })
          .click();
        await page
          .getByText('当前没有可读取的本人 Workflow。', { exact: true })
          .waitFor();
      } finally {
        await page.close();
      }
    });
    it('drops another viewer/instance read state before rendering its new directory', async () => {
      const { page } = await open();
      try {
        await page
          .getByRole('button', { name: '查看这次读取的包', exact: true })
          .click();
        await page.getByText('准确正文 1.0.0', { exact: true }).waitFor();
        await page
          .getByRole('button', { name: '切换另一员工', exact: true })
          .click();
        expect(
          await page.getByRole('region', { name: '本人包与精确资源' }).count(),
        ).toBe(0);
        expect(
          await page.getByRole('region', { name: '准确读取回执' }).count(),
        ).toBe(0);
        await page
          .getByText('本人 Workflow · 目录与读取记录', { exact: true })
          .click();
        await page
          .getByText('还没有这位员工的工作记录。', { exact: true })
          .waitFor();
        expect(await page.locator('body').innerText()).not.toContain(
          '准确正文',
        );
      } finally {
        await page.close();
      }
    });
  },
);
