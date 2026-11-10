import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PersonalSkillConfirmRequestSchema,
  PersonalSkillPreviewRequestSchema,
  PersonalSkillRemoveRequestSchema,
  skillSourceErrorHeader,
  type EmployeeSkillCatalog,
  type PersonalSkillConfirmResponse,
  type PersonalSkillPreviewResponse,
} from '@allrice/contracts';
import type {
  Browser,
  Locator,
  Page,
  Route,
} from '../../../worker/node_modules/playwright-core/index.js';
import {
  skillTestCatalog,
  skillTestCatalogAfter,
  skillTestConfirmed,
  skillTestId,
  skillTestPreview,
  skillTestProblem,
  skillTestRemoved,
  skillTestScope,
} from '../../test/employee-skills-host-data';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const unknownCopy = '暂时无法确认操作结果，操作可能已完成。请重试。';
const unresolvedCopy = '暂时无法确认操作结果，操作可能已完成。';
const accessCopy = '暂时无法访问这个员工的技能，请返回后重新打开。';
const apiBase = `/api/v1/employee-instances/${skillTestId(7)}/skills`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Scenario =
  | 'normal'
  | 'catalog-error'
  | 'late-catalog'
  | 'unknown-conflict'
  | 'unknown-receipt'
  | 'unknown-access'
  | 'remove-unknown'
  | 'unchanged'
  | 'post-confirm-read'
  | 'blank-metadata';
type RequestRecord = { path: string; method: string; body?: unknown };

