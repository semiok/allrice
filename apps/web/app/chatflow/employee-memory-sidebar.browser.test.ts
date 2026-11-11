/** Real v10 presentation and native DSH Modal; controlled synthetic adapter only.
 * This suite does not prove a new memory API, limits, persistence, or model tools. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET251 v10 memory sidebar presentation', () => {
  let browser: Browser,
    server: Server,
    origin: string,
    sequence = 0;
  const evidence = resolve('.local/met251-memory-sidebar');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-memory-sidebar-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/memory-sidebar-fixture',
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
    server = createServer((req, res) => {
      const pathname = new URL(req.url!, 'http://localhost').pathname,
        asset = assets.get(pathname);
      res.setHeader(
        'Content-Type',
        asset
          ? pathname.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-memory-sidebar-page.css"><div id="root"></div><script type="module" src="/employee-memory-sidebar-page.js"></script>',
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
    await mkdir(evidence, { recursive: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);
  async function fixture(query = '', width = 1440) {
    const page = await browser.newPage({
        viewport: { width, height: width < 600 ? 844 : 1000 },
        reducedMotion: 'reduce',
      }),
      errors: string[] = [],
      requests: string[] = [];
    page.setDefaultTimeout(6000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/'))
        requests.push(request.url());
    });
    await page.goto(origin + '/?' + query);
    await page
      .getByRole('heading', { name: 'Rice · 记忆', exact: true })
      .waitFor();
    const rows = page.locator('[data-memory-id]');
    return {
      page,
      rows,
      operations: async () =>
        JSON.parse(
          (await page.getByLabel('操作记录').textContent()) ?? '[]',
        ) as Array<{ action: string; payload: unknown }>,
      close: async () => {
        const name = String(++sequence).padStart(2, '0');
        await page.screenshot({ path: resolve(evidence, name + '.png') });
        await writeFile(
          resolve(evidence, name + '.json'),
          JSON.stringify({ query, width, errors, requests }, null, 2),
        );
        await page.close();
        expect(errors).toEqual([]);
        expect(requests).toEqual([]);
      },
    };
  }
  it.each([
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const)(
    'shows exact two groups and native readable detail at %s/%s',
    async (width, theme) => {
      const f = await fixture('theme=' + theme, width);
      try {
        expect(
          await f.page.getByText('（确认后生效）', { exact: true }).count(),
        ).toBe(1);
        expect(await f.rows.count()).toBe(3);
        expect(
          await f.page
            .getByRole('region', { name: '待确认', exact: true })
            .locator('[data-memory-id]')
            .count(),
        ).toBe(1);
        expect(
          await f.page
            .getByRole('region', { name: '生效中', exact: true })
            .innerText(),
        ).toContain('2 / 100');
        const panel = f.page.getByRole('region', {
          name: 'Rice · 记忆',
          exact: true,
        });
        for (const text of [
          '管理员可以查看',
          '置顶',
          '有效期',
          '容量预览',
          '加载更多',
          '已撤回',
          '已过期',
        ])
          expect(await panel.innerText()).not.toContain(text);
        const trigger = f.page.locator('[data-memory-id="a1"] button');
        await trigger.click();
        const dialog = f.page.getByRole('dialog');
        await dialog.waitFor();
        await dialog
          .getByText('金额超过 5 万先发给我看，再发客户。', { exact: true })
          .waitFor();
        expect(await dialog.getByText(/^生效于 \d{2}-\d{2}$/).count()).toBe(1);
        expect(await dialog.getByRole('button').allTextContents()).toEqual([
          '×',
          '删除',
          '修改',
        ]);
        const geometry = await dialog.boundingBox();
        expect(geometry!.x).toBeGreaterThanOrEqual(0);
        expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(width);
        await f.page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        expect(
          await trigger.evaluate((node) => node === document.activeElement),
        ).toBe(true);
        await f.page.locator('[data-memory-id="a2"] button').click();
        await f.page
          .getByRole('dialog')
          .getByText('没有详细说明', { exact: true })
          .waitFor();
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: '修改', exact: true })
          .click();
        await f.page
          .getByRole('dialog')
          .getByLabel(/一句话/)
          .waitFor();
        expect(await f.page.getByRole('dialog').getByLabel(/一句话/)
          .evaluate((node) => node === document.activeElement)).toBe(true);
        await f.page.keyboard.press('Tab');
        expect(
          await f.page
            .getByRole('dialog')
            .evaluate((node) => node.contains(document.activeElement)),
        ).toBe(true);
        await f.page.keyboard.press('Escape');
        await f.page.getByRole('dialog').waitFor({ state: 'detached' });
        expect(
          await f.page
            .locator('[data-memory-id="a2"] button')
            .evaluate((node) => node === document.activeElement),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
  it('keeps a candidate until adapter receipt, then projects authoritative rows without success UI', async () => {
    const f = await fixture('hold=confirm');
    try {
      await f.page
        .locator('[data-memory-id="p1"]')
        .getByRole('button', { name: '确认', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('region', { name: '待确认', exact: true })
          .locator('[data-memory-id="p1"]')
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .locator('[data-memory-id="p1"]')
          .getByRole('button', { name: '确认', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        (await f.operations()).filter((x) => x.action === 'confirm'),
      ).toHaveLength(1);
      await f.page.locator('#release').click();
      await f.page
        .getByRole('region', { name: '待确认', exact: true })
        .waitFor({ state: 'detached' });
      expect(
        await f.page
          .getByRole('region', { name: '生效中', exact: true })
          .locator('[data-memory-id]')
          .first()
          .getAttribute('data-memory-id'),
      ).toBe('p1');
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(await f.page.getByRole('status').count()).toBe(0);
      await f.page.locator('[data-memory-id="p1"] button').click();
      await f.page
        .getByRole('dialog')
        .getByText(/^生效于 \d{2}-\d{2}$/)
        .waitFor();
      expect(await f.page.getByRole('dialog').innerText()).not.toContain(
        '生效于 今天',
      );
    } finally {
      await f.close();
    }
  });
  it('counts Unicode characters and preserves the draft after an unconfirmed save', async () => {
    const f = await fixture('reject=save', 390);
    try {
      await f.page
        .getByRole('button', { name: '＋ 新增', exact: true })
        .click();
      const dialog = f.page.getByRole('dialog'),
        summary = dialog.getByLabel(/一句话/),
        details = dialog.getByLabel(/详细说明/),
        save = dialog.getByRole('button', { name: '保存', exact: true });
      await summary.fill('😀'.repeat(40));
      await details.fill('😀'.repeat(2000));
      expect(await save.isEnabled()).toBe(true);
      expect(
        await dialog.getByText('40 / 40 字', { exact: true }).count(),
      ).toBe(1);
      expect(
        await dialog.getByText('2000 / 2000 字', { exact: true }).count(),
      ).toBe(1);
      await summary.fill('😀'.repeat(41));
      expect(await save.isDisabled()).toBe(true);
      await summary.fill('😀'.repeat(40));
      await details.fill('😀'.repeat(2001));
      expect(await save.isDisabled()).toBe(true);
      await details.fill('完整说明');
      await save.click();
      await dialog.getByRole('alert').waitFor();
      expect(await summary.inputValue()).toBe('😀'.repeat(40));
      expect(await details.inputValue()).toBe('完整说明');
      expect((await f.operations()).filter((x) => x.action === 'save')).toEqual(
        [
          {
            action: 'save',
            payload: {
              input: { summary: '😀'.repeat(40), details: '完整说明' },
              id: null,
            },
          },
        ],
      );
      expect(await f.rows.count()).toBe(3);
    } finally {
      await f.close();
    }
  });
  it('pending modify/save becomes active only after adapter acknowledgement', async () => {
    const f = await fixture();
    try {
      await f.page.locator('[data-memory-id="p1"] button').first().click();
      await f.page
        .getByRole('dialog')
        .getByRole('button', { name: '修改', exact: true })
        .click();
      await f.page
        .getByRole('dialog')
        .getByLabel(/一句话/)
        .fill('周报先写结论，再列数据');
      await f.page
        .getByRole('dialog')
        .getByRole('button', { name: '保存', exact: true })
        .click();
      await f.page.getByRole('dialog').waitFor({ state: 'detached' });
      await f.page.locator('[data-memory-id="p1"] button').click();
      await f.page
        .getByRole('dialog')
        .getByRole('heading', { name: '周报先写结论，再列数据', exact: true })
        .waitFor();
      expect(
        await f.page
          .getByRole('dialog')
          .getByText('生效中', { exact: true })
          .count(),
      ).toBe(1);
      expect(
        (await f.operations()).filter((x) => x.action === 'save'),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('renders all 100 active rows, disables new/confirm, and frees display capacity only after delete', async () => {
    const f = await fixture('full=1');
    try {
      expect(
        await f.page
          .getByRole('region', { name: '生效中', exact: true })
          .locator('[data-memory-id]')
          .count(),
      ).toBe(100);
      expect(
        await f.page
          .getByText(
            '记忆已满（100 / 100）。删掉不再用的记忆后，才能新增或确认新的。',
            { exact: true },
          )
          .count(),
      ).toBe(1);
      expect(
        await f.page
          .getByRole('button', { name: '＋ 新增', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await f.page
          .locator('[data-memory-id="p1"]')
          .getByRole('button', { name: '确认', exact: true })
          .isDisabled(),
      ).toBe(true);
      await f.page.locator('[data-memory-id="active-0"] button').click();
      await f.page
        .getByRole('dialog')
        .getByRole('button', { name: '修改', exact: true })
        .click();
      expect(
        await f.page
          .getByRole('dialog')
          .getByRole('button', { name: '保存', exact: true })
          .isEnabled(),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      await f.page.locator('[data-memory-id="active-0"] button').click();
      await f.page
        .getByRole('dialog')
        .getByRole('button', { name: '删除', exact: true })
        .click();
      await f.page.getByRole('dialog', { name: '确认删除这条记忆？', exact: true })
        .getByRole('button', { name: '删除', exact: true }).click();
      await expect.poll(() => f.page.getByRole('dialog').count()).toBe(0);
      expect(
        await f.page
          .getByRole('button', { name: '＋ 新增', exact: true })
          .isEnabled(),
      ).toBe(true);
      expect(await f.page.locator('[data-memory-id="active-0"]').count()).toBe(
        0,
      );
      expect(await f.rows.count()).toBe(100);
    } finally {
      await f.close();
    }
  });
  it.each((['row', 'active', 'pending'] as const).flatMap((entry) =>
    ([ [1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark'] ] as const)
      .map(([width, theme]) => ({ entry, width, theme })),
  ))('confirms $entry deletion and restores cancel/Escape/mask focus at $width/$theme', async ({ entry, width, theme }) => {
    const f = await fixture('theme=' + theme, width);
    try {
      const id = entry === 'active' ? 'a1' : 'p1';
      const row = f.page.locator(`[data-memory-id="${id}"]`);
      if (entry !== 'row') {
        await row.locator('button').first().click();
        await f.page.getByRole('dialog').getByRole('button', { name: '修改', exact: true }).waitFor({ state: 'visible' });
      }
      const trigger = entry === 'row'
        ? row.getByRole('button', { name: /^删除/ })
        : f.page.getByRole('dialog').getByRole('button', { name: '删除', exact: true });
      const confirmation = f.page.getByRole('dialog', { name: '确认删除这条记忆？', exact: true });
      for (const cancel of ['button', 'escape', 'mask']) {
        await trigger.click();
        await confirmation.waitFor();
        expect(await confirmation.locator('p').first().innerText()).toBe(await row.locator('button').first().locator('span').nth(1).textContent());
        expect((await f.operations()).filter((item) => item.action === 'delete')).toHaveLength(0);
        expect(await row.count()).toBe(1);
        if (cancel === 'button') await confirmation.getByRole('button', { name: '取消', exact: true }).click();
        else if (cancel === 'escape') await f.page.keyboard.press('Escape');
        else await confirmation.locator('..').locator(':scope > [aria-hidden="true"]').click({ position: { x: 4, y: 4 } });
        await confirmation.waitFor({ state: 'detached' });
        expect(await row.count()).toBe(1);
        expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await f.page.getByRole('dialog').count()).toBe(entry === 'row' ? 0 : 1);
      }
      await trigger.click();
      await f.page.screenshot({ path: resolve(evidence, `delete-${entry}-${width}-${theme}.png`) });
      await confirmation.getByRole('button', { name: '删除', exact: true }).click();
      await row.waitFor({ state: 'detached' });
      await expect.poll(() => f.page.getByRole('dialog').count()).toBe(0);
      expect((await f.operations()).filter((item) => item.action === 'delete')).toEqual([{ action: 'delete', payload: id }]);
    } finally { await f.close(); }
  });
  it('keeps the edit CAS snapshot and nonempty detail whitespace across a background refresh', async () => {
    const f = await fixture('reject=save');
    try {
      await f.page.locator('[data-memory-id="a1"] button').click();
      await f.page.getByRole('dialog').getByRole('button', { name: '修改', exact: true }).click();
      const form = f.page.getByRole('form', { name: 'Rice · 修改记忆', exact: true });
      const raw = '  第一行\n\n第二行  \n';
      await form.getByLabel(/详细说明/).fill(raw);
      await f.page.locator('#refresh-memory').evaluate((node) => (node as HTMLButtonElement).click());
      expect(await form.getByLabel(/一句话/).inputValue()).toBe('报价规则：含税、PDF、文件名带客户和日期');
      expect(await form.getByLabel(/详细说明/).inputValue()).toBe(raw);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await form.getByRole('alert').waitFor();
      expect((await f.operations()).find((item) => item.action === 'save')?.payload).toEqual({
        id: 'a1', revision: 1, pairDigest: `sha256:${'a'.repeat(64)}`,
        input: { summary: '报价规则：含税、PDF、文件名带客户和日期', details: raw },
      });
    } finally { await f.close(); }
  });
  it('keeps a delete target until the final receipt and respects native IME Escape', async () => {
    const f = await fixture('hold=delete', 390);
    try {
      await f.page.locator('[data-memory-id="p1"]').getByRole('button', { name: /^删除/ }).click();
      const dialog = f.page.getByRole('dialog', { name: '确认删除这条记忆？', exact: true });
      await dialog.dispatchEvent('compositionstart');
      await f.page.keyboard.press('Escape');
      expect(await dialog.count()).toBe(1);
      await dialog.dispatchEvent('compositionend');
      await f.page.keyboard.press('ArrowRight');
      await dialog.getByRole('button', { name: '删除', exact: true }).click();
      expect(await f.page.locator('[data-memory-id="p1"]').count()).toBe(1);
      expect(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled()).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await dialog.count()).toBe(1);
      await f.page.locator('#release').evaluate((node) => (node as HTMLButtonElement).click());
      await dialog.waitFor({ state: 'detached' });
      expect(await f.page.locator('[data-memory-id="p1"]').count()).toBe(0);
    } finally { await f.close(); }
  });
  it('discards a late detail when the target changes and never displays unknown data as empty', async () => {
    const f = await fixture('hold=read');
    try {
      await f.page.locator('[data-memory-id="a1"] button').click();
      await f.page.getByRole('dialog').getByRole('status').waitFor();
      expect(
        await f.page
          .getByRole('dialog')
          .getByText('没有详细说明', { exact: true })
          .count(),
      ).toBe(0);
      await f.page
        .locator('#switch-target')
        .evaluate((node) => (node as HTMLButtonElement).click());
      await f.page
        .getByRole('heading', { name: 'Flow · 记忆', exact: true })
        .waitFor();
      await f.page.locator('#release').click();
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      expect(
        await f.page
          .getByText('金额超过 5 万先发给我看，再发客户。', { exact: true })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('uses exact empty copy and displays failed details as a real error', async () => {
    const empty = await fixture('empty=1', 390);
    try {
      expect(
        await empty.page.getByText('还没有记忆', { exact: true }).count(),
      ).toBe(1);
      expect(
        await empty.page
          .getByText(
            '聊天里提到的习惯和规则，Rice 会记下来等你确认；也可以直接新增。',
            { exact: true },
          )
          .count(),
      ).toBe(1);
    } finally {
      await empty.close();
    }
    const failed = await fixture('reject=read');
    try {
      await failed.page.locator('[data-memory-id="a1"] button').click();
      await failed.page.getByRole('dialog').getByRole('alert').waitFor();
      expect(
        await failed.page
          .getByRole('dialog')
          .getByText('没有详细说明', { exact: true })
          .count(),
      ).toBe(0);
      expect(
        await failed.page
          .getByRole('dialog')
          .getByRole('button', { name: '修改', exact: true })
          .isDisabled(),
      ).toBe(true);
    } finally {
      await failed.close();
    }
  });
});
