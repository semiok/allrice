/** Real Chrome, synthetic HTTP only. No DB, auth, Dev, device or model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import { ids } from '../../test/technical-details-fixtures';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// Words an ordinary employee must not meet outside the technical details.
const engineering = [
  '{',
  '}',
  '待核实',
  '回执',
  '落盘',
  'Bridge',
  'MCP',
  'mcp__',
  'schema',
  'sha256',
  'SHA',
  'checksum',
  'digest',
  'Diff',
  '毫核',
  '字节',
  'EXECUTION_FAILED',
  'BRIDGE_',
  'waiting_user',
  'succeeded',
  'dispatched',
  'unknown',
];
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

suite('technical details stay behind a collapsed row', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/technical-details-page.tsx'],
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
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, origin).pathname;
      const asset = assets.get(path);
      if (asset) {
        res.setHeader(
          'Content-Type',
          path.endsWith('.css') ? 'text/css' : 'text/javascript',
        );
        res.end(asset);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/technical-details-page.css"><div id="root"></div><script type="module" src="/technical-details-page.js"></script>',
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
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
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

  const cards = (page: Page) => page.locator('[data-case="cloud"] article');
  async function open(width: number, theme: 'light' | 'dark') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await expect.poll(() => cards(page).count()).toBe(4);
    await page.getByRole('button', { name: '允许保存这些修改' }).waitFor();
    await page
      .getByRole('button', { name: '查看并确认', exact: true })
      .waitFor();
    await page.getByText('暂时读不到需要你确认的操作，会自动重试。').waitFor();
    return page;
  }
  const overflow = (page: Page) =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
  /** Opens every user-facing view: card details, each summary, file diffs. */
  async function readEverything(page: Page) {
    let text = await page.locator('main').innerText();
    for (const card of await cards(page).all()) {
      const toggle = card.getByRole('button', { name: '查看详情' });
      if (await toggle.count()) await toggle.click();
      for (const choice of await card
        .getByLabel('执行摘要')
        .getByRole('button')
        .all()) {
        if ((await choice.getAttribute('aria-expanded')) !== 'true')
          await choice.click();
        text += await card.innerText();
      }
    }
    for (const summary of await page.locator('main summary').all()) {
      await summary.click();
      text += await page.locator('main').innerText();
    }
    return text;
  }

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`shows a plain summary at ${width}px in the ${theme} theme`, async () => {
        const page = await open(width, theme);
        try {
          const collapsed = await page.locator('main').innerText();
          for (const line of [
            '等你确认的操作',
            '已完成',
            '未完成',
            '结果待确认',
            '等你确认',
            '允许对外发送内容',
            '会把这次的内容发送给 api.example-crm.com',
            '没有收到完整的结果，不确定这一步有没有生效。',
            '不会自动重新执行',
            '把修改保存到你的电脑',
            '保存修改 · 等你确认',
            '保存修改 · 已完成',
            '已保存到你的电脑',
          ])
            expect(collapsed).toContain(line);
          const text = await readEverything(page);
          for (const word of engineering) expect(text).not.toContain(word);
          expect(text).not.toMatch(uuid);
          expect(text).toContain('还没有收到电脑的处理结果');
          expect(text).toContain('修改文件');
          expect(text).toContain(
            '这一步未完成。可以在对话里让 AI 员工换个方式再试',
          );
          expect(text).toContain('2 项');
          // Technical details exist everywhere but none opened by itself.
          const rows = page.getByRole('button', { name: '技术详情' });
          expect(await rows.count()).toBeGreaterThan(4);
          for (const row of await rows.all())
            expect(await row.getAttribute('aria-expanded')).toBe('false');
          expect(await overflow(page)).toBe(false);
          // Every piece of text reads at 4.5:1 or better on its background.
          const weak = await page.evaluate(lowContrastText);
          expect(weak).toEqual([]);
        } finally {
          await page.close();
        }
      });

  it('keeps raw records in the technical details', async () => {
    const page = await open(390, 'light');
    try {
      const pending = cards(page).first();
      await pending.getByRole('button', { name: '技术详情' }).click();
      expect(await pending.innerText()).toContain('"channel": "sales"');
      const failed = cards(page).nth(2);
      await failed.getByRole('button', { name: '查看详情' }).click();
      await failed.getByRole('button', { name: '执行结果' }).click();
      await failed.getByRole('button', { name: '技术详情' }).click();
      const failedText = await failed.innerText();
      expect(failedText).toContain('EXECUTION_FAILED');
      expect(failedText).toContain('Cannot find module');
      const done = page.locator('[data-case="changeset-done"]');
      await done.getByRole('button', { name: '技术详情' }).click();
      const doneText = await done.innerText();
      expect(doneText).toContain('BRIDGE_RESULT_TIMEOUT');
      expect(doneText).toContain('sha256:');
      for (const row of await page
        .getByRole('button', { name: '技术详情' })
        .all())
        if ((await row.getAttribute('aria-expanded')) === 'false')
          await row.click();
      expect(await overflow(page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('sends the same approval requests and offers a refresh', async () => {
    const page = await open(390, 'light');
    try {
      await page.getByRole('button', { name: '允许对外发送内容' }).click();
      await expect
        .poll(() => page.evaluate(() => window.detailsApprovals.length))
        .toBe(1);
      // Once approved, the card stops offering the decision.
      await expect
        .poll(() =>
          page.getByRole('button', { name: '允许对外发送内容' }).count(),
        )
        .toBe(0);
      await page.getByRole('button', { name: '允许保存这些修改' }).click();
      await expect
        .poll(() => page.evaluate(() => window.detailsApprovals.length))
        .toBe(2);
      const [cloud, files] = await page.evaluate(() => window.detailsApprovals);
      expect(cloud!.url).toBe(`/api/v1/runtime/approvals/${ids.mcpApproval}`);
      expect(cloud!.body).toMatchObject({
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        approvalId: ids.mcpApproval,
        version: 1,
        requestDigest: `sha256:${'b'.repeat(64)}`,
        respondedBy: ids.user,
        decision: 'approved',
      });
      expect(files!.url).toBe(
        `/api/v1/runtime/approvals/${ids.changesetApproval}`,
      );
      expect(files!.body).toMatchObject({
        approvalId: ids.changesetApproval,
        decision: 'approved',
      });
      await page
        .getByRole('button', { name: '查看并确认', exact: true })
        .click();
      await page.getByRole('button', { name: '查看并确认文件修改' }).click();
      expect(await page.evaluate(() => window.detailsOpened)).toEqual([
        `operation:${ids.mcpOperation}`,
        `artifact:${ids.artifact}`,
      ]);
      const before = await page.evaluate(() => window.detailsStatusReads);
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.detailsStatusReads))
        .toBeGreaterThan(before);
    } finally {
      await page.close();
    }
  });
});

/** Visible text below 4.5:1 against its composited background. */
function lowContrastText() {
  const parse = (value: string) => {
    const srgb = value.match(
      /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/,
    );
    if (srgb)
      return [
        Number(srgb[1]) * 255,
        Number(srgb[2]) * 255,
        Number(srgb[3]) * 255,
        srgb[4] === undefined ? 1 : Number(srgb[4]),
      ];
    const [r, g, b, a] = value.match(/[\d.]+/g)!.map(Number);
    return [r!, g!, b!, a ?? 1];
  };
  const over = (top: number[], base: number[]) =>
    [0, 1, 2].map((i) => top[i]! * top[3]! + base[i]! * (1 - top[3]!));
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const weak: string[] = [];
  for (const node of document.querySelectorAll('main *')) {
    const own = [...node.childNodes].some(
      (child) => child.nodeType === 3 && child.textContent!.trim(),
    );
    const box = node.getBoundingClientRect();
    if (!own || !box.width || !box.height || node.closest(':disabled'))
      continue;
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const fill = parse(getComputedStyle(at).backgroundColor);
      if (fill[3]) layers.push(fill);
      if (fill[3] === 1) break;
    }
    let ground = [255, 255, 255];
    for (const layer of layers.reverse()) ground = over(layer, ground);
    const ink = over(parse(getComputedStyle(node).color), ground);
    const [x, y] = [luminance(ink), luminance(ground)].sort((m, n) => n - m);
    const ratio = (x! + 0.05) / (y! + 0.05);
    if (ratio < 4.5)
      weak.push(`${node.textContent!.trim().slice(0, 20)} ${ratio.toFixed(2)}`);
  }
  return weak;
}