suite('U1 scoped employee Skill HTTP host candidate', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-skills-host');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-skills-host-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/skills-host-fixture',
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
      const path = new URL(request.url!, 'http://localhost').pathname,
        asset = assets.get(path);
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
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-skills-host-page.css"></head><body><div id="root"></div><script type="module" src="/employee-skills-host-page.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No Skill fixture port');
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

  async function fixture(
    options: {
      width?: number;
      theme?: 'light' | 'dark';
      scenario?: Scenario;
      empty?: boolean;
      shared?: boolean;
      holdConfirm?: boolean;
      height?: number;
      longName?: boolean;
    } = {},
  ) {
    const { width = 1440, theme = 'light', scenario = 'normal' } = options;
    const context = await browser.newContext({
      viewport: {
        width,
        height: options.height ?? (width === 390 ? 844 : 1000),
      },
      isMobile: width === 390,
      hasTouch: width === 390,
      colorScheme: theme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const requests: RequestRecord[] = [],
      unexpected: string[] = [],
      errors: string[] = [];
    const catalogs = new Map<string, EmployeeSkillCatalog>(
      [skillTestId(7), skillTestId(8)].map((id) => {
        const catalog = skillTestCatalog(id);
        if (options.empty) catalog.personalSkills = [];
        if (options.longName && catalog.personalSkills[0])
          catalog.personalSkills[0].displayName = '翻译校对'.repeat(8);
        return [id, catalog];
      }),
    );
    const late = deferred(),
      lateSent = deferred(),
      confirmRelease = deferred(),
      confirmSent = deferred(),
      postReadRequested = deferred(),
      postReadRelease = deferred(),
      postReadSent = deferred();
    let reads = 0,
      confirms = 0,
      removals = 0,
      postWriteReads = 0,
      latest: PersonalSkillPreviewResponse | null = null,
      original: PersonalSkillConfirmResponse | null = null;
    page.on('pageerror', (error) => errors.push(error.message));
    const json = (
      route: Route,
      value: unknown,
      status = 200,
      reason?: string,
    ) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(value),
        headers: reason ? { [skillSourceErrorHeader]: reason } : undefined,
      });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        match = url.pathname.match(
          /^\/api\/v1\/employee-instances\/([^/]+)\/skills(?:\/(preview|confirm|[^/]+))?$/,
        );
      if (!match) {
        unexpected.push(request.method() + ' ' + url.pathname);
        await route.abort();
        return;
      }
      const instanceId = match[1],
        suffix = match[2];
      if (!instanceId || !catalogs.has(instanceId)) {
        unexpected.push('unknown scope ' + url.pathname);
        await route.abort();
        return;
      }
      const record: RequestRecord = {
        path: url.pathname + url.search,
        method: request.method(),
      };
      requests.push(record);
      if (!suffix && request.method() === 'GET') {
        expect(url.searchParams.get('workspaceId')).toBe(
          skillTestScope.workspaceId,
        );
        reads += 1;
        if (
          scenario === 'post-confirm-read' &&
          confirms > 0 &&
          ++postWriteReads === 1
        ) {
          postReadRequested.resolve();
          await postReadRelease.promise;
          try {
            await json(route, skillTestProblem(), 503);
          } finally {
            postReadSent.resolve();
          }
          return;
        }

        if (scenario === 'catalog-error' && reads === 1) {
          await json(route, skillTestProblem(), 503);
          return;
        }
        if (
          scenario === 'late-catalog' &&
          instanceId === skillTestId(7) &&
          reads === 1
        ) {
          await late.promise;
          try {
            await json(route, catalogs.get(instanceId));
          } finally {
            lateSent.resolve();
          }
          return;
        }
        await json(route, catalogs.get(instanceId));
        return;
      }
      if (suffix === 'preview' && request.method() === 'POST') {
        let input;
        if (
          request.headers()['content-type']?.includes('multipart/form-data')
        ) {
          const bytes = request.postDataBuffer();
          if (!bytes) throw new Error('Missing multipart bytes');
          const form = await new Response(new Blob([Uint8Array.from(bytes)]), {
            headers: { 'content-type': request.headers()['content-type']! },
          }).formData();
          expect([...form.keys()]).toEqual(['input', 'file']);
          const file = form.get('file');
          if (!(file instanceof File))
            throw new Error('Expected actual uploaded ZIP File');
          expect(await file.text()).toBe('abcde');
          input = PersonalSkillPreviewRequestSchema.parse({
            ...JSON.parse(String(form.get('input'))),
            source: { kind: 'zip', fileName: file.name },
          });
          record.body = {
            ...input,
            uploadedBytes: file.size,
            uploadedName: file.name,
          };
          latest = skillTestPreview({
            instanceId,
            target: input.target,
            source: { kind: 'zip', fileName: file.name, byteLength: file.size },
          });
        } else {
          input = PersonalSkillPreviewRequestSchema.parse(
            request.postDataJSON(),
          );
          record.body = input;
          if (input.source.kind !== 'github')
            throw new Error('Expected GitHub JSON source');
          latest = skillTestPreview({
            instanceId,
            target: input.target,
            source: input.source,
          });
        }
        expect(input.workspaceId).toBe(skillTestScope.workspaceId);
        if (scenario === 'blank-metadata') {
          latest.item.displayName = '  ';
          latest.item.version = '\t  ';
        }
        await json(route, latest);
        return;
      }
      if (suffix === 'confirm' && request.method() === 'POST') {
        const input = PersonalSkillConfirmRequestSchema.parse(
          request.postDataJSON(),
        );
        record.body = input;
        if (!latest) throw new Error('No explicit preview before confirmation');
        expect(input.workspaceId).toBe(skillTestScope.workspaceId);
        expect(input.previewId).toBe(latest.previewId);
        expect(input.digest).toBe(latest.digest);
        confirms += 1;
        if (options.holdConfirm) await confirmRelease.promise;
        try {
          if (
            ['unknown-conflict', 'unknown-receipt', 'unknown-access'].includes(
              scenario,
            ) &&
            confirms === 1
          ) {
            if (scenario === 'unknown-receipt') {
              original = skillTestConfirmed(latest, input.requestId);
              catalogs.set(instanceId, skillTestCatalogAfter(original));
            }
            await route.abort('failed');
            return;
          }
          if (scenario === 'unknown-conflict' && confirms >= 2) {
            await json(
              route,
              skillTestProblem('VALIDATION_FAILED'),
              422,
              'preview_expired',
            );
            return;
          }
          if (scenario === 'unknown-access' && confirms >= 2) {
            await json(route, skillTestProblem('AUTHORIZATION_DENIED'), 403);
            return;
          }
          const result =
            original ??
            skillTestConfirmed(
              latest,
              input.requestId,
              scenario === 'unchanged',
            );
          if (scenario !== 'unchanged')
            catalogs.set(
              instanceId,
              skillTestCatalogAfter(
                result,
                latest.item.version ?? null,
                latest.item.displayName ?? null,
              ),
            );
          await json(route, result);
        } finally {
          confirmSent.resolve();
        }
        return;
      }
      if (suffix === skillTestId(200) && request.method() === 'DELETE') {
        const input = PersonalSkillRemoveRequestSchema.parse(
          request.postDataJSON(),
        );
        record.body = input;
        expect(input.workspaceId).toBe(skillTestScope.workspaceId);
        expect(input.expectedRevision).toBe(4);
        removals += 1;
        if (scenario === 'remove-unknown') {
          if (removals === 1) {
            await route.abort('failed');
            return;
          }
          await json(route, skillTestProblem('VERSION_CONFLICT'), 409);
          return;
        }
        const catalog = catalogs.get(instanceId);
        if (!catalog) throw new Error('Missing selected catalog');
        catalogs.set(instanceId, { ...catalog, personalSkills: [] });
        await json(route, skillTestRemoved(input.requestId, instanceId));
        return;
      }
      unexpected.push(request.method() + ' ' + url.pathname);
      await route.abort();
    });
    await page.goto(
      `${origin}/chatflow?theme=${theme}${options.shared ? '&shared=1' : ''}`,
    );
    await page
      .getByRole('heading', { name: 'AI 员工详情', exact: true })
      .waitFor();
    return {
      page,
      requests,
      catalogs,
      late,
      lateSent,
      confirmRelease,
      confirmSent,
      postReadRequested,
      postReadRelease,
      postReadSent,
      async close() {
        late.resolve();
        confirmRelease.resolve();
        postReadRelease.resolve();
        await context.close();
        expect(errors).toEqual([]);
        expect(unexpected).toEqual([]);
      },
    };
  }

  async function withFixture(
    options: Parameters<typeof fixture>[0],
    run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ) {
    const f = await fixture(options);
    let primary: unknown;
    let primaryFailed = false;
    try {
      await run(f);
    } catch (error) {
      primary = error;
      primaryFailed = true;
    }
    try {
      await f.close();
    } catch (cleanup) {
      if (!primaryFailed) throw cleanup;
      console.error('Skill fixture cleanup after primary error:', cleanup);
    }
    if (primaryFailed) throw primary;
  }

  const dialog = (page: Page) => page.getByRole('dialog');
  async function ready(page: Page) {
    await page.getByText('我添加的 · 1', { exact: true }).waitFor();
  }
  async function selectGitHubSource(page: Page) {
    expect(
      await dialog(page)
        .getByRole('tab', { name: '压缩包', exact: true })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      await dialog(page).getByLabel('仓库链接', { exact: true }).count(),
    ).toBe(0);
    await dialog(page)
      .getByRole('tab', { name: 'GitHub 链接', exact: true })
      .click();
    expect(
      await dialog(page)
        .getByRole('tab', { name: 'GitHub 链接', exact: true })
        .getAttribute('aria-selected'),
    ).toBe('true');
    await expect
      .poll(() =>
        dialog(page).evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
  }
  async function openUpdate(page: Page) {
    await ready(page);
    await page.getByRole('button', { name: '翻译校对', exact: true }).click();
    await dialog(page)
      .getByRole('button', { name: '更新', exact: true })
      .click();
    await dialog(page)
      .getByRole('heading', { name: '更新“翻译校对”', exact: true })
      .waitFor();
    await selectGitHubSource(page);
    await dialog(page)
      .getByLabel('仓库链接', { exact: true })
      .fill('https://github.com/example/translation-review');
  }
  async function readUpdate(page: Page) {
    await openUpdate(page);
    await dialog(page)
      .getByRole('button', { name: '读取', exact: true })
      .click();
    await dialog(page)
      .getByRole('heading', { name: '确认更新', exact: true })
      .waitFor();
  }
  const writes = (records: RequestRecord[]) =>
    records.filter(
      (record) =>
        record.method === 'DELETE' || record.path.endsWith('/confirm'),
    );
  async function saveRecords(name: string, records: unknown) {
    await writeFile(
      resolve(evidence, `${name}.json`),
      JSON.stringify(records, null, 2),
    );
  }

  async function paint(modal: Locator) {
    let previous = '',
      stable = 0;
    const sample = () =>
      modal.evaluate((node) => {
        if (!(node instanceof HTMLElement) || !node.parentElement)
          throw new Error('Native Modal card/root missing');
        const card = node;
        const root = node.parentElement;
        const box = card.getBoundingClientRect(),
          heading = card.querySelector('h2'),
          rootBox = root.getBoundingClientRect();
        const ancestors = [];
        for (
          let element: Element | null = card;
          element;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          ancestors.push({
            opacity: style.opacity,
            visibility: style.visibility,
            display: style.display,
          });
        }
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return {
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          root: {
            x: rootBox.x,
            y: rootBox.y,
            width: root.clientWidth,
            height: root.clientHeight,
          },
          background: getComputedStyle(card).backgroundColor,
          text: heading ? getComputedStyle(heading).color : null,
          font: heading
            ? {
                size: getComputedStyle(heading).fontSize,
                height: getComputedStyle(heading).lineHeight,
                weight: getComputedStyle(heading).fontWeight,
                family: getComputedStyle(heading).fontFamily,
              }
            : null,
          ancestors,
          running: node
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.playState === 'running' || animation.pending,
            ).length,
          hitInside: !!hit && card.contains(hit),
          overflow: card.scrollWidth > card.clientWidth,
        };
      });
    await expect
      .poll(
        async () => {
          const current = await sample(),
            geometry = JSON.stringify(current.box);
          stable = geometry === previous ? stable + 1 : 0;
          previous = geometry;
          return {
            opaque: current.ancestors.every(
              (ancestor) =>
                Number(ancestor.opacity) === 1 &&
                ancestor.visibility === 'visible' &&
                ancestor.display !== 'none',
            ),
            settled: current.running === 0,
            stable: stable >= 2,
            hit: current.hitInside,
          };
        },
        { timeout: 5000, interval: 20 },
      )
      .toEqual({ opaque: true, settled: true, stable: true, hit: true });
    return sample();
  }

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const) {
      it(`shows true-source preview and complete affected scope at ${width}px ${theme}`, async () => {
        await withFixture({ width, theme }, async ({ page, requests }) => {
          await readUpdate(page);
          const modal = dialog(page);
          expect(writes(requests)).toEqual([]);
          expect(
            await modal.getByText('将影响的员工 · 3', { exact: true }).count(),
          ).toBe(1);
          expect(await modal.getByText('流程哥', { exact: true }).count()).toBe(
            2,
          );
          expect(
            await modal.getByText('工作区二', { exact: true }).count(),
          ).toBe(1);
          expect(await modal.getByText('已停用', { exact: true }).count()).toBe(
            1,
          );
          expect(await modal.getByText('v0.3.0', { exact: true }).count()).toBe(
            1,
          );
          expect(
            await modal.getByText('release-candidate', { exact: true }).count(),
          ).toBe(1);
          expect(
            await modal
              .getByRole('button', { name: '关闭', exact: true })
              .count(),
          ).toBe(0);
          const actual = await paint(modal);
          expect(actual.box.width).toBe(
            width === 390 ? actual.root.width : 552,
          );
          expect(actual.box.x).toBeCloseTo(
            width === 390
              ? actual.root.x
              : actual.root.x + (actual.root.width - 552) / 2,
            2,
          );
          if (width === 390) {
            expect(actual.box.y).toBe(0);
            expect(actual.box.height).toBe(actual.root.height);
          }
          expect(actual.overflow).toBe(false);
          expect(actual.background).toBe(
            theme === 'dark' ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)',
          );
          expect(actual.text).toBe(
            theme === 'dark' ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
          );
          expect(actual.font).toMatchObject({
            size: '20px',
            height: '28px',
            weight: '600',
          });
          expect(actual.font?.family).toMatch(/sans-serif/i);
          await page.screenshot({
            path: resolve(evidence, `scope-${width}-${theme}.png`),
          });
          await saveRecords(`scope-${width}-${theme}-paint`, actual);
          await modal
            .getByRole('button', { name: '取消', exact: true })
            .click();
          expect(
            await dialog(page)
              .getByLabel('仓库链接', { exact: true })
              .inputValue(),
          ).toBe('https://github.com/example/translation-review');
          await dialog(page)
            .getByRole('button', { name: '读取', exact: true })
            .click();
          await dialog(page)
            .getByRole('button', { name: '确认更新', exact: true })
            .click();
          await dialog(page)
            .getByText('已更新“翻译校对”', { exact: true })
            .waitFor();
          expect(writes(requests)).toHaveLength(1);
          await dialog(page)
            .locator('footer')
            .getByRole('button', { name: '返回技能详情', exact: true })
            .click();
          await dialog(page)
            .getByRole('heading', { name: '翻译校对', exact: true })
            .waitFor();
          expect(
            await dialog(page)
              .getByText('release-candidate', { exact: true })
              .count(),
          ).toBe(1);
          await saveRecords(`scope-${width}-${theme}-requests`, requests);
        });
      });
    }

  it('retains a real selected ZIP across inner cancel and does not write before explicit confirmation', async () => {
    await withFixture({ empty: true, holdConfirm: true }, async (f) => {
      await f.page.getByText('我添加的 · 0', { exact: true }).waitFor();
      await f.page
        .getByRole('button', { name: '添加技能', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('tab', { name: '压缩包', exact: true })
        .click();
      await dialog(f.page)
        .getByLabel('选择 ZIP 文件')
        .setInputFiles({
          name: 'translation-review.zip',
          mimeType: 'application/zip',
          buffer: Buffer.from('abcde'),
        });
      expect(
        f.requests.filter((request) => request.path.endsWith('/preview')),
      ).toEqual([]);
      await dialog(f.page)
        .getByRole('button', { name: '读取', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('heading', { name: '确认添加', exact: true })
        .waitFor();
      expect(writes(f.requests)).toEqual([]);
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await dialog(f.page)
        .getByText('translation-review.zip', { exact: true })
        .waitFor();
      await dialog(f.page)
        .getByRole('button', { name: '读取', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('button', { name: '确认添加', exact: true })
        .click();
      await expect.poll(() => writes(f.requests).length).toBe(1);
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '取消', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '返回来源填写', exact: true })
          .isDisabled(),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(
        await dialog(f.page)
          .getByRole('heading', { name: '确认添加', exact: true })
          .count(),
      ).toBe(1);
      f.confirmRelease.resolve();
      await f.confirmSent.promise;
      await dialog(f.page)
        .getByText('已添加“翻译校对”', { exact: true })
        .waitFor();
      await dialog(f.page)
        .getByRole('button', { name: '完成', exact: true })
        .click();
      await ready(f.page);
      await f.page
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      await dialog(f.page)
        .getByText('translation-review.zip', { exact: true })
        .waitFor();
      await saveRecords('zip-confirm-requests', f.requests);
    });
  });

  it('shows a catalog read failure without fake zero and explicitly recovers the same employee', async () => {
    await withFixture(
      { scenario: 'catalog-error' },
      async ({ page, requests }) => {
        await page
          .getByText('技能读取失败，请重试。', { exact: true })
          .waitFor();
        expect(
          await page.getByText('我添加的 · 0', { exact: true }).count(),
        ).toBe(0);
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await ready(page);
        expect(requests.map((request) => request.path)).toEqual([
          `${apiBase}?workspaceId=${skillTestScope.workspaceId}`,
          `${apiBase}?workspaceId=${skillTestScope.workspaceId}`,
        ]);
      },
    );
  });

  it('does not read private Skills in shared view and ignores a late previous-employee catalog', async () => {
    await withFixture({ shared: true, scenario: 'late-catalog' }, async (f) => {
      expect(f.requests).toEqual([]);
      await f.page.getByLabel('夹具本人视图').check();
      await expect.poll(() => f.requests.length).toBe(1);
      await f.page.getByLabel('夹具员工').selectOption(skillTestId(8));
      await ready(f.page);
      f.late.resolve();
      await f.lateSent.promise;
      expect(
        await f.page
          .locator('article')
          .getByText('流程哥', { exact: true })
          .count(),
      ).toBe(1);
      await f.page
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('button', { name: '更新', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('tab', { name: 'GitHub 链接', exact: true })
        .click();
      await dialog(f.page)
        .getByLabel('仓库链接', { exact: true })
        .fill('https://github.com/example/translation-review');
      await dialog(f.page)
        .getByRole('button', { name: '读取', exact: true })
        .click();
      await dialog(f.page)
        .getByText('将影响的员工 · 3', { exact: true })
        .waitFor();
      expect(
        f.requests
          .filter((request) => request.path.endsWith('/preview'))
          .every((request) => request.path.includes(skillTestId(8))),
      ).toBe(true);
    });
  });

  it('blocks an unknown original request after server-confirmed preview expiry across same-scope reopen', async () => {
    await withFixture({ scenario: 'unknown-conflict' }, async (f) => {
      await readUpdate(f.page);
      await dialog(f.page)
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      await dialog(f.page).getByText(unknownCopy, { exact: true }).waitFor();
      await f.page.evaluate(() => {
        const now = Date.now();
        Date.now = () => now + 600_000;
      });
      await dialog(f.page)
        .getByRole('button', { name: '重试', exact: true })
        .click();
      await expect.poll(() => writes(f.requests).length).toBe(2);
      await dialog(f.page).getByText(unresolvedCopy, { exact: true }).waitFor();
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '重试', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '重新读取', exact: true })
          .count(),
      ).toBe(0);
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await ready(f.page);
      await f.page
        .getByRole('button', { name: '翻译校对', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('button', { name: '更新', exact: true })
        .click();
      await dialog(f.page).getByText(unresolvedCopy, { exact: true }).waitFor();
      expect(writes(f.requests)).toHaveLength(2);
      expect(
        f.requests.filter((request) => request.path.endsWith('/preview')),
      ).toHaveLength(1);
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await ready(f.page);
      await f.page
        .getByRole('button', { name: '关闭夹具详情', exact: true })
        .click();
      await f.page
        .getByRole('button', { name: '重新打开夹具详情', exact: true })
        .click();
      await dialog(f.page).getByText(unresolvedCopy, { exact: true }).waitFor();
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '重试', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog(f.page)
          .getByRole('button', { name: '重新读取', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog(f.page).getByLabel('仓库链接', { exact: true }).count(),
      ).toBe(0);
      expect(writes(f.requests)).toHaveLength(2);
      const payloads = writes(f.requests).map((request) => request.body);
      expect(payloads[1]).toEqual(payloads[0]);
      expect(
        f.requests.filter((request) => request.path.endsWith('/preview')),
      ).toHaveLength(1);
      expect(
        await dialog(f.page)
          .getByText('已更新“翻译校对”', { exact: true })
          .count(),
      ).toBe(0);
      await saveRecords('unknown-conflict-reopen', f.requests);
    });
  });

  it('accepts only the original matching replay receipt and keeps unchanged distinct', async () => {
    await withFixture({ scenario: 'unknown-receipt' }, async (f) => {
      await readUpdate(f.page);
      await dialog(f.page)
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      await dialog(f.page).getByText(unknownCopy, { exact: true }).waitFor();
      await dialog(f.page)
        .getByRole('button', { name: '重试', exact: true })
        .click();
      await dialog(f.page)
        .getByText('已更新“翻译校对”', { exact: true })
        .waitFor();
      expect(writes(f.requests)[1]?.body).toEqual(writes(f.requests)[0]?.body);
      expect(
        await dialog(f.page)
          .getByText('和当前内容完全一样，不用更新。', { exact: true })
          .count(),
      ).toBe(0);
    });
    await withFixture({ scenario: 'unchanged' }, async (f) => {
      await readUpdate(f.page);
      await dialog(f.page)
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      await dialog(f.page)
        .getByText('和当前内容完全一样，不用更新。', { exact: true })
        .waitFor();
      expect(
        await dialog(f.page)
          .getByText('已更新“翻译校对”', { exact: true })
          .count(),
      ).toBe(0);
    });
  });

  it('keeps a current-binding removal uncommitted in the UI after an unknown and a later conflict', async () => {
    await withFixture({ scenario: 'remove-unknown' }, async (f) => {
      await ready(f.page);
      await f.page.getByRole('button', { name: '卸载', exact: true }).click();
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      expect(writes(f.requests)).toEqual([]);
      await f.page.getByRole('button', { name: '卸载', exact: true }).click();
      await dialog(f.page)
        .getByRole('button', { name: '卸载', exact: true })
        .click();
      await dialog(f.page).getByText(unknownCopy, { exact: true }).waitFor();
      await dialog(f.page)
        .getByRole('button', { name: '重试', exact: true })
        .click();
      await expect.poll(() => writes(f.requests).length).toBe(2);
      expect(writes(f.requests)[1]?.body).toEqual(writes(f.requests)[0]?.body);
      await dialog(f.page).getByText(unknownCopy, { exact: true }).waitFor();
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await ready(f.page);
      expect(
        await f.page
          .getByRole('button', { name: '翻译校对', exact: true })
          .count(),
      ).toBe(1);
      expect(
        f.catalogs.get(skillTestId(8))?.personalSkills[0]?.binding.enabled,
      ).toBe(true);
      expect(await f.page.getByLabel('夹具回执提示').count()).toBe(0);
    });
  });

  it('clears private preview File and source on access loss without clearing the uncertain identity', async () => {
    await withFixture(
      { empty: true, scenario: 'unknown-access' },
      async (f) => {
        await f.page.getByText('我添加的 · 0', { exact: true }).waitFor();
        await f.page
          .getByRole('button', { name: '添加技能', exact: true })
          .click();
        await dialog(f.page)
          .getByRole('tab', { name: '压缩包', exact: true })
          .click();
        await dialog(f.page)
          .getByLabel('选择 ZIP 文件')
          .setInputFiles({
            name: 'private-name.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from('abcde'),
          });
        await dialog(f.page)
          .getByRole('button', { name: '读取', exact: true })
          .click();
        await dialog(f.page)
          .getByRole('button', { name: '确认添加', exact: true })
          .click();
        await dialog(f.page).getByText(unknownCopy, { exact: true }).waitFor();
        await dialog(f.page)
          .getByRole('button', { name: '重试', exact: true })
          .click();
        await f.page.getByText(accessCopy, { exact: true }).waitFor();
        expect(
          await f.page.getByText('private-name.zip', { exact: true }).count(),
        ).toBe(0);
        expect(await f.page.getByRole('dialog').count()).toBe(0);
        await f.page
          .getByRole('button', { name: '关闭夹具详情', exact: true })
          .click();
        await f.page
          .getByRole('button', { name: '重新打开夹具详情', exact: true })
          .click();
        await dialog(f.page)
          .getByText(unresolvedCopy, { exact: true })
          .waitFor();
        expect(
          await dialog(f.page)
            .getByText('private-name.zip', { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await dialog(f.page)
            .getByRole('button', { name: '重试', exact: true })
            .count(),
        ).toBe(0);
        expect(writes(f.requests)).toHaveLength(2);
        expect(writes(f.requests)[1]?.body).toEqual(
          writes(f.requests)[0]?.body,
        );
      },
    );
  });

  for (const action of ['button', 'arrow', 'Escape'] as const) {
    it(`keeps the updated Skill return target through pending failed and recovered catalog reads using ${action}`, async () => {
      await withFixture({ scenario: 'post-confirm-read' }, async (f) => {
        await readUpdate(f.page);
        await dialog(f.page)
          .getByRole('button', { name: '确认更新', exact: true })
          .click();
        await dialog(f.page)
          .getByText('已更新“翻译校对”', { exact: true })
          .waitFor();
        await f.postReadRequested.promise;
        if (action === 'Escape') await f.page.keyboard.press('Escape');
        else
          await dialog(f.page)
            .locator(action === 'button' ? 'footer' : 'header')
            .getByRole('button', { name: '返回技能详情', exact: true })
            .click();
        await dialog(f.page)
          .getByRole('heading', { name: '翻译校对', exact: true })
          .waitFor();
        await dialog(f.page)
          .getByRole('status')
          .filter({ hasText: '正在读取…' })
          .waitFor();
        await expect
          .poll(() =>
            dialog(f.page).evaluate((node) =>
              node.contains(document.activeElement),
            ),
          )
          .toBe(true);
        f.postReadRelease.resolve();
        await f.postReadSent.promise;
        await dialog(f.page)
          .getByText('技能读取失败，请重试。', { exact: true })
          .waitFor();
        expect(
          await f.page
            .getByRole('heading', { name: 'AI 员工详情', exact: true })
            .count(),
        ).toBe(0);
        await dialog(f.page)
          .getByRole('button', { name: '重试', exact: true })
          .click();
        await dialog(f.page)
          .getByText('release-candidate', { exact: true })
          .waitFor();
        await expect
          .poll(() =>
            dialog(f.page).evaluate((node) =>
              node.contains(document.activeElement),
            ),
          )
          .toBe(true);
        expect(writes(f.requests)).toHaveLength(1);
        await saveRecords(`return-after-write-${action}`, f.requests);
      });
    });
  }

  it('hands focus to the current native layer on each source confirmation success and removal return', async () => {
    await withFixture({}, async (f) => {
      const inside = () =>
        expect
          .poll(() =>
            dialog(f.page).evaluate((node) =>
              node.contains(document.activeElement),
            ),
          )
          .toBe(true);
      await ready(f.page);
      await f.page
        .getByRole('button', { name: '翻译校对', exact: true })
        .focus();
      await f.page.keyboard.press('Enter');
      await dialog(f.page)
        .getByRole('heading', { name: '翻译校对', exact: true })
        .waitFor();
      await inside();
      await dialog(f.page)
        .getByRole('button', { name: '更新', exact: true })
        .focus();
      await f.page.keyboard.press('Enter');
      await dialog(f.page)
        .getByRole('heading', { name: '更新“翻译校对”', exact: true })
        .waitFor();
      await inside();
      await selectGitHubSource(f.page);
      await dialog(f.page)
        .getByLabel('仓库链接', { exact: true })
        .fill('https://github.com/example/translation-review');
      for (const action of ['arrow', 'cancel', 'Escape'] as const) {
        await dialog(f.page)
          .getByRole('button', { name: '读取', exact: true })
          .click();
        await dialog(f.page)
          .getByRole('heading', { name: '确认更新', exact: true })
          .waitFor();
        await inside();
        if (action === 'Escape') await f.page.keyboard.press('Escape');
        else
          await dialog(f.page)
            .getByRole('button', {
              name: action === 'arrow' ? '返回来源填写' : '取消',
              exact: true,
            })
            .click();
        await dialog(f.page)
          .getByRole('heading', { name: '更新“翻译校对”', exact: true })
          .waitFor();
        await inside();
      }
      await dialog(f.page)
        .getByRole('button', { name: '读取', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      await dialog(f.page)
        .getByText('已更新“翻译校对”', { exact: true })
        .waitFor();
      await inside();
      await dialog(f.page)
        .locator('footer')
        .getByRole('button', { name: '返回技能详情', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('button', { name: '卸载这个技能', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('heading', { name: '卸载“翻译校对”？', exact: true })
        .waitFor();
      await inside();
      await dialog(f.page)
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('heading', { name: '翻译校对', exact: true })
        .waitFor();
      await inside();
    });
  });

  it('uses the technical name and missing version for blank preview metadata through success and real catalog refresh', async () => {
    await withFixture({ scenario: 'blank-metadata' }, async (f) => {
      await readUpdate(f.page);
      expect(
        await dialog(f.page)
          .getByText('translation-review', { exact: true })
          .count(),
      ).toBe(1);
      expect(
        await dialog(f.page).getByText('未提供', { exact: true }).count(),
      ).toBe(1);
      await dialog(f.page)
        .getByRole('button', { name: '确认更新', exact: true })
        .click();
      await dialog(f.page)
        .getByText('已更新“translation-review”', { exact: true })
        .waitFor();
      await dialog(f.page)
        .locator('footer')
        .getByRole('button', { name: '返回技能详情', exact: true })
        .click();
      await dialog(f.page)
        .getByRole('heading', { name: 'translation-review', exact: true })
        .waitFor();
      await dialog(f.page).getByText('未提供', { exact: true }).waitFor();
    });
  });

  for (const width of [1440, 390]) {
    it(`keeps the frozen compact removal layout and actions visible with a long name and error at ${width}px`, async () => {
      await withFixture(
        {
          width,
          height: width === 390 ? 300 : 1000,
          longName: true,
          scenario: 'remove-unknown',
        },
        async (f) => {
          await ready(f.page);
          await f.page
            .getByRole('button', { name: '卸载', exact: true })
            .click();
          await dialog(f.page)
            .getByRole('button', { name: '卸载', exact: true })
            .click();
          await dialog(f.page)
            .getByText(unknownCopy, { exact: true })
            .waitFor();
          const actual = await paint(dialog(f.page));
          expect(actual.box.width).toBe(
            width === 390 ? actual.root.width - 40 : 408,
          );
          expect(actual.box.x + actual.box.width / 2).toBe(
            actual.root.x + actual.root.width / 2,
          );
          expect(actual.box.y).toBeGreaterThanOrEqual(20);
          expect(actual.box.y + actual.box.height).toBeLessThanOrEqual(
            actual.root.height - 20,
          );
          expect(actual.overflow).toBe(false);
          const layout = await dialog(f.page).evaluate((node) => {
            const header = node.querySelector('header'),
              footer = node.querySelector('footer'),
              body = footer?.previousElementSibling;
            if (!header || !footer || !body)
              throw new Error('Compact confirmation structure missing');
            const h = getComputedStyle(header),
              b = getComputedStyle(body),
              f = getComputedStyle(footer);
            return {
              header: {
                top: h.paddingTop,
                bottom: h.paddingBottom,
                left: h.paddingLeft,
                border: h.borderBottomWidth,
              },
              body: {
                top: b.paddingTop,
                bottom: b.paddingBottom,
                scroll: body.scrollHeight > body.clientHeight,
              },
              footer: {
                top: f.paddingTop,
                bottom: f.paddingBottom,
                left: f.paddingLeft,
                border: f.borderTopWidth,
              },
              buttons: [...footer.querySelectorAll('button')].map((button) => {
                const box = button.getBoundingClientRect();
                return {
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                };
              }),
            };
          });
          expect(layout.header).toMatchObject({ bottom: '0px', border: '0px' });
          expect(layout.body).toMatchObject({ top: '16px', bottom: '24px' });
          expect(layout.footer).toMatchObject({
            top: '0px',
            bottom: '20px',
            border: '0px',
          });
          expect(layout.buttons).toHaveLength(2);
          for (const button of layout.buttons)
            expect(button.y + button.height).toBeLessThanOrEqual(
              actual.root.height - 20,
            );
          if (width === 390) {
            expect(actual.box.x).toBe(20);
            expect(layout.header).toMatchObject({ top: '24px', left: '20px' });
            expect(layout.footer.left).toBe('20px');
            expect(layout.body.scroll).toBe(true);
            expect(layout.buttons[0]?.width).toBe(layout.buttons[1]?.width);
            expect(layout.buttons.every((button) => button.height >= 44)).toBe(
              true,
            );
          }
          await f.page.screenshot({
            path: resolve(evidence, `remove-${width}-error.png`),
          });
          await saveRecords(`remove-${width}-layout`, { actual, layout });
        },
      );
    });
  }
});
