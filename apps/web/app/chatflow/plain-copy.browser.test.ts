/** Real Chrome, static props and a synthetic fetch only. No server, DB, device or model. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Browser,
  Locator,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

// Words an ordinary employee must not meet in these settings and task lists.
const banned = [
  'Token',
  'Bridge',
  'DSH',
  'Codex',
  'Boost',
  'Teamwork',
  '待核实',
  '回执',
  'Session ID',
  'Asia/Shanghai',
  'changeset_candidate',
  'workspace.export',
  'MCP',
  'SHA',
  'synthetic_unlisted_reason',
  'SyntaxError',
  'Unexpected token',
  '"code"',
];

suite('plain words in settings and automation for ordinary employees', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/plain-copy-page.tsx'],
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plain-copy-page.css"><div id="root"></div><script type="module" src="/plain-copy-page.js"></script>',
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
  }, 60_000);
  // Closing real Chrome can take over 10 seconds on macOS.
  afterAll(async () => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 60_000);

  const contrast = (a: string, b: string) => {
    const luminance = (value: string) => {
      const [r, g, b] = value
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map((v) => {
          const c = Number(v) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };
  /** Text colour against the first opaque background behind it. */
  const colours = (node: Locator) =>
    node.evaluate((element) => {
      let ground = 'rgba(0, 0, 0, 0)';
      for (
        let at: Element | null = element;
        at && /rgba\(.*, 0\)$/.test(ground);
        at = at.parentElement
      )
        ground = getComputedStyle(at).backgroundColor;
      return { text: getComputedStyle(element).color, ground };
    });
  const caseOf = (page: Page, name: string) =>
    page.locator(`[data-case="${name}"]`);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`speaks plainly at ${width}px in the ${theme} theme`, async () => {
        // A viewer far from the tasks' Beijing time zone.
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          timezoneId: 'America/New_York',
        });
        try {
          await page.goto(`${origin}/?theme=${theme}`);
          // Open every fold so its words are checked too.
          for (const row of await page.getByText('用量如何计算').all())
            await row.click();
          // The password fold works from the keyboard and keeps what was typed.
          const fold = page.getByRole('button', {
            name: '修改登录密码',
            exact: true,
          });
          expect(await fold.getAttribute('aria-expanded')).toBe('false');
          await fold.focus();
          await page.keyboard.press('Enter');
          expect(await fold.getAttribute('aria-expanded')).toBe('true');
          const password = caseOf(page, 'account').locator('form');
          await password.getByLabel('当前密码').fill('synthetic-old-1');
          await password
            .getByLabel('新密码', { exact: true })
            .fill('synthetic-new-1');
          await password.getByLabel('确认新密码').fill('synthetic-new-1');
          await fold.focus();
          await page.keyboard.press(' ');
          expect(await fold.getAttribute('aria-expanded')).toBe('false');
          await page.keyboard.press('Enter');
          expect(await password.getByLabel('当前密码').inputValue()).toBe(
            'synthetic-old-1',
          );
          // The reply is lost: the change may or may not have happened.
          await password
            .getByRole('button', { name: '修改密码并重新登录' })
            .click();
          expect(await password.getByRole('alert').innerText()).toBe(
            '修改结果待确认，请重新登录，确认新密码是否生效。',
          );
          for (const summary of await page
            .locator(
              '[data-case="computer"] summary, [data-case="work"] summary',
            )
            .all())
            if (await summary.isVisible()) await summary.click();
          await page.getByText('还没有自动化任务', { exact: true }).waitFor();
          await page
            .getByText('这个对话没有进行中的自动化任务', { exact: true })
            .waitFor();
          await caseOf(page, 'automation-tasks')
            .getByText(/每日工作提醒 40/)
            .waitFor();
          for (const name of ['automation-unreadable', 'automation-invalid'])
            await caseOf(page, name).getByRole('alert').waitFor();

          if (process.env.ALLRICE_PLAIN_COPY_SCREENSHOT)
            await page.screenshot({
              path: `${process.env.ALLRICE_PLAIN_COPY_SCREENSHOT}-${width}-${theme}.png`,
              fullPage: true,
            });
          const text = await page.locator('main').innerText();
          for (const word of banned) expect(text).not.toContain(word);

          const account = caseOf(page, 'account');
          for (const words of [
            '本月已用',
            '本月上限',
            '5,000,000',
            '2,175,971 · 43%',
            '11 月 1 日',
            '有 2 次任务的用量还在统计',
            '没有月度上限',
            '用量暂时读不到',
            '修改密码并重新登录',
          ])
            expect(await account.innerText()).toContain(words);

          const computer = caseOf(page, 'computer');
          const computerText = await computer.innerText();
          for (const words of [
            'AllRice 助手',
            '这台电脑',
            'MacBook-Pro.local',
            '未连接',
            '电脑上还没有安装 Git。',
            '环境检查没有通过，请刷新状态，或重新打开 AllRice 助手。',
            '“无法验证开发者”',
            'AllRice 助手 0.6.0',
            '下载 AllRice 助手（Apple 芯片） · v0.6.1',
          ])
            expect(computerText).toContain(words);

          const work = caseOf(page, 'work');
          for (const words of ['深入攻关', '团队任务', '这项能力还没有开放'])
            expect(await work.innerText()).toContain(words);

          expect(await caseOf(page, 'automation-empty').innerText()).toContain(
            '在对话里说「每天 9 点提醒我写日报」就能创建。',
          );
          expect(
            await caseOf(page, 'automation-empty')
              .getByText('没有匹配的自动化任务')
              .count(),
          ).toBe(0);
          const tasks = await caseOf(page, 'automation-tasks').innerText();
          for (const words of [
            '每天 09:00 · 北京时间',
            '每周一、三 18:30 · 北京时间',
            '下次运行 11 月 1 日 09:00',
            '原对话已归档',
          ])
            expect(tasks).toContain(words);
          // Read in the task's zone, not the viewer's (10 月 31 日 21:00).
          expect(tasks).not.toContain('10 月 31 日');
          const conversation = await caseOf(
            page,
            'automation-conversation',
          ).innerText();
          expect(conversation).toContain('这个对话没有进行中的自动化任务');
          expect(conversation).toContain(
            '已暂停或已结束的任务，可以在「自动化任务」页查看。',
          );
          expect(conversation).not.toContain('没有匹配');
          for (const name of ['automation-unreadable', 'automation-invalid'])
            expect(
              await caseOf(page, name).getByRole('alert').innerText(),
            ).toBe('暂时读不到自动化任务，请稍后点「刷新」再试。');
          // Searching an empty catalog is a filter result, not a first-run state.
          await caseOf(page, 'automation-empty')
            .getByRole('textbox', { name: '搜索自动化任务' })
            .fill('日报');
          await caseOf(page, 'automation-empty')
            .getByText('没有匹配的自动化任务', { exact: true })
            .waitFor();

          for (const node of [
            account.getByText('用量如何计算').first(),
            account.getByText('修改登录密码', { exact: true }),
            account.getByText('本月已用').first(),
            caseOf(page, 'automation-unreadable').getByRole('alert'),
            caseOf(page, 'automation-empty').getByText('没有匹配的自动化任务'),
            caseOf(page, 'automation-conversation').getByText(
              '这个对话没有进行中的自动化任务',
            ),
          ]) {
            const look = await colours(node);
            expect(contrast(look.text, look.ground)).toBeGreaterThanOrEqual(
              4.5,
            );
          }
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            ),
          ).toBe(false);
        } finally {
          await page.close();
        }
      });
});
