/** Real Chrome, synthetic HTTP only. No DB, auth, Dev, device or model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';
import {
  cloudOperations,
  forgedNote,
  ids,
  longReviewValue,
  longText,
  partnerArguments,
} from '../../test/technical-details-fixtures';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// The same authorized records remain readable after removing the extra row.
const authorizedRecords = [
  'mcp__app__send_message',
  'https://api.example-crm.com/mcp',
  '"channel": "sales"',
  'sha256:',
  '"checksum"',
  '"sourceDigest"',
  '"objectId"',
  '"manager": "pnpm"',
  '/usr/local/bin/node',
  'build.mjs',
  'EXECUTION_FAILED',
  'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN',
  'BRIDGE_RESULT_TIMEOUT',
  'WRITE_CONFLICT',
  'waiting_user',
  'succeeded',
  'unknown',
];
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i;

suite('authorized operation records stay readable inline', () => {
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
  // Panels keep polling until their page closes; drop any socket left open.
  // Closing Chrome alone took over 30s on a loaded M1 (load average 100+).
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  const cards = (page: Page) => page.locator('[data-case="cloud"] article');
  const card = (page: Page, operationId: string) =>
    page.locator(`#operation-${operationId}`);
  const stopButton = (page: Page) =>
    card(page, ids.runningOperation).getByRole('button', {
      name: '请求停止本轮全部操作',
    });
  async function open(width: number, theme: 'light' | 'dark') {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?theme=${theme}`);
    await expect.poll(() => cards(page).count()).toBe(8);
    await stopButton(page).waitFor();
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
    for (const each of await cards(page).all()) {
      const toggle = each.getByRole('button', { name: '查看详情' });
      if (await toggle.count()) await toggle.click();
      for (const choice of await each
        .getByLabel('执行摘要')
        .getByRole('button')
        .all()) {
        if ((await choice.getAttribute('aria-expanded')) !== 'true')
          await choice.click();
        text += await each.innerText();
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
            '允许对外发送内容',
            '会按下面的内容调用 api.example-crm.com',
            'send_message（对外发送内容）',
            'api.example-crm.com',
            '渠道 sales',
            '收件人 sales@example.com',
            '渠道 partner-ext',
            '收件人 buyer@partner.example',
            'recipients 第 1 项 · email',
            '本周报价已更新',
            '展开全文',
            '没有收到完整的结果，不确定这一步有没有生效。',
            '不会自动重新执行',
            '把修改保存到你的电脑',
            '保存修改 · 等你确认',
            '保存修改 · 已完成',
            '已保存到你的电脑',
            '没有收到这个文件的处理结果，请打开文件确认有没有改动。',
            // WRITE_CONFLICT has several causes: neutral words only.
            '保存前的检查没有通过，这个文件没有改动。',
          ])
            expect(collapsed).toContain(line);
          // A step nobody can answer any more never says 等你确认.
          for (const [operation, label] of [
            [ids.mcpOperation, '等你确认'],
            [ids.rejectedOperation, '你已拒绝'],
            [ids.expiredOperation, '已过期'],
            [ids.appFailedOperation, '未完成'],
          ] as const)
            expect(
              await card(page, operation)
                .locator('header')
                .getByRole('status')
                .innerText(),
            ).toBe(label);
          const text = await readEverything(page);
          for (const record of authorizedRecords)
            expect(text).toContain(record);
          expect(text).toContain(ids.mcpOperation);
          expect(text).toContain('还没有收到电脑的处理结果');
          expect(text).toContain('修改文件');
          expect(text).toContain('应用回复了错误');
          expect(text).toContain(
            '这一步未完成。可以在对话里让 AI 员工换个方式再试',
          );
          // Only the covered panels lose their duplicate technical entry.
          for (const scope of [
            'cloud',
            'cloud-running',
            'changeset',
            'changeset-done',
          ])
            expect(
              await page
                .locator(`[data-case="${scope}"]`)
                .getByRole('button', { name: '技术详情', exact: true })
                .count(),
            ).toBe(0);
          expect(await overflow(page)).toBe(false);
          // Every piece of text reads at 4.5:1 or better on its background,
          // including the stop control of a running task while hovered.
          const stop = stopButton(page);
          const ink = await stop.evaluate(
            (node) => getComputedStyle(node.closest('article')!).color,
          );
          // Headless Chrome keeps no real pointer, so force :hover on the
          // stop control, then wait out its 160ms color transition.
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
          const { root } = await cdp.send('DOM.getDocument');
          const { nodeId } = await cdp.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: `[id="operation-${ids.runningOperation}"] button[aria-label="请求停止本轮全部操作"]`,
          });
          await cdp.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: ['hover'],
          });
          await expect
            .poll(() => stop.evaluate((node) => getComputedStyle(node).color))
            .toBe(ink);
          const weak = await page.evaluate(lowContrastText);
          await cdp.detach();
          expect(weak).toEqual([]);
        } finally {
          await page.close();
        }
      });

  /** Each parameter as [name, value], read from separate elements. */
  const parameters = (page: Page, operationId: string) =>
    card(page, operationId)
      .getByLabel('参数', { exact: true })
      .evaluate((list) =>
        [...list.children].map((row) => [
          (row.querySelector('dt') as HTMLElement).innerText,
          (row.querySelector('dd') as HTMLElement).innerText,
        ]),
      );

  it('shows each pending parameter by path, kept apart from its value', async () => {
    const page = await open(390, 'light');
    try {
      const sales = Object.fromEntries(
        await parameters(page, ids.mcpOperation),
      );
      expect(sales).toEqual({
        channel: 'sales',
        text: '本周报价已更新',
        'recipients 第 1 项 · email': 'sales@example.com',
      });
      const partner = await parameters(page, ids.partnerOperation);
      // A nested recipient alone tells the two calls apart.
      expect(Object.fromEntries(partner)['recipients 第 1 项 · email']).toBe(
        'buyer@partner.example',
      );
      // A value's colon and line break stay inside that value.
      expect(partner.map(([name]) => name)).toEqual([
        'channel',
        'text',
        'notify',
        'recipients 第 1 项 · email',
        'note',
        ...Array.from(
          { length: 45 },
          (_, index) => `review · field_${String(index + 1).padStart(2, '0')}`,
        ),
      ]);
      expect(Object.fromEntries(partner).note).toBe(forgedNote);
      for (const id of [ids.mcpOperation, ids.partnerOperation])
        expect(
          (
            await card(page, id)
              .getByLabel('这次要做的事')
              .locator(
                ':scope > div > dd:not(:has([data-process-content="approval-arguments"])), [aria-label="参数"]',
              )
              .allInnerTexts()
          ).join('\n'),
        ).not.toMatch(/[{}]/);
      // A long value is clipped, and 展开全文 shows the real text.
      const text = () =>
        parameters(page, ids.partnerOperation).then(
          (rows) => Object.fromEntries(rows).text as string,
        );
      expect(await text()).not.toContain(longText);
      expect(await text()).toContain(`${longText.slice(0, 20)}`);
      expect(await text()).toContain('…');
      const details = card(page, ids.partnerOperation).getByLabel('参数', {
        exact: true,
      });
      await details.getByRole('button', { name: '展开全文' }).click();
      expect(await text()).toContain(longText);
      await details.getByRole('button', { name: '收起' }).click();
      expect(await text()).not.toContain(longText);
      expect(await overflow(page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('keeps all sixty authorized MCP leaves and long values readable before approval', async () => {
    const page = await open(390, 'light');
    try {
      const pending = card(page, ids.partnerOperation);
      const complete = pending.getByLabel('发送的完整参数', { exact: true });
      expect(await complete.count()).toBe(1);
      expect(await complete.isVisible()).toBe(true);
      const args = JSON.parse(await complete.innerText());
      expect(args).toEqual(partnerArguments);
      expect(Object.keys(args.review)).toHaveLength(55);
      for (let number = 46; number <= 55; number++)
        expect(args.review[`field_${number}`]).toBe(
          partnerArguments.review[`field_${number}`],
        );
      expect(args.review.field_55).toBe(longReviewValue);
      expect(await pending.locator('[data-forged-review]').count()).toBe(0);
      expect(
        await pending
          .getByRole('button', { name: '允许对外发送内容' })
          .isEnabled(),
      ).toBe(true);
      expect(await page.evaluate(() => window.detailsApprovals)).toEqual([]);
      expect(await overflow(page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('keeps authorized raw records inline without a duplicate technical entry', async () => {
    const page = await open(390, 'light');
    try {
      const pending = card(page, ids.mcpOperation);
      expect(await pending.getByLabel('发送的原始参数').isVisible()).toBe(true);
      expect(await pending.innerText()).toContain('"channel": "sales"');
      for (const [operation, raw] of [
        [ids.projectOperation, 'EXECUTION_FAILED'],
        [ids.appFailedOperation, 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN'],
      ] as const) {
        const each = card(page, operation);
        await each.getByRole('button', { name: '查看详情' }).click();
        await each.getByRole('button', { name: '执行结果' }).click();
        expect(await each.innerText()).toContain(raw);
        expect(
          await each.locator('[data-process-content="result"]').count(),
        ).toBe(1);
      }
      expect(await card(page, ids.projectOperation).innerText()).toContain(
        'Cannot find module',
      );
      const done = page.locator('[data-case="changeset-done"]');
      const doneText = await done.innerText();
      expect(doneText).toContain('BRIDGE_RESULT_TIMEOUT');
      expect(doneText).toContain('WRITE_CONFLICT');
      expect(doneText).toContain('sha256:');
      expect(
        await done
          .getByRole('button', { name: '技术详情', exact: true })
          .count(),
      ).toBe(0);
      expect(await overflow(page)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('explains a lost answer in plain words and resends only the same answer', async () => {
    const page = await open(390, 'light');
    try {
      await page.evaluate(() => {
        window.detailsFailNextApproval = true;
      });
      const allow = card(page, ids.partnerOperation).getByRole('button', {
        name: '允许对外发送内容',
      });
      await allow.click();
      const alert = page.locator('[data-case="cloud"]').getByRole('alert');
      await expect
        .poll(() => alert.innerText())
        .toContain('你的选择可能没有送达');
      expect(await alert.innerText()).not.toMatch(/409|approval_|Failed/);
      await allow.click();
      await expect
        .poll(() => page.evaluate(() => window.detailsApprovals.length))
        .toBe(2);
      const [first, second] = await page.evaluate(
        () => window.detailsApprovals,
      );
      const original = cloudOperations([]).find(
        (operation) =>
          operation.snapshot.binding.attempt.operationId ===
          ids.partnerOperation,
      )!.approval!.request;
      expect(first!.url).toBe(
        `/api/v1/runtime/approvals/${ids.partnerApproval}`,
      );
      expect(first!.body).toEqual({
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: original.requestId,
        version: original.version,
        requestDigest: original.requestDigest,
        task: original.task,
        responseId: expect.stringMatching(uuid),
        respondedBy: original.respondentId,
        respondedAt: expect.any(String),
        approvalId: original.approvalId,
        decision: 'approved',
      });
      expect(second!.body).toEqual(first!.body);
      expect(second!.body.responseId).toBe(first!.body.responseId);
      expect(second!.body.decision).toBe('approved');
    } finally {
      await page.close();
    }
  });

  it('sends the same approval requests and offers a refresh', async () => {
    const page = await open(390, 'light');
    try {
      const sales = card(page, ids.mcpOperation);
      await sales.getByRole('button', { name: '允许对外发送内容' }).click();
      await expect
        .poll(() => page.evaluate(() => window.detailsApprovals.length))
        .toBe(1);
      // Once approved, the card stops offering the decision.
      await expect
        .poll(() =>
          sales.getByRole('button', { name: '允许对外发送内容' }).count(),
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
    // Chrome serializes some color-mix() results in Oklab.
    const oklab = value.match(
      /oklab\(([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.]+))?/,
    );
    if (oklab) {
      const [L, a, b] = oklab.slice(1, 4).map(Number) as [
        number,
        number,
        number,
      ];
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const encode = (c: number) =>
        255 *
        Math.min(
          1,
          Math.max(
            0,
            c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055,
          ),
        );
      return [
        encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        oklab[4] === undefined ? 1 : Number(oklab[4]),
      ];
    }
    if (!/^(rgba?|color\(srgb)/.test(value))
      throw Error(`unparsed color ${value}`);
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
