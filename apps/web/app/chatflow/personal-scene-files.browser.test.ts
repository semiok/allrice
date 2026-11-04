/** Real UI and HTTP wiring in Chrome; synthetic responses, no model or DB. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import type {
  PersonalSceneFile,
  PersonalSceneFilePreview,
  PersonalSceneSkill,
} from '@allrice/contracts';
import { sceneSkillFixture } from '../../../../packages/database/src/employees/employee-scene-skills.fixture.ts';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const instanceId = id(1),
  workspaceId = id(10),
  sceneId = id(20);
const references = [30, 40].map((number) => ({
  sourceKind: 'knowledge' as const,
  contentId: id(number),
  revisionId: id(number + 1),
  digest: `sha256:${(number === 30 ? 'a' : 'b').repeat(64)}`,
}));
function artifact(version = '2.0.0'): PersonalSceneFile {
  const payload = sceneSkillFixture(version);
  payload.skillPackage.resourceSources = [
    { path: 'assets/template.csv', references: [references[1]!] },
  ];
  return {
    schemaVersion: 1,
    scene: {
      id: sceneId,
      name: '我的周报',
      appliesWhen: '有来源的周报草稿',
      nativeName: `allrice-scene-${sceneId}`,
    },
    procedure: {
      kind: 'procedure',
      title: '周报文件方法',
      ...payload,
    },
    references,
    report: { scriptsExecuted: false, published: false },
  };
}
function preview(
  file: PersonalSceneFile,
  revision = 1,
): PersonalSceneFilePreview {
  const old = sceneSkillFixture('1.0.0'),
    { resources, ...bundle } = old.skillPackage.bundle;
  const current: PersonalSceneSkill = {
    sceneId,
    name: '原周报',
    description: '原说明',
    nativeName: `allrice-scene-${sceneId}`,
    contentRef: `old-ref-${revision}`,
    revision,
    content: old.body,
    contentChecksum: old.skillPackage.bundle.contentChecksum,
    bundleVersion: '1.0.0',
    bundleChecksum: old.skillPackage.bundle.checksum,
    resources: resources.map(({ path, mediaType, byteLength, checksum }) => ({
      path,
      mediaType,
      byteLength,
      checksum,
    })),
    sources: references.map((reference) => ({
      reference,
      title: '合成受控资料',
    })),
  };
  return {
    instanceId,
    instanceName: '我的周报助理',
    expectedRevision: revision,
    expectedContentRef: current.contentRef,
    file,
    current,
    currentScene: {
      id: sceneId,
      name: current.name,
      appliesWhen: current.description,
      references,
    },
    currentMetadata: {
      title: '原方法标题',
      bundle,
      resourceSources: [
        { path: 'assets/template.csv', references: [references[0]!] },
      ],
    },
  };
}
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

suite(
  'personal Workflow file preview, confirmation and truthful receipts',
  () => {
    let browser: Browser, server: Server, origin: string;
    const screenshotDir = resolve('.local/met227-c4-preview');
    beforeAll(async () => {
      const require = createRequire(import.meta.url);
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        entryPoints: ['apps/web/test/personal-scene-files-page.tsx'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        write: false,
        outdir: '/fixture',
        jsx: 'automatic',
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      const assets = new Map<string, Uint8Array>(
        built.outputFiles.map(
          (file: { path: string; contents: Uint8Array }) => [
            file.path.slice(file.path.lastIndexOf('/')),
            file.contents,
          ],
        ),
      );
      server = createServer((req, res) => {
        const path = new URL(req.url!, 'http://localhost').pathname,
          asset = assets.get(path);
        res.setHeader(
          'Content-Type',
          asset
            ? path.endsWith('.css')
              ? 'text/css'
              : 'text/javascript'
            : 'text/html',
        );
        res.end(
          asset ??
            '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/personal-scene-files-page.css"><div id="root"></div><script type="module" src="/personal-scene-files-page.js"></script>',
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
      await mkdir(screenshotDir, { recursive: true });
    }, 60000);
    afterAll(async () => {
      await browser?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 30000);
    async function open(width = 1280, dark = false, dialog = false) {
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
        console.error('Personal Workflow fixture pageerror:', error.message);
        rejectInitialization(error);
      });
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        initializationErrors.push(message.text());
        console.error(
          'Personal Workflow fixture consoleerror:',
          message.text(),
        );
      });
      await page.route('**/scene-skills/files?**', (route) =>
        route.fulfill(
          json({
            instanceId: route.request().url().includes(id(2))
              ? id(2)
              : instanceId,
            revision: 1,
            entries: [],
            nextBeforeRevision: null,
          }),
        ),
      );
      await page.route('**/scene-skills/files', async (route) => {
        const input = route.request().postDataJSON();
        await route.fulfill(json(preview(input.file)));
      });
      await page.route('**/employee-instances/*/content?**', async (route) => {
        const details = employeeDetailsFixture();
        details.profile.kind = 'custom';
        details.profile.name = '我的周报助理';
        details.profile.instanceId = route.request().url().includes(id(2))
          ? id(2)
          : instanceId;
        details.content.instanceId = details.profile.instanceId;
        await route.fulfill(json(details));
      });
      try {
        await Promise.race([
          (async () => {
            await page.goto(`${origin}${dialog ? '?dialog=1' : ''}`);
            if (dark)
              await page.evaluate(() =>
                document.body.setAttribute('data-ds-dark-theme', ''),
              );
            await page
              .getByText('本人 Workflow · 文件与修改记录', { exact: true })
              .click();
          })(),
          initializationFailed,
        ]);
      } catch (error) {
        await page.close();
        throw new Error(
          `Workflow fixture initialization failed: ${initializationErrors.join(' | ') || 'no page/console error'}`,
          { cause: error },
        );
      }
      return page;
    }
    async function upload(page: Page, file = artifact()) {
      await page
        .getByLabel('导入 Workflow 文件', { exact: true })
        .setInputFiles({
          name: 'weekly-brief.c1.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(file)),
        });
      await page.getByRole('region', { name: '文件与当前内容差异' }).waitFor();
    }
    function saved(file: PersonalSceneFile, input: { requestId: string }) {
      if (!('skillPackage' in file.procedure))
        throw Error('fixture package required');
      return {
        receipt: {
          instanceId,
          sceneId,
          revision: 2,
          contentRef: `saved-${input.requestId}`,
          contentChecksum: file.procedure.skillPackage.bundle.contentChecksum,
          bundleChecksum: file.procedure.skillPackage.bundle.checksum,
        },
      };
    }
    for (const width of [1280, 390])
      for (const dark of [false, true]) {
        it(`requires a reviewed diff, replays the same uncertain request and shows the real receipt at ${width}px ${dark ? 'dark' : 'light'}`, async () => {
          const page = await open(width, dark);
          const writes: Record<string, unknown>[] = [];
          const file = artifact();
          await page.route('**/scene-skills', async (route) => {
            const input = route.request().postDataJSON();
            writes.push(input);
            if (writes.length === 1) await route.abort('failed');
            else await route.fulfill(json(saved(file, input)));
          });
          try {
            await upload(page, file);
            expect(writes).toHaveLength(0);
            expect(
              await page
                .getByRole('region', { name: '当前正文', exact: true })
                .innerText(),
            ).toContain('1.0.0');
            expect(
              await page
                .getByRole('region', { name: '文件正文', exact: true })
                .innerText(),
            ).toContain('2.0.0');
            await page
              .getByText('包元数据与资源来源映射差异', { exact: true })
              .click();
            expect(
              await page
                .getByText('文件元数据', { exact: true })
                .locator('..')
                .innerText(),
            ).toContain('resourceSources');
            expect(
              await page
                .getByText('文件元数据', { exact: true })
                .locator('..')
                .innerText(),
            ).toContain('fixture-only');
            const oldMetadata = await page
              .getByText('当前元数据', { exact: true })
              .locator('..')
              .innerText();
            const nextMetadata = await page
              .getByText('文件元数据', { exact: true })
              .locator('..')
              .innerText();
            expect(oldMetadata).toContain(references[0]!.revisionId);
            expect(oldMetadata).not.toContain(references[1]!.revisionId);
            expect(nextMetadata).toContain(references[1]!.revisionId);
            expect(nextMetadata).not.toContain(references[0]!.revisionId);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            const typography = await page
              .getByRole('region', { name: '文件正文' })
              .locator('pre')
              .evaluate((node) => ({
                font: Number.parseFloat(getComputedStyle(node).fontSize),
                line: Number.parseFloat(getComputedStyle(node).lineHeight),
              }));
            expect(typography.font).toBe(13);
            expect(typography.line).toBe(20);
            const contrast = await page
              .getByRole('region', { name: '文件正文' })
              .locator('pre')
              .evaluate((node) => {
                const css = getComputedStyle(node);
                const luminance = (color: string) =>
                  color
                    .match(/[\d.]+/g)!
                    .slice(0, 3)
                    .map(Number)
                    .map((n) => n / 255)
                    .map((n) =>
                      n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4,
                    )
                    .reduce(
                      (v, n, i) => v + n * [0.2126, 0.7152, 0.0722][i]!,
                      0,
                    );
                const fg = luminance(css.color),
                  bg = luminance(css.backgroundColor);
                return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
              });
            expect(contrast).toBeGreaterThanOrEqual(4.5);
            await page.screenshot({
              path: resolve(
                screenshotDir,
                `preview-${width}-${dark ? 'dark' : 'light'}.png`,
              ),
              fullPage: true,
            });
            await page
              .getByLabel('本次修改说明', { exact: true })
              .fill('根据实际结果调整输出要求');
            await page
              .getByRole('button', { name: '确认修改并生效', exact: true })
              .click();
            await page
              .getByRole('button', { name: '重试同一次保存', exact: true })
              .waitFor();
            expect(
              await page.getByText('已保存并生效', { exact: false }).count(),
            ).toBe(0);
            expect(
              await page
                .getByLabel('本次修改说明', { exact: true })
                .isDisabled(),
            ).toBe(true);
            await page
              .getByRole('button', { name: '重试同一次保存', exact: true })
              .click();
            await page
              .getByText('已保存并生效 · 修订 2', { exact: true })
              .waitFor();
            expect(writes).toHaveLength(2);
            expect(writes[1]).toEqual(writes[0]);
            expect(writes[0]).toMatchObject({
              workspaceId,
              expectedRevision: 1,
              expectedContentRef: 'old-ref-1',
              changeSummary: '根据实际结果调整输出要求',
            });
            expect(Object.keys(writes[0]!).sort()).toEqual(
              [
                'workspaceId',
                'requestId',
                'expectedRevision',
                'expectedContentRef',
                'scene',
                'procedure',
                'references',
                'changeSummary',
              ].sort(),
            );
            await page.getByText('查看准确回执', { exact: true }).click();
            expect(
              await page
                .getByText(`请求：${writes[0]!.requestId}`, { exact: true })
                .count(),
            ).toBe(1);
            await page.screenshot({
              path: resolve(
                screenshotDir,
                `receipt-${width}-${dark ? 'dark' : 'light'}.png`,
              ),
              fullPage: true,
            });
          } finally {
            await page.close();
          }
        });
      }
    it('rejects malformed files and stops on conflict until the user rereads the target', async () => {
      const page = await open();
      let writes = 0;
      await page.route('**/scene-skills', async (route) => {
        writes++;
        await route.fulfill(
          json(
            {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'secret raw server detail',
              },
            },
            409,
          ),
        );
      });
      try {
        await page
          .getByLabel('导入 Workflow 文件', { exact: true })
          .setInputFiles({
            name: 'invalid.json',
            mimeType: 'application/json',
            buffer: Buffer.from('{}'),
          });
        await page.getByRole('alert').waitFor();
        expect(writes).toBe(0);
        await upload(page);
        await page
          .getByRole('button', { name: '确认修改并生效', exact: true })
          .click();
        await page
          .getByRole('button', { name: '重新预览当前目标', exact: true })
          .waitFor();
        expect(writes).toBe(1);
        expect(
          await page
            .getByRole('button', { name: '确认修改并生效', exact: true })
            .count(),
        ).toBe(0);
        expect(await page.locator('body').innerText()).not.toContain(
          'secret raw server detail',
        );
        await page
          .getByRole('button', { name: '重新预览当前目标', exact: true })
          .click();
        await page
          .getByRole('region', { name: '文件与当前内容差异' })
          .waitFor();
        expect(writes).toBe(1);
      } finally {
        await page.close();
      }
    });
    it('drops the previous viewer and instance preview before displaying the other instance', async () => {
      const page = await open();
      try {
        await upload(page);
        await page
          .getByRole('button', { name: '切换另一员工', exact: true })
          .click();
        expect(
          await page
            .getByRole('region', { name: '文件与当前内容差异' })
            .count(),
        ).toBe(0);
        expect(
          await page
            .getByRole('button', { name: '确认修改并生效', exact: true })
            .count(),
        ).toBe(0);
        await page
          .getByText('本人 Workflow · 文件与修改记录', { exact: true })
          .click();
        await page
          .getByText('还没有保存过 Workflow 文件。', { exact: true })
          .waitFor();
        expect(await page.locator('body').innerText()).not.toContain(
          'Synthetic scene',
        );
      } finally {
        await page.close();
      }
    });

    it('recovers the same committed request after the real employee dialog closes and reopens, isolated from another viewer', async () => {
      const page = await open(1280, false, true);
      const writes: Record<string, unknown>[] = [],
        committed = new Map<string, unknown>();
      const file = artifact();
      await page.route('**/scene-skills', async (route) => {
        const input = route.request().postDataJSON();
        writes.push(input);
        if (!committed.has(input.requestId))
          committed.set(input.requestId, saved(file, input));
        if (writes.length === 1) await route.abort('failed');
        else await route.fulfill(json(committed.get(input.requestId)));
      });
      const reopen = async () => {
        await page
          .getByRole('button', { name: '打开员工详情', exact: true })
          .click();
        await page
          .getByText('本人 Workflow · 文件与修改记录', { exact: true })
          .click();
      };
      try {
        await upload(page, file);
        await page
          .getByRole('button', { name: '确认修改并生效', exact: true })
          .click();
        await page
          .getByRole('button', { name: '重试同一次保存', exact: true })
          .waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page
          .getByRole('button', { name: '切换查看者', exact: true })
          .click();
        await reopen();
        expect(
          await page
            .getByRole('region', { name: '待核对的原保存请求' })
            .count(),
        ).toBe(0);
        expect(
          await page
            .getByRole('button', { name: '重试同一次保存', exact: true })
            .count(),
        ).toBe(0);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page
          .getByRole('button', { name: '切换查看者', exact: true })
          .click();
        await reopen();
        await page
          .getByRole('region', { name: '待核对的原保存请求' })
          .waitFor();
        expect(
          await page
            .getByRole('region', { name: '当前正文', exact: true })
            .count(),
        ).toBe(0);
        await page
          .getByRole('button', { name: '重试同一次保存', exact: true })
          .click();
        await page
          .getByText('已保存并生效 · 修订 2', { exact: true })
          .waitFor();
        expect(writes).toHaveLength(2);
        expect(writes[1]).toEqual(writes[0]);
        expect(committed.size).toBe(1);
      } finally {
        await page.close();
      }
    });

    it('keeps a verified late save receipt when its original dialog reader has unmounted', async () => {
      const page = await open(1280, false, true);
      let release!: () => void, started!: () => void;
      const waiting = new Promise<void>((done) => {
        release = done;
      });
      const called = new Promise<void>((done) => {
        started = done;
      });
      let writes = 0;
      await page.route('**/scene-skills', async (route) => {
        writes++;
        const input = route.request().postDataJSON();
        started();
        await waiting;
        await route.fulfill(json(saved(artifact(), input)));
      });
      try {
        await upload(page);
        await page
          .getByRole('button', { name: '确认修改并生效', exact: true })
          .click();
        await called;
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        const response = page.waitForResponse((value) =>
          value.url().endsWith('/scene-skills'),
        );
        release();
        await (await response).finished();
        await page.evaluate(
          () =>
            new Promise<void>((done) => requestAnimationFrame(() => done())),
        );
        await page
          .getByRole('button', { name: '打开员工详情', exact: true })
          .click();
        await page
          .getByText('本人 Workflow · 文件与修改记录', { exact: true })
          .click();
        await page
          .getByText('已保存并生效 · 修订 2', { exact: true })
          .waitFor();
        expect(writes).toBe(1);
      } finally {
        release();
        await page.close();
      }
    });
  },
);
