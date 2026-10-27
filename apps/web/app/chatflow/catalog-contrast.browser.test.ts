/** Real Chrome and real components; static props and a synthetic fetch only.
 * No server, database, device or model. MET-214: muted words on automation
 * tasks, workspace files, references and employee details stay readable. */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const root = fileURLToPath(new URL('../../../../', import.meta.url));

suite('muted words stay readable in both themes', { timeout: 60_000 }, () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(resolve(root, 'package.json'));
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: [resolve(root, 'apps/web/test/catalog-contrast-page.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      alias: {
        '@allrice/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      },
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"development"',
        'process.env': '{}',
      },
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
          '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/catalog-contrast-page.css"><div id="root"></div><script type="module" src="/catalog-contrast-page.js"></script>',
        );
      }
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
  }, 60_000);
  // Closing real Chrome can take over 10 seconds on macOS.
  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  /** Contrast of the text (or its placeholder) against everything painted
   * behind it, translucent layers composited up to the first opaque one. */
  const contrast = (node: Locator, pseudo?: '::placeholder') =>
    node.evaluate((element, pseudo) => {
      const parse = (value: string) => {
        const n = value.match(/[\d.]+/g)!.map(Number);
        // Chrome reports color-mix() results as color(srgb r g b / a), 0–1.
        const scale = value.startsWith('color(') ? 255 : 1;
        return [n[0]! * scale, n[1]! * scale, n[2]! * scale, n[3] ?? 1];
      };
      const over = (top: number[], ground: number[]) =>
        ground.map((c, i) => top[i]! * top[3]! + c * (1 - top[3]!));
      const layers: number[][] = [];
      for (let at: Element | null = element; at; at = at.parentElement) {
        const fill = parse(getComputedStyle(at).backgroundColor);
        if (fill[3]) layers.push(fill);
        if (fill[3] === 1) break;
      }
      let ground = [255, 255, 255];
      for (const layer of layers.reverse()) ground = over(layer, ground);
      const ink = over(
        parse(getComputedStyle(element, pseudo ?? null).color),
        ground,
      );
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [x, y] = [luminance(ink), luminance(ground)].sort((m, n) => n - m);
      return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
    }, pseudo);

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'] as const)
      it(`reads at ${width}px in the ${theme} theme`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          timezoneId: 'Asia/Shanghai',
        });
        const ratios: Record<string, number> = {};
        const readable = async (
          name: string,
          node: Locator,
          pseudo?: '::placeholder',
        ) => {
          await node.waitFor();
          ratios[name] = await contrast(node, pseudo);
          // Soft, so one run lists every weak word, not just the first.
          expect.soft(ratios[name], name).toBeGreaterThanOrEqual(4.5);
        };
        const open = async (name: string) => {
          await page.goto(`${origin}/?case=${name}&theme=${theme}`);
          expect(
            await page.evaluate(() =>
              document.body.hasAttribute('data-ds-dark-theme'),
            ),
          ).toBe(theme === 'dark');
        };
        const fits = async (name: string) =>
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth,
            ),
            `${name} scrolls sideways`,
          ).toBe(false);
        try {
          await automation(page, open, readable);
          await fits('automation');
          await files(page, open, readable);
          await fits('files');
          await open('references');
          await readable(
            'D06 查找资料',
            page.getByRole('textbox', { name: '查找参考资料' }),
            '::placeholder',
          );
          await fits('references');
          await save(page, open, readable);
          await fits('save');
          await employee(page, open, readable);
          await fits('employee');
          await forms(page, open, readable);
          await fits('forms');
          await admin(page, open, readable);
          await shared(page, open, readable);
          await fits('shared');
          if (process.env.ALLRICE_RUN_CONTRAST_REPORT)
            console.log(`${width} ${theme}`, JSON.stringify(ratios));
        } finally {
          await page.close();
        }
      });

  type Open = (name: string) => Promise<void>;
  type Readable = (
    name: string,
    node: Locator,
    pseudo?: '::placeholder',
  ) => Promise<void>;

  async function automation(page: Page, open: Open, readable: Readable) {
    await open('automation');
    const row = page.getByRole('button', { name: /每日工作提醒 40/ });
    const detail = page.getByRole('region', {
      name: '自动化任务详情：每日工作提醒 40',
    });
    await readable(
      'D04 搜索框',
      page.getByRole('textbox', { name: '搜索自动化任务' }),
      '::placeholder',
    );
    await readable(
      'L08 列表说明',
      page.getByText('统一管理各位 AI 员工的任务。', { exact: false }),
    );
    await readable('L08 列表状态', row.getByText('已启用', { exact: true }));
    await readable(
      'L08 详情未选中标签',
      detail.getByRole('tab', { name: '任务运行记录' }),
    );
    await readable('L08 详情状态', detail.getByText('已启用', { exact: true }));
    await readable('L08 详情说明', detail.getByText(/^Rice · 下次运行/));
    await readable(
      'L08 规则说明',
      detail.getByText('按所选时区执行。', { exact: false }),
    );
    await detail.getByRole('tab', { name: '任务运行记录' }).click();
    await readable(
      'L08 运行记录时区',
      detail.getByText('以下时间为北京时间。', { exact: true }),
    );
    await readable(
      'L08 运行记录状态',
      detail.getByText('已完成', { exact: true }),
    );
    await readable('L08 规则标签', detail.getByRole('tab', { name: '规则' }));
    const taskLink = page.getByRole('button', { name: '查看任务' });
    await readable('L08 查看任务', taskLink);
    await taskLink.hover();
    await readable('L08 查看任务悬停', taskLink);
  }

  async function files(page: Page, open: Open, readable: Readable) {
    await open('files');
    const row = page.getByRole('button', {
      name: '十月经营周报.md',
      exact: true,
    });
    await readable(
      'D05 查找文件',
      page.getByRole('searchbox', { name: '查找文件' }),
      '::placeholder',
    );
    for (const tab of ['交付成果', '参考资料'])
      await readable(
        `L09 未选中分类 ${tab}`,
        page.getByRole('button', { name: tab, exact: true }),
      );
    await readable('L09 文件信息', row.locator('small'));
    await readable('L09 仅自己', row.getByText('仅自己', { exact: true }));
    await page.getByRole('button', { name: '上传', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上传文件' });
    for (const words of [
      '文档、图片、表格与其他工作文件',
      '仅你自己可见。',
      '在后续工作中按需查找使用。',
      '共享这份文件，不公开原聊天。',
    ])
      await readable(`上传说明 ${words}`, dialog.getByText(words));
    await dialog.locator('input[type="file"]').setInputFiles({
      name: '会议纪要.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('纪要'),
    });
    await readable(
      '上传按钮',
      dialog.getByRole('button', { name: '上传文件' }),
    );
    await dialog.getByRole('button', { name: '取消' }).click();
    await page
      .getByRole('searchbox', { name: '查找文件' })
      .fill('不存在的文件');
    await readable(
      '空结果',
      page.getByText('没有找到匹配的文件。', { exact: true }),
    );
  }

  async function save(page: Page, open: Open, readable: Readable) {
    await open('save');
    await page.getByRole('button', { name: '保存为参考资料' }).click();
    const dialog = page.getByRole('dialog', { name: '保存为参考资料' });
    await readable(
      'L10 保存说明',
      dialog.getByText('保存当前文件，后续修改不会覆盖这份参考资料。'),
    );
    await readable(
      'L10 范围说明',
      dialog.getByText('仅自己可以查看。', { exact: false }),
    );
    await readable(
      'L10 用途占位',
      dialog.getByRole('textbox', { name: '参考资料用途' }),
      '::placeholder',
    );
    const submit = dialog.getByRole('button', { name: '保存', exact: true });
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await submit.click();
    await dialog.getByRole('status').waitFor();
    await readable(
      'L10 保存成功说明',
      dialog.getByText('保留这份成果内容；重复保存会返回已有资料。'),
    );
  }

  async function employee(page: Page, open: Open, readable: Readable) {
    await open('employee');
    const tab = (name: string) => page.getByRole('tab', { name });
    await tab('执行要求').waitFor();
    for (const name of ['执行流程', '参考资料', '经验积累'])
      await readable(`D08 未选中标签 ${name}`, tab(name));
    await readable('D08 平台继承', page.getByText('平台继承', { exact: true }));
    await readable('D08 来源与版本', page.getByText('查看来源与版本'));
    await page.getByText('查看来源与版本').click();
    await readable('D08 来源版本', page.getByText(/^来源版本：/));
    await page.getByRole('button', { name: '每周对账' }).click();
    await readable(
      'D08 场景说明',
      page.getByText('每周收到流水后', { exact: true }),
    );
    await tab('执行流程').click();
    await readable('D08 执行要求标签', tab('执行要求'));
    for (const words of [
      '用文字说明工作方法，由 AI 结合当前任务灵活执行。',
      '将固定业务流程写成程序，由系统按预设规则执行。',
      '暂无已绑定的可执行工作流。',
      '已生效',
    ])
      await readable(
        `D08 流程 ${words}`,
        page.getByText(words, { exact: true }),
      );
    await tab('参考资料').click();
    await readable(
      '员工资料链接',
      page.getByRole('button', { name: '核对样例.md' }),
    );
  }

  /** The colour the shared rule paints, resolved on this page. */
  const token = (page: Page) =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ar-text-placeholder)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
  const placeholder = (field: Locator) =>
    field.evaluate(
      (element) => getComputedStyle(element, '::placeholder').color,
    );

  async function forms(page: Page, open: Open, readable: Readable) {
    await open('forms');
    await readable(
      '员工名字占位',
      page.getByRole('textbox', { name: '员工名字' }),
      '::placeholder',
    );
    await readable(
      '品牌资料占位',
      page.getByRole('textbox', { name: '目标受众' }),
      '::placeholder',
    );
  }

  async function admin(page: Page, open: Open, readable: Readable) {
    await open('admin');
    // A field inside the admin console's own palette keeps the browser's.
    const own = page.getByRole('textbox', { name: '管理后台输入框' });
    await own.waitFor();
    expect(await placeholder(own)).not.toBe(await token(page));
    // Its platform reference library is portaled to <body>, outside that
    // palette, so the shared rule paints it.
    await page.getByRole('button', { name: '管理平台参考资料' }).click();
    const field = page.getByRole('textbox', { name: '查找参考资料' });
    await readable('后台平台参考资料', field, '::placeholder');
    expect(
      await field.evaluate((element) => !element.closest('[data-admin-theme]')),
    ).toBe(true);
    expect(await placeholder(field)).toBe(await token(page));
  }

  async function shared(page: Page, open: Open, readable: Readable) {
    await open('shared');
    const field = page.getByRole('textbox', { name: '员工端输入框' });
    await readable('共用占位规则', field, '::placeholder');
    expect(await placeholder(field)).toBe(await token(page));
    // A component's own rule still wins: :where() keeps the shared one at
    // (0,0,1), under auth.css's (0,2,2) login placeholder.
    expect(await placeholder(page.getByPlaceholder('输入你的账号'))).toBe(
      'rgb(123, 132, 145)',
    );
  }
});
