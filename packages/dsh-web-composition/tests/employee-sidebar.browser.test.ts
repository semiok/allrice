import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { documentSession, processSession } from './native-history.mjs';

interface SidebarTest {
  fixtureEmployee: string;
  commands: { name: string; id?: string }[];
  openSession: (id: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setState: (state: string) => void;
  baseline: (shown: boolean, width?: number) => void;
  nativeInput: (
    id?: string,
  ) => Promise<{ draft: string; attachmentCount: number }>;
  nativeScroll: (id?: string) => Promise<{
    anchorKey: string;
    anchorTop: number;
    scrollTop: number;
  } | null>;
}
declare global {
  interface Window {
    __allriceSidebarTest?: SidebarTest;
    __allriceFixtureEmployee?: string;
  }
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

suite('real AllRice sidebar in installed native profiles', () => {
  const hosts: Awaited<ReturnType<typeof startInstalledProfile>>[] = [];
  const errors: string[] = [],
    legacyRequests: string[] = [];
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    other: Page,
    artifacts: string;

  const open = async (view: Page, host: (typeof hosts)[number]) => {
    view.setDefaultTimeout(15_000);
    view.on('pageerror', (error) => errors.push(error.message));
    view.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/')) legacyRequests.push(path);
    });
    await view.goto(host.authUrl);
    const proceed = view.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await view.goto(host.origin);
    await view.waitForFunction(() => !!window.__allriceSidebarTest);
    await view
      .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
        exact: true,
      })
      .waitFor();
  };

  beforeAll(async () => {
    hosts.push(
      await startInstalledProfile(
        new URL('./fixtures/sidebar-client.js', import.meta.url),
      ),
    );
    hosts.push(
      await startInstalledProfile(
        new URL('./fixtures/sidebar-client.js', import.meta.url),
      ),
    );
    artifacts = await mkdtemp(
      join(
        resolve(
          process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR ?? hosts[0]!.root,
        ),
        'employee-sidebar-',
      ),
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    // Both Hosts share one browser context; distinct origins, not two incognito
    // contexts, supply native localStorage isolation in this experiment.
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
      Date.now = () => Date.parse('2026-11-21T12:00:00.000Z');
    });
    page = await context.newPage();
    other = await context.newPage();
    await other.addInitScript(() => {
      window.__allriceFixtureEmployee = 'writer';
    });
    await open(page, hosts[0]!);
    await open(other, hosts[1]!);
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      for (const host of hosts.reverse()) await host.close();
    }
  });

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !artifacts || !page || page.isClosed())
      return;
    await page.screenshot({
      path: join(artifacts, `first-failure-${task.id}.png`),
      fullPage: true,
    });
    await writeFile(
      join(artifacts, `first-failure-${task.id}.json`),
      JSON.stringify(
        {
          name: task.name,
          errors: task.result.errors,
          pageErrors: errors,
          legacyRequests,
        },
        null,
        2,
      ),
    );
  });

  it('preserves the real brand, employee cards, pagination and command entrypoints without any 3.x reader', async () => {
    const sidebar = page.locator('#chat-sidebar');
    expect(
      await sidebar.getByRole('img', { name: 'Allrice Workspace' }).isVisible(),
    ).toBe(true);
    expect(await sidebar.locator('[data-row-key^="session:"]').count()).toBe(
      10,
    );
    await sidebar
      .getByRole('button', { name: /^展开其余/ })
      .first()
      .click();
    expect(
      await sidebar.locator('[data-row-key^="session:"]').count(),
    ).toBeGreaterThan(30);
    await sidebar
      .getByRole('button', { name: '收起更多会话', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '创建员工', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '查看Rice详情', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '和 Rice 开新会话', exact: true })
      .click();
    await sidebar.getByRole('button', { name: '设置', exact: true }).click();
    await sidebar
      .getByRole('button', { name: '查看归档', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '返回当前工作', exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.__allriceSidebarTest!.commands.map((row) => row.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        'create-employee',
        'details',
        'new-thread',
        'employee-settings',
        'open-archive',
      ]),
    );
    await sidebar
      .getByRole('button', { name: '自动化任务', exact: true })
      .click();
    await page
      .getByText('还没有自动化任务，在会话中创建的任务会显示在这里', {
        exact: true,
      })
      .waitFor();
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    for (const state of ['loading', 'error', 'denied', 'empty', 'ready']) {
      await page.evaluate(
        (kind) => window.__allriceSidebarTest!.setState(kind),
        state,
      );
      if (state === 'error')
        await sidebar.getByText('会话暂未更新', { exact: true }).waitFor();
      if (state === 'loading')
        await sidebar.getByText('正在更新会话…', { exact: true }).waitFor();
      if (state === 'denied')
        await sidebar
          .getByRole('alert')
          .filter({ hasText: '当前员工暂不可用' })
          .waitFor();
      if (state === 'empty')
        expect(
          await sidebar.locator('[data-row-key^="session:"]').count(),
        ).toBe(0);
    }
    expect(legacyRequests).toEqual([]);
  }, 60_000);

  it('keeps native draft and runtime attachment ownership within one Host and records the real cross-root storage boundary', async () => {
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    const editor = page
      .locator('textarea:visible,[contenteditable=true]:visible')
      .first();
    await editor.fill('员工 A 的未发送草稿');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: '合成草稿附件.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('fixture attachment only'),
      });
    await page.waitForFunction(
      async () =>
        (await window.__allriceSidebarTest!.nativeInput()).attachmentCount ===
        1,
    );
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      documentSession,
    );
    await page
      .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
      .waitFor();
    expect(
      await page.evaluate(
        (id) => window.__allriceSidebarTest!.nativeInput(id),
        documentSession,
      ),
    ).toEqual({ draft: '', attachmentCount: 0 });
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    await editor.waitFor();
    expect(
      await page.evaluate(() => window.__allriceSidebarTest!.nativeInput()),
    ).toEqual({ draft: '员工 A 的未发送草稿', attachmentCount: 1 });
    expect(
      await other.evaluate(() => window.__allriceSidebarTest!.nativeInput()),
    ).toEqual({ draft: '', attachmentCount: 0 });
    await other
      .locator('textarea:visible,[contenteditable=true]:visible')
      .first()
      .fill('员工 B 的独立草稿');
    expect(
      (await page.evaluate(() => window.__allriceSidebarTest!.nativeInput()))
        .draft,
    ).toBe('员工 A 的未发送草稿');

    // A second native root at the SAME origin observes the same persisted draft
    // for the same native ID. This is retained limitation evidence, not product
    // employee authorization or a passed same-origin isolation claim.
    const sameOrigin = await context.newPage();
    try {
      await sameOrigin.addInitScript(() => {
        window.__allriceFixtureEmployee = 'writer';
      });
      await open(sameOrigin, hosts[0]!);
      const same = await sameOrigin.evaluate(() =>
        window.__allriceSidebarTest!.nativeInput(),
      );
      expect(same).toEqual({
        draft: '员工 A 的未发送草稿',
        attachmentCount: 0,
      });
      await writeFile(
        join(artifacts, 'native-storage-boundary.json'),
        JSON.stringify(
          {
            nativeSessionId: processSession,
            syntheticBusinessEmployees: ['rice', 'writer'],
            sameOriginSecondRoot: same,
            otherOrigin: await other.evaluate(() =>
              window.__allriceSidebarTest!.nativeInput(),
            ),
            conclusion:
              'Native draft persistence is origin/session-scoped; attachments are runtime-owned. No authenticated AllRice route or cross-root receipt restore is proven.',
          },
          null,
          2,
        ),
      );
    } finally {
      await sameOrigin.close();
    }
    await editor.fill('');
  }, 60_000);

  it('uses the native reading anchor for same-Host session switches', async () => {
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    for (const name of [/^已完成，用时/, /^执行了命令$/, /^运行命令/]) {
      const button = page.getByRole('button', { name }).first();
      if ((await button.getAttribute('aria-expanded')) === 'false')
        await button.click();
    }
    const scrollport = async () => {
      const text = await page
        .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
          exact: true,
        })
        .elementHandle();
      const handle = await text!.evaluateHandle((node) => {
        let current = node.parentElement;
        while (
          current &&
          !(
            current.scrollHeight > current.clientHeight + 20 &&
            /auto|scroll/.test(getComputedStyle(current).overflowY)
          )
        )
          current = current.parentElement;
        return current;
      });
      return handle.asElement();
    };
    const port = await scrollport();
    expect(port).not.toBeNull();
    const box = await port!.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -240);
    await page.waitForFunction(
      async () => (await window.__allriceSidebarTest!.nativeScroll()) !== null,
    );
    const saved = await page.evaluate(() =>
      window.__allriceSidebarTest!.nativeScroll(),
    );
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      documentSession,
    );
    await page
      .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
      .waitFor();
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    await settle(page);
    const restoredPort = await scrollport();
    expect(
      Math.abs(
        (await restoredPort!.evaluate((node) => node.scrollTop)) -
          saved!.scrollTop,
      ),
    ).toBeLessThanOrEqual(0.5);
    await writeFile(
      join(artifacts, 'native-reading-anchor.json'),
      JSON.stringify(
        {
          saved,
          restored: await page.evaluate(() =>
            window.__allriceSidebarTest!.nativeScroll(),
          ),
          scope:
            'same native root only; cross-root public restore seam unavailable',
        },
        null,
        2,
      ),
    );
  }, 60_000);

  it('replays identical Frame/View data in light/dark at 1440/390 and keeps mobile keyboard focus bounded', async () => {
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (mode) => window.__allriceSidebarTest!.setTheme(mode),
          theme,
        );
        if (width === 390) {
          await page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
          await page
            .getByRole('dialog', { name: '任务与历史', exact: true })
            .waitFor();
        }
        await settle(page);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        const native = page.locator('#chat-sidebar > div').last();
        const box = await native.boundingBox();
        await native.screenshot({
          path: join(artifacts, `native-${width}-${theme}.png`),
        });
        await page.screenshot({
          path: join(artifacts, `native-page-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.evaluate(
          (size) => window.__allriceSidebarTest!.baseline(true, size),
          box!.width,
        );
        const baseline = page.locator('[data-sidebar-baseline] #chat-sidebar');
        await baseline.waitFor();
        expect(
          Math.abs((await baseline.boundingBox())!.width - box!.width),
        ).toBeLessThanOrEqual(0.5);
        await baseline.screenshot({
          path: join(artifacts, `shared-frame-baseline-${width}-${theme}.png`),
        });
        await page.evaluate(() => window.__allriceSidebarTest!.baseline(false));
        if (width === 390) {
          const dialog = page.getByRole('dialog', {
            name: '任务与历史',
            exact: true,
          });
          await dialog
            .getByRole('button', { name: '设置', exact: true })
            .focus();
          await page.keyboard.press('Tab');
          expect(
            await page
              .getByRole('button', { name: '收起侧边栏', exact: true })
              .evaluate((node) => node === document.activeElement),
          ).toBe(true);
          await page.keyboard.press('Escape');
          expect(
            await page
              .getByRole('dialog', { name: '任务与历史', exact: true })
              .count(),
          ).toBe(0);
        }
      }
    await writeFile(
      join(artifacts, 'capture-context.json'),
      JSON.stringify(
        {
          candidate: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          browser: browser.version(),
          platform: process.platform,
          dpr: 1,
          fixedTime: '2026-11-21T12:00:00.000Z',
          reducedMotion: 'reduce',
          widths: [1440, 390],
          themes: ['light', 'dark'],
          baseline:
            'Shared real AllRice Frame/View, same synthetic port data and measured width; no legacy request wrapper',
          errors,
          legacyRequests,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifacts, 'comparison.html'),
      `<!doctype html><meta charset="utf-8"><title>MET-276 真实侧栏对照</title>
<style>body{font:16px system-ui;margin:24px;background:#f3f4f6;color:#111}main{display:flex;gap:24px;align-items:flex-start}img{max-width:100%;border:1px solid #bbb}section{min-width:0}p{max-width:900px}select{font:inherit;margin:12px}</style>
<h1>MET-276 真实 AllRice Frame/View → 原生 sidebar</h1>
<p>待主线逐屏复核。两侧使用同一合成数据、固定时间、DPR1、减少动态效果和实测相同宽度。左侧为现有 AllRice 呈现的共享组件基准；不把旧截图里的不同员工当像素基准。正式 SSO、同 origin 员工草稿隔离、跨根附件/scroll 仍未接通。</p>
<label>画布<select id="width"><option>1440</option><option>390</option></select></label><label>主题<select id="theme"><option>light</option><option>dark</option></select></label>
<main><section><h2>共享真实 Frame/View 基准</h2><img id="before"></section><section><h2>原生 sidebar 内实现</h2><img id="after"></section></main>
<p><a href="capture-context.json">浏览器与源码记录</a> · <a href="native-storage-boundary.json">同 origin 同 ID 负向原件</a> · <a href="native-reading-anchor.json">同根阅读位置记录</a></p>
<script>const w=document.getElementById('width'),t=document.getElementById('theme');function show(){document.getElementById('before').src='shared-frame-baseline-'+w.value+'-'+t.value+'.png';document.getElementById('after').src='native-'+w.value+'-'+t.value+'.png'}w.onchange=t.onchange=show;show();</script>`,
    );
    expect(errors).toEqual([]);
    expect(legacyRequests).toEqual([]);
  }, 60_000);
});
