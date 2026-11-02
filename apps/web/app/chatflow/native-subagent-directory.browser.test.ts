import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChatFlowEventEnvelope,
  NativeSubagentSummary,
} from '@allrice/contracts';
import {
  NativeSubagentFixtureFeed,
  snapshotFor,
} from '../../test/native-subagent-fixture-feed';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
function child(
  id: string,
  parentId: string,
  overrides: Partial<Child> = {},
): Child {
  return {
    kind: 'child',
    id,
    parentId,
    depth: 1,
    mode: 'continuable',
    label: id,
    running: false,
    activity: 'running',
    observation: { source: 'live', cursor: 8 },
    title: `${id} 自有标题`,
    task: `${id} 自己的初始任务`,
    timing: {
      settledMs: 2000,
      active: { since: 1000, through: 4000 },
      lastTurnCompleted: true,
    },
    usage: {
      uncachedInputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      outputTokens: 40,
    },
    lastReply: `${id} 自己的最后回复`,
    ...overrides,
  };
}
function summary(rootId = 'native-root'): NativeSubagentSummary {
  const prefix = rootId === 'native-root' ? '' : `${rootId}:`;
  return {
    rootId,
    root: { source: 'live', cursor: 10 },
    descendants: [
      child('fork-a', rootId, { running: true, timing: { settledMs: 0 } }),
      child('idle-b', rootId),
      child('grandchild', 'fork-a', { depth: 2, running: true }),
    ].map((entry) => ({
      ...entry,
      id: prefix + entry.id,
      parentId: entry.parentId === rootId ? rootId : prefix + entry.parentId,
    })),
  };
}

suite('native subagent directory and employee sidebar', () => {
  let browser: Browser, server: Server, origin: string;
  const feed = new NativeSubagentFixtureFeed();
  const uploads = new Set<ServerResponse>();
  const posts: { path: string; version: string }[] = [];
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/native-subagent-page.tsx'],
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
    const globals = await build({
      stdin: {
        contents: [
          ...readFileSync('apps/web/app/layout.tsx', 'utf8').matchAll(
            /^import '([^']+\.css)';$/gm,
          ),
        ]
          .map((match) => `@import '${match[1]}';`)
          .join('\n'),
        resolveDir: resolve('apps/web/app'),
        loader: 'css',
      },
      bundle: true,
      write: false,
    });
    assets.set('/layout.css', globals.outputFiles[0]!.contents);
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        posts.push({ path: req.url!, version: req.httpVersion });
        if (req.url?.endsWith('/attachments')) {
          uploads.add(res);
          res.once('close', () => uploads.delete(res));
        } else res.writeHead(204).end();
        return;
      }
      if (feed.handle(req, res)) return;
      const path = new URL(req.url!, origin).pathname,
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
          '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/layout.css"><link rel="stylesheet" href="/native-subagent-page.css"><div id="root"></div><script type="module" src="/native-subagent-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    feed.attach(server);
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
    await feed.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  async function open(
    value = summary(),
    width = 1200,
    fullReply?: { gate: Promise<void>; delivered: () => void },
    snapshot?: typeof snapshotFor,
    search = '',
    initial?: { kind: 'error' | 'null'; gate?: Promise<void> },
  ) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const calls: { id: string; liveOnly: boolean }[] = [];
    let response: NativeSubagentSummary | 'error' = value;
    const fixture = feed.register({
      summary: (id) => (id === 'parent-b' ? summary('other-root') : response),
      snapshot,
    });
    let initialDelivered = 0;
    if (initial?.gate)
      await page.addInitScript(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) =>
          fetch(
            input,
            String(input).includes('/subagents?') &&
              !String(input).includes('follow=true')
              ? { ...init, signal: undefined }
              : init,
          );
      });
    await page.route('**/api/v1/runs/*/events?**', (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('fixture', fixture);
      return route.continue({ url: String(url) });
    });
    await page.route('**/api/v1/sessions/*/subagents?**', async (route) => {
      const url = new URL(route.request().url()),
        id = url.pathname.split('/')[4]!,
        liveOnly = url.searchParams.get('liveOnly') === 'true';
      calls.push({ id, liveOnly });
      expect(route.request().headers()['x-allrice-organization-id']).toBe(
        'org',
      );
      if (
        initial &&
        id === 'parent-a' &&
        calls.filter((call) => call.id === id).length <= 1
      ) {
        await initial.gate;
        await route.fulfill(
          initial.kind === 'error'
            ? { status: 503, json: { error: 'unavailable' } }
            : { json: { summary: null } },
        );
        initialDelivered += 1;
        return;
      }
      if (response === 'error')
        return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      const read =
        id === 'parent-c' && liveOnly && !search.includes('transport-pressure')
          ? null
          : id === 'parent-b'
            ? summary('other-root')
            : liveOnly && response.root.source === 'prepared'
              ? null
              : response;
      if (!liveOnly) await fullReply?.gate;
      await route.fulfill({ json: { summary: read } });
      if (!liveOnly) fullReply?.delivered();
    });
    await feed.bindPage(page, origin, fixture);
    await page.goto(origin + search);
    await page.getByRole('heading', { level: 1 }).waitFor();
    if (!fullReply && !initial?.gate && value.descendants.length)
      await page
        .getByRole('button', {
          name: initial ? '子智能体读取失败' : /个子智能体/,
        })
        .waitFor();
    return {
      page,
      calls,
      followCalls: () => feed.calls.filter((call) => call.fixture === fixture),
      fixture,
      initialDelivered: () => initialDelivered,
      setResponse: (next: NativeSubagentSummary | 'error') => {
        response = next;
      },
    };
  }
  async function capture(page: Page, name: string) {
    const directory = join(process.cwd(), '.local', 'met214-subagent-entry');
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}.png`) });
  }

  it.each([1440, 390])(
    '“看看直属子任务”：five header states match the reference at %s px',
    async (width) => {
      const empty = summary();
      empty.descendants = [];
      const blank = await open(empty, width);
      try {
        await expect
          .poll(() => blank.calls.filter((c) => c.id === 'parent-a').length)
          .toBe(1);
        const trigger = blank.page.locator('button[aria-haspopup="tree"]');
        await trigger.waitFor();
        expect(await trigger.innerText()).toBe('');
        expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(
          0,
        );
        expect(
          await blank.page
            .getByText('子智能体状态未知', { exact: true })
            .count(),
        ).toBe(0);
        await trigger.click();
        await blank.page.getByText('暂无子智能体', { exact: true }).waitFor();
        await capture(blank.page, `${width}-zero`);
      } finally {
        await blank.page.close();
      }
      const ended = summary();
      ended.descendants = ended.descendants.map((entry) => ({
        ...entry,
        running: entry.depth > 1,
        timing: { settledMs: 18000, lastTurnCompleted: true },
      }));
      const { page, calls, fixture, setResponse } = await open(ended, width);
      const trigger = page.locator('button[aria-haspopup="tree"]');
      try {
        expect(await trigger.innerText()).toBe('');
        expect(
          await trigger.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(37, 99, 235)');
        expect(await trigger.locator('svg').getAttribute('aria-hidden')).toBe(
          'true',
        );
        expect(await trigger.locator('[data-state="ongoing"]').count()).toBe(0);
        const badge = trigger.locator('span[aria-hidden="true"]');
        expect(await badge.count()).toBe(0);
        const files = page.getByRole('button', {
          name: '工作区文件，33 项新增',
          exact: true,
        });
        const colors = await files.locator('span').evaluate((node) => {
          const style = getComputedStyle(node);
          return [
            style.backgroundColor,
            style.color,
            style.borderTopColor,
            style.borderTopWidth,
          ];
        });
        expect(colors).toEqual([
          'rgb(228, 228, 231)',
          'rgb(82, 82, 91)',
          'rgb(255, 255, 255)',
          '2px',
        ]);
        expect(
          await files
            .locator('span')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ).toBe(colors[0]);
        expect(
          await page
            .getByRole('button', { name: '经验管理，1 项新增', exact: true })
            .locator('span')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ).toBe(colors[0]);
        expect((await trigger.boundingBox())!.x).toBeLessThan(
          (await files.boundingBox())!.x,
        );
        await capture(page, `${width}-ended`);
        await trigger.click();
        const done = page
          .getByRole('button', { name: '查看idle-b摘要' })
          .locator('[data-state="done"]');
        expect(
          await done.evaluate((node) => getComputedStyle(node).color),
        ).toBe(
          await page.evaluate(() => {
            const marker = document.createElement('span');
            marker.style.color = 'var(--dsw-alias-state-idle-primary)';
            document.body.append(marker);
            const color = getComputedStyle(marker).color;
            marker.remove();
            return color;
          }),
        );
        await page.getByRole('button', { name: '展开fork-a' }).click();
        await page
          .getByRole('button', { name: '查看grandchild摘要' })
          .waitFor();
        expect(await trigger.innerText()).toBe('');
        expect(await badge.count()).toBe(0);
        await page.getByRole('button', { name: '收起fork-a' }).click();
        await page.keyboard.press('Escape');
        await page.clock.install({ time: new Date(10000) });
        const live = {
          ...ended,
          descendants: ended.descendants.map((entry) =>
            entry.id === 'fork-a'
              ? {
                  ...entry,
                  running: true,
                  timing: {
                    settledMs: 0,
                    active: { since: 9000, through: 9500 },
                  },
                }
              : entry,
          ),
        };
        feed.push(fixture, { type: 'directory', summary: live });
        await expect
          .poll(() =>
            badge.evaluate((node) => getComputedStyle(node).backgroundColor),
          )
          .toBe('rgb(34, 197, 94)');
        expect(await trigger.innerText()).toBe('1');
        expect(await trigger.locator('[data-state="ongoing"]').count()).toBe(0);
        expect(
          await badge.evaluate((node) => getComputedStyle(node).color),
        ).toBe('rgb(255, 255, 255)');
        expect(
          await files
            .locator('span')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ).toBe(colors[0]);
        const geometry = await badge.evaluate((node) => {
          const bounds = node.getBoundingClientRect(),
            button = node.closest('button')!.getBoundingClientRect();
          const actions = node
            .closest('header')!
            .querySelector('div[class*="conversationActions"]')!
            .getBoundingClientRect();
          return {
            right: button.right - bounds.right,
            top: bounds.top - button.top,
            clipped: bounds.top < actions.top || bounds.right > actions.right,
          };
        });
        expect(geometry).toEqual({
          right: -3,
          top: -3,
          clipped: false,
        });
        await capture(page, `${width}-running`);
        await trigger.click();
        expect(
          await trigger.evaluate(
            (node) => getComputedStyle(node).backgroundColor,
          ),
        ).toBe('rgb(238, 242, 255)');
        expect(
          await badge.evaluate(
            (node) => getComputedStyle(node).backgroundColor,
          ),
        ).toBe('rgb(34, 197, 94)');
        const liveRow = page.getByRole('button', { name: '查看fork-a摘要' });
        await expect.poll(() => liveRow.innerText()).toContain('1 秒');
        const readsBeforeClock = calls.length;
        await page.clock.runFor(2000);
        await expect.poll(() => liveRow.innerText()).toContain('3 秒');
        expect(calls.length).toBe(readsBeforeClock);
        expect(
          await liveRow
            .locator('[data-state="ongoing"]')
            .evaluate((node) => getComputedStyle(node).backgroundColor),
        ).not.toBe('rgba(0, 0, 0, 0)');
        expect(
          await liveRow
            .locator('[data-state="ongoing"] g')
            .evaluate((node) => getComputedStyle(node).display),
        ).toBe('none');
        await capture(page, `${width}-expanded`);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
        setResponse('error');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page
          .getByRole('button', { name: '子智能体读取失败', exact: true })
          .waitFor();
        expect(await trigger.innerText()).toBe('!');
        expect(await trigger.locator('[data-state="ongoing"]').count()).toBe(0);
        const failure = await badge.evaluate((node) => ({
          color: getComputedStyle(node).color,
          background: getComputedStyle(node).backgroundColor,
          border: getComputedStyle(node).borderTopColor,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        }));
        expect(failure.color).toBe('rgb(255, 255, 255)');
        expect(failure.border).toBe('rgb(255, 255, 255)');
        const [red, green, blue] = failure.background
          .match(/\d+/g)!
          .map(Number);
        expect(red! > green! + 40 && red! > blue! + 40).toBe(true);
        expect(failure.width).toBe(failure.height);
        await capture(page, `${width}-error`);
        const cold = {
          ...ended,
          root: { source: 'prepared' as const, cursor: 10 },
          descendants: ended.descendants.map((entry) => ({
            ...entry,
            running: null,
            activity: 'unknown' as const,
            observation: { source: 'prepared' as const, cursor: 8 },
          })),
        };
        setResponse(cold);
        if ((await trigger.getAttribute('aria-expanded')) !== 'true')
          await trigger.click();
        await page
          .getByRole('button', { name: '刷新子智能体摘要', exact: true })
          .click();
        await expect
          .poll(() => trigger.getAttribute('aria-label'))
          .toBe('2 个子智能体');
        expect(await trigger.innerText()).toBe('');
        expect(await badge.count()).toBe(0);
        expect(await trigger.getAttribute('aria-expanded')).toBe('true');
        expect(
          await page
            .getByRole('button', { name: '查看idle-b摘要' })
            .innerText(),
        ).toContain('历史记录 · 上次回合已完成');
        await capture(page, `${width}-unknown`);
        expect(
          calls.filter((c) => !c.liveOnly).every((c) => c.id === 'parent-a'),
        ).toBe(true);
      } catch (error) {
        await capture(page, `${width}-failure`);
        throw error;
      } finally {
        await page.close();
      }
    },
  );

  it.each(['refresh', 'resync', 'empty'] as const)(
    'keeps the entry and open status reachable through %s, then honors Escape',
    async (transition) => {
      const { page, fixture } = await open();
      let release = () => {};
      try {
        await expect
          .poll(() =>
            [...feed.connections].some(
              (c) =>
                c.fixture === fixture &&
                c.sessionId === 'parent-a' &&
                !c.childId,
            ),
          )
          .toBe(true);
        const trigger = page.locator('button[aria-haspopup="tree"]');
        const tree = page.getByRole('tree', { name: '子智能体目录' });
        await trigger.click();
        await tree.waitFor();
        if (transition === 'refresh') {
          const gate = new Promise<void>((done) => {
            release = done;
          });
          await page.route(
            '**/api/v1/sessions/parent-a/subagents?**',
            async (route) => {
              if (
                new URL(route.request().url()).searchParams.get('liveOnly') !==
                'true'
              )
                await gate;
              await route.fallback();
            },
          );
          await page.getByRole('button', { name: '刷新子智能体摘要' }).click();
        } else {
          await page.getByRole('button', { name: '查看fork-a摘要' }).focus();
          if (transition === 'resync')
            feed.push(fixture, { type: 'clear', reason: 'resync' });
          else
            feed.push(fixture, {
              type: 'directory',
              summary: { ...summary(), descendants: [] },
            });
        }
        await expect
          .poll(() => trigger.locator('span[aria-hidden="true"]').count())
          .toBe(0);
        expect(await trigger.count()).toBe(1);
        expect(await trigger.getAttribute('aria-expanded')).toBe('true');
        expect(await tree.count()).toBe(0);
        await page
          .getByText(
            transition === 'refresh'
              ? '正在读取子智能体摘要…'
              : transition === 'resync'
                ? '当前活动状态未知，请重新读取摘要。'
                : '暂无子智能体',
            { exact: true },
          )
          .waitFor();
        await page.keyboard.press('Escape');
        expect(
          await page.evaluate(
            () => document.activeElement?.closest('[hidden]') !== null,
          ),
        ).toBe(false);
        if (transition === 'refresh') release();
        else feed.push(fixture, { type: 'directory', summary: summary() });
        await expect
          .poll(() => trigger.getAttribute('aria-label'))
          .toBe('2 个子智能体 · 1 个运行中');
        expect(await trigger.getAttribute('aria-expanded')).toBe('false');
        expect(await tree.count()).toBe(0);
        await trigger.click();
        await tree.waitFor();
        await page.keyboard.press('Escape');
        expect(
          await trigger.evaluate((node) => node === document.activeElement),
        ).toBe(true);
      } finally {
        release();
        await page.close();
      }
    },
  );

  it('keeps selected detail open and withdraws stale process when the catalog removes its child', async () => {
    const { page, fixture } = await open(
      summary(),
      1200,
      undefined,
      ownProcess,
    );
    try {
      const detail = await selectChild(page);
      const trigger = page.locator('button[aria-haspopup="tree"]');
      await trigger.click();
      await page.getByRole('tree', { name: '子智能体目录' }).waitFor();
      feed.push(fixture, {
        type: 'directory',
        summary: { ...summary(), descendants: [] },
      });
      await expect.poll(() => trigger.isVisible()).toBe(false);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(0);
      expect(await detail.isVisible()).toBe(true);
      const text = await detail.innerText();
      expect(text).toContain('fork-a');
      expect(text).toContain('当前活动状态未知，请重新读取摘要。');
      expect(text).not.toContain('fork-a 中途基线');
      expect(
        await detail
          .getByRole('button', { name: '刷新子智能体摘要' })
          .isVisible(),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('omits idle counts and keeps running and error badge borders white in dark mode', async () => {
    const value = summary();
    value.descendants = value.descendants.map((entry) => ({
      ...entry,
      running: false,
    }));
    const { page, fixture, setResponse } = await open(value);
    try {
      const lightBase = await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base'),
      );
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.setAttribute('data-ds-dark-theme', '');
      });
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.body).getPropertyValue(
            '--dsw-alias-bg-base',
          ),
        ),
      ).not.toBe(lightBase);
      const trigger = page.locator('button[aria-haspopup="tree"]');
      const badge = trigger.locator('span[aria-hidden="true"]');
      expect(await badge.count()).toBe(0);
      for (const button of [
        page.getByRole('button', {
          name: '工作区文件，33 项新增',
          exact: true,
        }),
        page.getByRole('button', { name: '经验管理，1 项新增', exact: true }),
      ]) {
        expect(
          await button.locator('span[aria-hidden="true"]').evaluate((node) => {
            const style = getComputedStyle(node);
            return [style.backgroundColor, style.color, style.borderTopColor];
          }),
        ).toEqual([
          'rgb(228, 228, 231)',
          'rgb(82, 82, 91)',
          'rgb(255, 255, 255)',
        ]);
      }
      await expect
        .poll(() =>
          [...feed.connections].some(
            (c) =>
              c.fixture === fixture && c.sessionId === 'parent-a' && !c.childId,
          ),
        )
        .toBe(true);
      feed.push(fixture, { type: 'directory', summary: summary() });
      await expect
        .poll(() =>
          badge.evaluate((node) => getComputedStyle(node).backgroundColor),
        )
        .toBe('rgb(34, 197, 94)');
      expect(
        await badge.evaluate((node) => getComputedStyle(node).borderTopColor),
      ).toBe('rgb(255, 255, 255)');
      await capture(page, 'dark-running');
      setResponse('error');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page
        .getByRole('button', { name: '子智能体读取失败', exact: true })
        .waitFor();
      expect(
        await badge.evaluate((node) => getComputedStyle(node).borderTopColor),
      ).toBe('rgb(255, 255, 255)');
      expect(await badge.innerText()).toBe('!');
      await capture(page, 'dark-error');
    } finally {
      await page.close();
    }
  });

  it('updates an expanded descendant elapsed time without counting its running state in the header', async () => {
    const value = summary();
    value.descendants = value.descendants.map((entry) => ({
      ...entry,
      running: entry.depth > 1,
      timing:
        entry.depth > 1
          ? { settledMs: 0, active: { since: 9000, through: 9500 } }
          : { settledMs: 18000, lastTurnCompleted: true },
    }));
    const { page, calls } = await open(value);
    try {
      await page.clock.install({ time: new Date(10000) });
      const trigger = page.locator('button[aria-haspopup="tree"]');
      await trigger.click();
      await page.getByRole('button', { name: '展开fork-a' }).click();
      const descendant = page.getByRole('button', {
        name: '查看grandchild摘要',
      });
      await expect.poll(() => descendant.innerText()).toContain('1 秒');
      const reads = calls.length;
      await page.clock.runFor(2000);
      await expect.poll(() => descendant.innerText()).toContain('3 秒');
      expect(calls.length).toBe(reads);
      expect(await trigger.getAttribute('aria-label')).toBe('2 个子智能体');
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      await capture(page, 'expanded-descendant');
    } finally {
      await page.close();
    }
  });

  it('records every header transition through normal completion and a prepared EOF tail read without flashing an error', async () => {
    const { page, calls, fixture, setResponse } = await open();
    let release = () => {};
    try {
      await expect
        .poll(() =>
          [...feed.connections].some(
            (c) =>
              c.fixture === fixture && c.sessionId === 'parent-a' && !c.childId,
          ),
        )
        .toBe(true);
      const connection = [...feed.connections].find(
        (c) =>
          c.fixture === fixture && c.sessionId === 'parent-a' && !c.childId,
      )!;
      const trigger = page.locator('button[aria-haspopup="tree"]');
      const trace = await trigger.evaluateHandle((node) => {
        const states: string[] = [];
        const scope = node.closest('header')!;
        const record = () => {
          const button = scope.querySelector('button[aria-haspopup="tree"]');
          states.push(button?.getAttribute('aria-label') ?? 'hidden');
          if (button?.textContent === '!') states.push('!');
        };
        const observer = new MutationObserver((records) => {
          for (const mutation of records)
            if (mutation.attributeName === 'aria-label' && mutation.oldValue)
              states.push(mutation.oldValue);
          record();
        });
        observer.observe(scope, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeOldValue: true,
        });
        record();
        return {
          stop: () => {
            record();
            observer.disconnect();
            return states;
          },
        };
      });
      const settled = summary();
      settled.descendants = settled.descendants.map((entry) => ({
        ...entry,
        running: false,
        timing: { settledMs: 18000, lastTurnCompleted: true },
      }));
      feed.send(connection, { type: 'directory', summary: settled });
      await expect
        .poll(() => trigger.getAttribute('aria-label'))
        .toBe('2 个子智能体');
      setResponse({
        ...settled,
        root: { source: 'prepared', cursor: 11 },
        descendants: settled.descendants.map((entry) => ({
          ...entry,
          running: null,
          activity: 'unknown',
          observation: { source: 'prepared', cursor: 9 },
        })),
      });
      let tailRequested = false;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      await page.route(
        '**/api/v1/sessions/parent-a/subagents?**',
        async (route) => {
          if (
            new URL(route.request().url()).searchParams.get('liveOnly') !==
            'true'
          ) {
            tailRequested = true;
            await gate;
          }
          await route.fallback();
        },
      );
      connection.response.end();
      await expect.poll(() => tailRequested).toBe(true);
      await expect
        .poll(() => trigger.getAttribute('aria-label'))
        .toBe('子智能体');
      expect(await trigger.count()).toBe(1);
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      release();
      await expect
        .poll(() => trigger.getAttribute('aria-label'))
        .toBe('2 个子智能体');
      const states = await trace.evaluate((value) => value.stop());
      const directory = join(process.cwd(), '.local', 'met214-subagent-entry');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'normal-EOF-transitions.json'),
        JSON.stringify({ states, calls }, null, 2),
      );
      expect(states).toContain('2 个子智能体 · 1 个运行中');
      expect(states).toContain('子智能体');
      expect(states).not.toContain('hidden');
      expect(states.at(-1)).toBe('2 个子智能体');
      expect(
        states.some((state) => state.includes('读取失败') || state === '!'),
      ).toBe(false);
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      expect(calls.filter((call) => call.id === 'parent-a')).toHaveLength(2);
      await capture(page, 'normal-EOF');
    } finally {
      release();
      await page.close();
    }
  });

  it.each(['resync', 'unavailable', 'EOF-prepared', 'EOF-live'] as const)(
    '“运行结束别变未知”：handles %s without preserving stale activity or inventing completion',
    async (transition) => {
      const { page, calls, fixture, setResponse } = await open();
      try {
        const trigger = page.locator('button[aria-haspopup="tree"]');
        await expect
          .poll(
            () =>
              [...feed.connections].filter(
                (c) =>
                  c.fixture === fixture &&
                  c.sessionId === 'parent-a' &&
                  !c.childId,
              ).length,
          )
          .toBe(1);
        const connection = [...feed.connections].find(
          (c) =>
            c.fixture === fixture && c.sessionId === 'parent-a' && !c.childId,
        )!;
        const prepared = summary();
        prepared.root.source = 'prepared';
        prepared.descendants = prepared.descendants.map((entry) => ({
          ...entry,
          running: null,
          activity: 'unknown',
          observation: { source: 'prepared', cursor: 8 },
        }));
        if (transition === 'resync') {
          feed.send(connection, { type: 'clear', reason: 'resync' });
          await expect.poll(() => trigger.isVisible()).toBe(false);
          const next = summary();
          next.descendants = next.descendants.map((entry) => ({
            ...entry,
            running: false,
          }));
          feed.send(connection, { type: 'directory', summary: next });
          await expect
            .poll(() => trigger.getAttribute('aria-label'))
            .toBe('2 个子智能体');
          expect(connection.response.writableEnded).toBe(false);
          expect(calls.filter((c) => c.id === 'parent-a')).toHaveLength(1);
        } else {
          setResponse(transition === 'EOF-live' ? summary() : prepared);
          if (transition === 'unavailable') {
            feed.send(connection, { type: 'clear', reason: 'unavailable' });
            feed.send(connection, { type: 'directory', summary: summary() });
          } else connection.response.end();
          await expect
            .poll(() => calls.filter((c) => c.id === 'parent-a').length)
            .toBe(2);
          if (transition === 'EOF-live') {
            await page
              .getByRole('button', { name: '子智能体读取失败', exact: true })
              .waitFor();
            await trigger.click();
            expect(await page.getByRole('alert').innerText()).toContain(
              '实时观察已断开，重试',
            );
            await page
              .getByRole('button', { name: '刷新子智能体摘要', exact: true })
              .click();
            await expect
              .poll(() => trigger.getAttribute('aria-label'))
              .toBe('2 个子智能体 · 1 个运行中');
          } else {
            await expect
              .poll(() => trigger.getAttribute('aria-label'))
              .toBe('2 个子智能体');
            expect(
              await trigger.locator('[data-state="ongoing"]').count(),
            ).toBe(0);
            expect(
              await page.getByText('子智能体状态未知', { exact: true }).count(),
            ).toBe(0);
          }
        }
      } finally {
        await page.close();
      }
    },
  );

  it('“上传还没完，也要能 Stop 和回答父问题”：HTTP/1 controls arrive with four live parents and child detail', async () => {
    const { page, fixture } = await open(
      summary(),
      1200,
      undefined,
      undefined,
      '?root-events&transport-pressure',
    );
    const sockets = new Set<string>();
    // Existing observers are measured at the real upstream; new ones also
    // expose browser WebSocket ownership through close/reopen and unload.
    page.on('websocket', (socket) => {
      sockets.add(socket.url());
      socket.on('close', () => sockets.delete(socket.url()));
    });
    try {
      await page.locator('button[aria-haspopup="tree"]').click();
      await page.getByRole('button', { name: '查看fork-a摘要' }).click();
      await expect
        .poll(() => ({
          directories: [...feed.connections].filter(
            (c) => c.fixture === fixture && !c.childId,
          ).length,
          details: [...feed.connections].filter(
            (c) => c.fixture === fixture && c.childId,
          ).length,
          root: [...feed.rootConnections].filter((c) => c.fixture === fixture)
            .length,
        }))
        .toEqual({ directories: 4, details: 1, root: 1 });
      expect(
        [...feed.connections]
          .filter((c) => c.fixture === fixture && !c.childId)
          .map((c) => c.sessionId)
          .sort(),
      ).toEqual(['parent-a', 'parent-b', 'parent-c', 'parent-d']);
      await page.evaluate(() => {
        void fetch('/api/v1/sessions/parent-a/attachments', {
          method: 'POST',
          body: 'held image',
        });
      });
      await expect.poll(() => uploads.size).toBe(1);
      const before = posts.length;
      const statuses = await page.evaluate(async () =>
        Promise.all(
          [
            [
              '/api/v1/sessions/parent-a/subagents/controls',
              { kind: 'interrupt' },
            ],
            [
              '/api/v1/sessions/parent-a/messages',
              { userQuestionAnswer: { questionId: 'parent-question' } },
            ],
          ].map(
            async ([url, body]) =>
              (
                await fetch(String(url), {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(body),
                })
              ).status,
          ),
        ),
      );
      expect(statuses).toEqual([204, 204]);
      expect(
        posts
          .slice(before)
          .map((p) => p.path)
          .sort(),
      ).toEqual([
        '/api/v1/sessions/parent-a/messages',
        '/api/v1/sessions/parent-a/subagents/controls',
      ]);
      expect(posts.every((p) => p.version === '1.1')).toBe(true);
      expect(uploads.size).toBe(1);
      expect(sockets.size).toBeGreaterThan(0);
      await page.goto('about:blank');
      await expect
        .poll(
          () =>
            [...feed.connections].filter((c) => c.fixture === fixture).length,
        )
        .toBe(0);
      await expect
        .poll(
          () =>
            [...feed.rootConnections].filter((c) => c.fixture === fixture)
              .length,
        )
        .toBe(0);
      // Playwright clears its old-document socket map before late close events.
      // The server socket and upstream owners remain the resource authority.
      await expect.poll(() => feed.sockets.size).toBe(0);
    } finally {
      for (const res of uploads) res.end();
      await page.close();
    }
  }, 30_000);

  const row = (page: Page, id: string) =>
    page.locator(`[data-row-key="session:${id}"]`);
  const ownProcess: typeof snapshotFor = (value, id) => {
    const cut = snapshotFor(value, id);
    cut.rows = [
      {
        kind: 'assistant',
        seq: 5,
        turn: 0,
        step: 0,
        text: `${id} 已记录文字`,
        truncated: false,
      },
      {
        kind: 'tool',
        seq: 6,
        turn: 0,
        step: 0,
        callId: 'call-1',
        name: '读取文件',
        activityDetail: `${id} 安全路径`,
        truncated: false,
      },
    ];
    cut.stream.active = {
      text: `${id} 中途基线`,
      truncated: false,
      attemptId: 'attempt-1',
      turn: 0,
      step: 1,
      startedAfterSeq: 6,
      nextIndex: 3,
    };
    return cut;
  };
  async function selectChild(page: Page, id = 'fork-a') {
    await page.locator('button[aria-haspopup="tree"]').click();
    await page.getByRole('button', { name: `查看${id}摘要` }).click();
    const detail = page.getByRole('complementary', { name: '子智能体摘要' });
    await expect.poll(() => detail.innerText()).toContain(`${id} 中途基线`);
    return detail;
  }

  it('reads the active full catalog, probes other visible parents and expands descendants with direct header totals', async () => {
    const { page, calls } = await open();
    try {
      await expect
        .poll(() =>
          calls
            .filter((call) => call.liveOnly)
            .map((call) => call.id)
            .sort(),
        )
        .toEqual(['parent-b', 'parent-c']);
      expect(
        calls.filter((call) => !call.liveOnly).map((call) => call.id),
      ).toEqual(['parent-a']);
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .toContain('1 个子智能体运行中');
      await expect
        .poll(() => row(page, 'parent-b').innerText())
        .toContain('1 个子智能体运行中');
      expect(
        await page.getByRole('navigation', { name: '业务会话' }).innerText(),
      ).not.toMatch(/fork-a|idle-b|grandchild/);
      await row(page, 'parent-c').hover();
      await expect
        .poll(() =>
          page
            .getByRole('button', {
              name: '复制: parent-c 父级任务',
              exact: true,
            })
            .innerText(),
        )
        .toContain('子智能体当前活动状态未知');
      const trigger = page.getByRole('button', {
        name: '2 个子智能体 · 1 个运行中',
        exact: true,
      });
      await trigger.click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).waitFor();
      expect(
        calls.filter((call) => !call.liveOnly).map((call) => call.id),
      ).toEqual(['parent-a']);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).innerText(),
      ).toContain('上次回合已完成');
      await page.getByRole('button', { name: '展开fork-a' }).click();
      await page.getByRole('button', { name: '查看grandchild摘要' }).waitFor();
      expect(
        calls.filter((call) => !call.liveOnly).map((call) => call.id),
      ).toEqual(['parent-a']);
      expect(await trigger.getAttribute('aria-label')).toBe(
        '2 个子智能体 · 1 个运行中',
      );
      await page.getByRole('button', { name: '查看fork-a摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      await expect
        .poll(() => detail.innerText())
        .toContain('fork-a 自己的初始任务');
      await expect
        .poll(() => detail.innerText())
        .toContain('fork-a 自己的最后回复');
      expect(await detail.innerText()).not.toContain('父级任务');
      expect(await detail.innerText()).not.toContain('上次回合已完成');
      expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe(
        'parent-a 父级任务',
      );
      await page.keyboard.press('Escape');
      expect(await detail.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('supports hover, pinning, tree keyboard navigation and Escape across clipped header actions', async () => {
    const { page } = await open();
    try {
      const trigger = page.getByRole('button', { name: /2 个子智能体/ });
      await trigger.hover();
      await page.getByRole('tree', { name: '子智能体目录' }).waitFor();
      await page.getByRole('button', { name: '查看idle-b摘要' }).hover();
      await page.waitForTimeout(180);
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(1);
      await page.mouse.move(1100, 800);
      await expect
        .poll(() => page.getByRole('tree', { name: '子智能体目录' }).count())
        .toBe(0);
      await trigger.click();
      await page.mouse.move(1100, 800);
      await page.getByRole('tree', { name: '子智能体目录' }).waitFor();
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(1);
      const first = page.getByRole('button', { name: '查看fork-a摘要' });
      await first.focus();
      await page.keyboard.press('ArrowRight');
      const descendant = page.getByRole('button', {
        name: '查看grandchild摘要',
      });
      await descendant.waitFor();
      await page.keyboard.press('ArrowRight');
      expect(
        await descendant.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('ArrowLeft');
      expect(
        await first.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('ArrowLeft');
      expect(await descendant.count()).toBe(0);
      await page.keyboard.press('ArrowRight');
      await descendant.waitFor();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() =>
          descendant.evaluate((node) => node === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press('ArrowUp');
      await expect
        .poll(() => first.evaluate((node) => node === document.activeElement))
        .toBe(true);
      expect(await trigger.getAttribute('aria-label')).toBe(
        '2 个子智能体 · 1 个运行中',
      );
      await page.keyboard.press('End');
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: '查看idle-b摘要' })
            .evaluate((node) => node === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press('Escape');
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).count(),
      ).toBe(0);
      expect(
        await trigger.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => first.evaluate((node) => node === document.activeElement))
        .toBe(true);
      await page.keyboard.press('Escape');
    } finally {
      await page.close();
    }
  });

  it('keeps the active full observation while opening and closing a prepared child summary', async () => {
    const value = summary();
    value.descendants = value.descendants.map((entry) =>
      entry.kind === 'child'
        ? {
            ...entry,
            running: null,
            activity: 'inactive',
            observation: { source: 'prepared', cursor: 8 },
          }
        : entry,
    );
    const { page, fixture, followCalls } = await open(value);
    const active = () =>
      followCalls().filter((call) => call.sessionId === 'parent-a');
    try {
      await expect.poll(() => active().at(-1)?.liveOnly).toBe(false);
      const trigger = page.locator('button[aria-haspopup="tree"]');
      await trigger.click();
      await expect.poll(() => active().at(-1)?.liveOnly).toBe(false);
      await page.getByRole('button', { name: '查看idle-b摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      await expect
        .poll(() => detail.innerText())
        .toContain('idle-b 自己的最后回复');
      expect(await detail.innerText()).toContain('当前活动状态未知');
      expect(
        feed.calls.filter((call) => call.fixture === fixture && call.childId),
      ).toHaveLength(0);
      await page.getByRole('button', { name: '关闭摘要', exact: true }).click();
      await expect.poll(() => active().at(-1)?.liveOnly).toBe(false);
      await trigger.click();
      await expect.poll(() => active().at(-1)?.liveOnly).toBe(false);
      await page.getByRole('button', { name: '刷新子智能体摘要' }).click();
      await expect
        .poll(() => trigger.getAttribute('aria-expanded'))
        .toBe('false');
      await trigger.click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).waitFor();
      expect(active().at(-1)?.liveOnly).toBe(false);
      expect(
        followCalls()
          .filter((call) => call.sessionId !== 'parent-a')
          .every((call) => call.liveOnly),
      ).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('opens the initial loading state and keeps the entry pinned when its catalog arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const { page } = await open(summary(), 1200, {
      gate,
      delivered: () => {},
    });
    try {
      const trigger = page.locator('button[aria-haspopup="tree"]');
      const tree = page.getByRole('tree', { name: '子智能体目录' });
      expect(await trigger.count()).toBe(1);
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      expect(
        await page.getByText('子智能体状态未知', { exact: true }).count(),
      ).toBe(0);
      await trigger.click();
      await page.mouse.move(1100, 800);
      await page
        .getByRole('status')
        .filter({ hasText: '正在读取子智能体摘要…' })
        .waitFor();
      await capture(page, 'initial-loading');
      release();
      await tree.waitFor();
      expect(await trigger.getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Escape');
      expect(await tree.count()).toBe(0);
    } finally {
      release();
      await page.close();
    }
  });

  it.each(['select', 'Escape', 'outside', 'scope'])(
    'keeps a delayed initial cold read reachable and preserves the latest user intent (%s)',
    async (action) => {
      const cold = summary();
      cold.root.source = 'prepared';
      cold.descendants = cold.descendants.map((entry) => ({
        ...entry,
        running: null,
        observation: { source: 'prepared', cursor: 8 },
      }));
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const { page, calls } = await open(cold, 1200, {
        gate,
        delivered: () => {},
      });
      try {
        const trigger = page.locator('button[aria-haspopup="tree"]');
        expect(await trigger.count()).toBe(1);
        expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(
          0,
        );
        await expect
          .poll(() => calls.filter((c) => !c.liveOnly).length)
          .toBe(1);
        await trigger.click();
        await trigger.focus();
        if (action === 'select') await page.keyboard.press('ArrowDown');
        else if (action === 'Escape') await page.keyboard.press('Escape');
        else if (action === 'outside')
          await page.getByRole('heading', { level: 1 }).click();
        else if (action === 'scope') {
          await row(page, 'parent-b').focus();
          await page.keyboard.press('Enter');
        }
        release();
        await expect
          .poll(() => trigger.getAttribute('aria-label'))
          .toContain('2 个子智能体');
        if (action === 'select') {
          const first = page.getByRole('button', { name: '查看fork-a摘要' });
          await expect
            .poll(() =>
              first.evaluate((node) => node === document.activeElement),
            )
            .toBe(true);
          await page.keyboard.press('Enter');
          const detail = page.getByRole('complementary', {
            name: '子智能体摘要',
          });
          expect(await detail.innerText()).toContain('fork-a 自己的初始任务');
        } else {
          expect(await trigger.getAttribute('aria-expanded')).toBe('false');
          expect(
            await page.getByRole('tree', { name: '子智能体目录' }).count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('complementary', { name: '子智能体摘要' })
              .count(),
          ).toBe(0);
          if (action === 'scope') {
            expect(
              await page.getByRole('heading', { level: 1 }).innerText(),
            ).toBe('parent-b 父级任务');
            expect(await trigger.getAttribute('aria-label')).toContain(
              '1 个运行中',
            );
          }
        }
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.close();
      }
    },
  );

  it('keeps historical completion separate from unknown current state, freezes elapsed time and never falls back to the parent task', async () => {
    const cold = summary();
    cold.root.source = 'prepared';
    cold.descendants = cold.descendants.map((entry) => ({
      ...entry,
      running: null,
      observation: { source: 'prepared', cursor: 8 },
    }));
    (cold.descendants[1] as Child).task = undefined;
    const { page, calls } = await open(cold, 390);
    try {
      const trigger = page.locator('button[aria-haspopup="tree"]');
      await expect.poll(() => calls.length).toBe(3);
      expect(await trigger.innerText()).toBe('');
      expect(await trigger.innerText()).not.toContain('0 个运行中');
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      expect(
        calls
          .filter((call) => !call.liveOnly)
          .every((call) => call.id === 'parent-a'),
      ).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => calls.length).toBe(6);
      expect(
        calls
          .filter((call) => !call.liveOnly)
          .every((call) => call.id === 'parent-a'),
      ).toBe(true);
      await trigger.click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).waitFor();
      expect(await trigger.getAttribute('aria-label')).toBe('2 个子智能体');
      expect(calls.filter((call) => !call.liveOnly)).toHaveLength(2);
      await page.getByRole('button', { name: '查看idle-b摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      const text = await detail.innerText();
      expect(text).toContain('历史摘要 · 当前活动状态未知');
      expect(text).toContain('上次回合已完成');
      expect(text).toContain('暂无自有任务记录');
      expect(text).toContain('100 tokens · 5 秒');
      expect(text).toContain('不代表本次运行账单');
      expect(text).not.toContain('父级任务');
      await page.waitForTimeout(1100);
      expect(await detail.innerText()).toBe(text);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.keyboard.press('Escape');
      expect(await trigger.innerText()).toBe('');
      const before = calls.length;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => calls.length).toBeGreaterThan(before);
      await expect
        .poll(() => calls.filter((call) => !call.liveOnly).length)
        .toBe(3);
    } finally {
      await page.close();
    }
  });

  it('retains diagnostic nodes and clears stale running badges on errors and lost observations', async () => {
    const { page, setResponse } = await open();
    try {
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .toContain('1 个子智能体运行中');
      setResponse('error');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('button', { name: '子智能体读取失败' }).waitFor();
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .not.toContain('子智能体运行中');
      await page.getByRole('button', { name: '子智能体读取失败' }).click();
      expect(await page.getByRole('alert').innerText()).toContain(
        '暂时读不到子智能体目录',
      );
      const diagnostic: NativeSubagentSummary = {
        rootId: 'native-root',
        root: { source: 'prepared', cursor: 8 },
        descendants: [
          {
            kind: 'diagnostic',
            id: 'unsupported-child',
            parentId: 'native-root',
            depth: 1,
            reason: 'unsupported',
          },
        ],
      };
      setResponse(diagnostic);
      await page.getByRole('button', { name: '刷新子智能体摘要' }).click();
      const trigger = page.getByRole('button', { name: /1 个子智能体/ });
      await trigger.waitFor();
      if ((await trigger.getAttribute('aria-expanded')) !== 'true')
        await trigger.click();
      expect(
        await page.getByRole('tree', { name: '子智能体目录' }).innerText(),
      ).toContain('暂不支持此类型');
      expect(
        await page
          .getByRole('button', { name: '查看unsupported-child摘要' })
          .isDisabled(),
      ).toBe(true);
      expect(await trigger.innerText()).not.toContain('0 个运行中');
      expect(await trigger.locator('span[aria-hidden="true"]').count()).toBe(0);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .not.toContain('子智能体运行中');
    } finally {
      await page.close();
    }
  });

  it('opens from a hot baseline, replaces active text, clears only active:null and replaces safe tool rows', async () => {
    const value = summary(),
      { page, fixture } = await open(value, 390, undefined, ownProcess);
    try {
      const detail = await selectChild(page);
      expect(await detail.innerText()).toContain('fork-a 已记录文字');
      expect(await detail.innerText()).toContain('读取文件');
      expect(await detail.innerText()).toContain('结果尚未确认');
      const cut = ownProcess(value, 'fork-a');
      const display = {
        ...cut.stream,
        revision: 1,
        complete: false,
        active: {
          ...cut.stream.active!,
          text: '完整替换的新文字',
          truncated: true,
        },
      };
      feed.push(
        fixture,
        {
          type: 'display',
          rootId: cut.rootId,
          childId: cut.childId,
          hostEpoch: cut.hostEpoch,
          display,
        },
        'fork-a',
      );
      await expect.poll(() => detail.innerText()).toContain('完整替换的新文字');
      expect(await detail.innerText()).not.toContain('中途基线');
      expect(
        await detail.getByText('完整替换的新文字', { exact: true }).count(),
      ).toBe(1);
      expect(await detail.innerText()).toContain('截断');
      expect(await detail.innerText()).toContain('不完整');
      const screenshot = resolve('.local/met231-u2-hot-fixture.png');
      await page.screenshot({ path: screenshot });
      console.log('U2_FIXTURE_SCREENSHOT ' + screenshot);
      feed.push(
        fixture,
        {
          type: 'display',
          rootId: cut.rootId,
          childId: cut.childId,
          hostEpoch: cut.hostEpoch,
          display: { ...display, revision: 2, active: null },
        },
        'fork-a',
      );
      await expect
        .poll(() => detail.innerText())
        .not.toContain('完整替换的新文字');
      expect(await detail.innerText()).toContain('fork-a 已记录文字');
      expect(await detail.innerText()).not.toContain('暂无回复');
      cut.rows[1] = {
        kind: 'tool',
        seq: 6,
        turn: 0,
        step: 0,
        callId: 'call-1',
        name: '读取文件',
        truncated: false,
        result: { seq: 9, failed: true, summary: '安全错误摘要' },
      };
      cut.window.omittedEvents = 3;
      cut.window.omittedRows = 1;
      cut.stream.active = null;
      feed.push(fixture, { type: 'snapshot', snapshot: cut }, 'fork-a');
      await expect.poll(() => detail.innerText()).toContain('失败');
      expect(await detail.getByText('读取文件', { exact: true }).count()).toBe(
        1,
      );
      expect(await detail.innerText()).toContain('省略');
      expect(await detail.innerText()).not.toContain('安全错误摘要');
      await detail.getByText('读取文件', { exact: true }).click();
      await expect.poll(() => detail.innerText()).toContain('安全错误摘要');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('replaces rows with one nonterminal safe lastReply and clears it on EOF without guessing truncation', async () => {
    const value = summary(),
      { page, fixture } = await open(value, 1200, undefined, ownProcess);
    try {
      const detail = await selectChild(page);
      const ended = summary();
      ended.descendants = ended.descendants.map((entry) =>
        entry.kind === 'child'
          ? { ...entry, running: false, lastReply: '唯一安全最后回复' }
          : entry,
      );
      feed.push(
        fixture,
        { type: 'summary', childId: 'fork-a', summary: ended },
        'fork-a',
      );
      await expect.poll(() => detail.innerText()).toContain('唯一安全最后回复');
      expect(
        await detail.getByText('唯一安全最后回复', { exact: true }).count(),
      ).toBe(1);
      expect(await detail.innerText()).not.toMatch(
        /中途基线|已记录文字|读取文件|已确认未截断|内容完整|截断未知/,
      );
      feed.end(fixture, 'fork-a');
      await expect
        .poll(() => detail.innerText())
        .not.toContain('唯一安全最后回复');
      expect(await detail.innerText()).toContain('当前活动状态未知');
      await page.keyboard.press('Escape');
      expect(await detail.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it.each([
    'resync',
    'unavailable',
    'EOF',
    'abrupt',
    'epoch',
    'child',
    'root',
    'instance',
  ])(
    'clears stale process on %s and requires a fresh matching snapshot after resync',
    async (reason) => {
      const value = summary(),
        { page, fixture } = await open(value, 1200, undefined, ownProcess);
      try {
        const detail = await selectChild(page);
        const cut = ownProcess(value, 'fork-a');
        if (reason === 'resync' || reason === 'unavailable')
          feed.push(fixture, { type: 'clear', reason }, 'fork-a');
        else if (reason === 'EOF' || reason === 'abrupt')
          feed.end(fixture, 'fork-a', reason === 'abrupt');
        else
          feed.push(
            fixture,
            {
              type: 'display',
              rootId: reason === 'root' ? 'other-root' : cut.rootId,
              childId: reason === 'child' ? 'idle-b' : cut.childId,
              hostEpoch: reason === 'epoch' ? 2 : cut.hostEpoch,
              display:
                reason === 'instance'
                  ? { ...cut.stream, instanceId: 'another-agent' }
                  : cut.stream,
            },
            'fork-a',
          );
        await expect
          .poll(() => detail.innerText())
          .not.toContain('fork-a 中途基线');
        expect(await detail.innerText()).not.toMatch(
          /fork-a 已记录文字|读取文件|自己的最后回复/,
        );
        if (reason === 'resync') {
          feed.push(fixture, { type: 'snapshot', snapshot: cut }, 'fork-a');
          await expect
            .poll(() => detail.innerText())
            .toContain('fork-a 中途基线');
        }
      } finally {
        await page.close();
      }
    },
  );

  it('updates direct running in the directory and unselected parent sidebar without opening a child', async () => {
    const { page, fixture } = await open();
    try {
      await expect
        .poll(
          () =>
            [...feed.connections].filter(
              (c) => c.fixture === fixture && c.sessionId === 'parent-a',
            ).length,
        )
        .toBe(1);
      const update = summary();
      update.descendants = update.descendants.map((entry) =>
        entry.kind === 'child' && entry.parentId === update.rootId
          ? { ...entry, running: false }
          : entry,
      );
      feed.push(fixture, { type: 'directory', summary: update });
      await page
        .getByRole('button', { name: '2 个子智能体', exact: true })
        .waitFor();
      await expect
        .poll(() => row(page, 'parent-a').innerText())
        .not.toContain('子智能体运行中');
      expect(
        feed.calls.filter((call) => call.fixture === fixture && call.childId),
      ).toEqual([]);
      feed.push(fixture, { type: 'clear', reason: 'unavailable' });
      await page
        .getByRole('button', { name: '子智能体读取失败', exact: true })
        .waitFor();
      expect(await row(page, 'parent-a').innerText()).not.toContain(
        '子智能体运行中',
      );
    } finally {
      await page.close();
    }
  });

  it('follows A/B/C on one selected durable address through summary and temporary prepared or diagnostic cuts', async () => {
    const value = summary(),
      { page, fixture, setResponse } = await open(
        value,
        1200,
        undefined,
        ownProcess,
      );
    try {
      const detail = await selectChild(page);
      for (const phase of ['B', 'C']) {
        const ended = summary();
        ended.descendants = ended.descendants.map((entry) =>
          entry.kind === 'child'
            ? {
                ...entry,
                running: null,
                activity: 'inactive',
                observation: { source: 'prepared', cursor: 8 },
                lastReply: `${phase}之前唯一安全回复`,
              }
            : entry,
        );
        setResponse(ended);
        feed.push(fixture, { type: 'directory', summary: ended });
        feed.push(fixture, { type: 'directory', summary: ended }, 'fork-a');
        feed.push(
          fixture,
          { type: 'summary', childId: 'fork-a', summary: ended },
          'fork-a',
        );
        await expect
          .poll(() => detail.innerText())
          .toContain(`${phase}之前唯一安全回复`);
        expect(await detail.innerText()).not.toMatch(
          /中途基线|已记录文字|读取文件/,
        );
        const unavailable = {
          ...ended,
          descendants: ended.descendants.map((entry) =>
            entry.id === 'fork-a'
              ? {
                  kind: 'diagnostic' as const,
                  id: entry.id,
                  parentId: entry.parentId,
                  depth: entry.depth,
                  reason: 'unavailable' as const,
                }
              : entry,
          ),
        };
        feed.push(fixture, { type: 'directory', summary: unavailable });
        feed.push(
          fixture,
          { type: 'directory', summary: unavailable },
          'fork-a',
        );
        await expect
          .poll(() => detail.innerText())
          .not.toContain(`${phase}之前唯一安全回复`);
        setResponse(value);
        feed.push(fixture, { type: 'directory', summary: value });
        feed.push(fixture, { type: 'directory', summary: value }, 'fork-a');
        const cut = ownProcess(value, 'fork-a');
        cut.rows = [
          {
            kind: 'assistant',
            seq: 5,
            turn: 0,
            step: 0,
            text: `${phase}安全记录`,
            truncated: false,
          },
        ];
        cut.stream.instanceId = `${phase}-instance`;
        cut.stream.active = {
          ...cut.stream.active!,
          text: '',
          attemptId: `${phase}-attempt`,
          nextIndex: 0,
        };
        feed.push(fixture, { type: 'snapshot', snapshot: cut }, 'fork-a');
        await expect
          .poll(() => detail.innerText())
          .toContain(`${phase}安全记录`);
        feed.push(
          fixture,
          {
            type: 'display',
            rootId: cut.rootId,
            childId: cut.childId,
            hostEpoch: cut.hostEpoch,
            display: {
              ...cut.stream,
              revision: 1,
              active: {
                ...cut.stream.active!,
                text: `${phase}持续更新文字`,
                nextIndex: 1,
              },
            },
          },
          'fork-a',
        );
        await expect
          .poll(() => detail.innerText())
          .toContain(`${phase}持续更新文字`);
        expect(await detail.innerText()).not.toContain(
          `${phase}之前唯一安全回复`,
        );
      }
      expect(
        feed.calls.filter(
          (call) => call.fixture === fixture && call.childId === 'fork-a',
        ),
      ).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('rejects a display after summary until a fresh snapshot has authorized its baseline', async () => {
    const value = summary(),
      { page, fixture } = await open(value, 1200, undefined, ownProcess);
    try {
      const detail = await selectChild(page);
      feed.push(
        fixture,
        { type: 'summary', childId: 'fork-a', summary: value },
        'fork-a',
      );
      await expect
        .poll(() => detail.innerText())
        .toContain('fork-a 自己的最后回复');
      const cut = ownProcess(value, 'fork-a');
      feed.push(
        fixture,
        {
          type: 'display',
          rootId: cut.rootId,
          childId: cut.childId,
          hostEpoch: cut.hostEpoch,
          display: cut.stream,
        },
        'fork-a',
      );
      await expect.poll(() => detail.innerText()).toContain('暂时无法读取');
      expect(await detail.innerText()).not.toMatch(/中途基线|自己的最后回复/);
    } finally {
      await page.close();
    }
  });

  it.each(['503', 'null', 'late503'])(
    'recovers initial %s from the current root Run ready event without token refresh or stale errors',
    async (kind) => {
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const { page, calls, fixture, initialDelivered } = await open(
        summary(),
        1200,
        undefined,
        undefined,
        '?root-events=1',
        {
          kind: kind === 'null' ? 'null' : 'error',
          gate: kind === 'late503' ? gate : undefined,
        },
      );
      try {
        await expect
          .poll(() => calls.filter((call) => call.id === 'parent-a').length)
          .toBe(1);
        await expect
          .poll(
            () =>
              [...feed.rootConnections].filter((c) => c.fixture === fixture)
                .length,
          )
          .toBe(1);
        const backgroundConnections = () =>
          [...feed.connections].filter(
            (c) => c.fixture === fixture && c.sessionId === 'parent-b',
          );
        await expect.poll(() => backgroundConnections().length).toBe(1);
        const originalBackground = backgroundConnections()[0]!;
        expect(calls.filter((call) => call.id === 'parent-b')).toHaveLength(1);
        const rootEvent = (
          sequence: number,
          type: string,
          runId = 'root-run',
        ): ChatFlowEventEnvelope => ({
          schemaVersion: 3,
          eventId: `${runId}-${sequence}`,
          organizationId: 'org',
          workspaceId: 'workspace',
          conversationId: null,
          runId,
          generation: 1,
          cursor: `root-run:${sequence}`,
          sequence,
          harness: 'dsh',
          type: 'harness.native',
          occurredAt: '2026-10-30T00:00:00Z',
          payload: {},
          sourceEvent: {
            id: `native-${sequence}`,
            type,
            occurredAt: '2026-10-30T00:00:00Z',
            payload: {},
          },
        });
        feed.pushRoot(fixture, rootEvent(1, 'request/header', 'old-run'));
        feed.pushRoot(fixture, rootEvent(2, 'allrice/runtime-preparation'));
        await expect
          .poll(() => page.getByLabel('root事件游标').innerText())
          .toBe('root-run:2');
        expect(calls.filter((call) => call.id === 'parent-a')).toHaveLength(1);
        feed.pushRoot(
          fixture,
          rootEvent(3, kind === 'null' ? 'request/context' : 'request/header'),
        );
        await page
          .getByRole('button', {
            name: '2 个子智能体 · 1 个运行中',
            exact: true,
          })
          .waitFor();
        await expect
          .poll(() => row(page, 'parent-a').innerText())
          .toContain('1 个子智能体运行中');
        await expect
          .poll(
            () =>
              feed.calls.filter(
                (call) =>
                  call.fixture === fixture && call.sessionId === 'parent-a',
              ).length,
          )
          .toBe(1);
        expect(calls.filter((call) => call.id === 'parent-a')).toHaveLength(2);
        release();
        await expect.poll(initialDelivered).toBe(1);
        feed.pushRoot(fixture, rootEvent(4, 'request/context'));
        feed.pushRoot(fixture, rootEvent(5, 'assistant/message'));
        await expect
          .poll(() => page.getByLabel('root事件游标').innerText())
          .toBe('root-run:5');
        expect(calls.filter((call) => call.id === 'parent-a')).toHaveLength(2);
        expect(await row(page, 'parent-a').innerText()).toContain(
          '1 个子智能体运行中',
        );
        expect(calls.filter((call) => call.id === 'parent-b')).toHaveLength(1);
        expect(
          feed.calls.filter(
            (call) => call.fixture === fixture && call.sessionId === 'parent-b',
          ),
        ).toHaveLength(1);
        expect(backgroundConnections()[0]).toBe(originalBackground);
        expect(originalBackground.response.destroyed).toBe(false);
        expect(originalBackground.response.writableEnded).toBe(false);
        const backgroundUpdate = summary('other-root');
        backgroundUpdate.descendants = backgroundUpdate.descendants.map(
          (entry) =>
            entry.kind === 'child' && entry.parentId === backgroundUpdate.rootId
              ? { ...entry, running: false }
              : entry,
        );
        feed.send(originalBackground, {
          type: 'directory',
          summary: backgroundUpdate,
        });
        await expect
          .poll(() => row(page, 'parent-b').innerText())
          .not.toContain('子智能体运行中');
        const next = summary();
        next.descendants = next.descendants.map((entry) =>
          entry.kind === 'child' && entry.parentId === next.rootId
            ? { ...entry, running: true }
            : entry,
        );
        feed.push(fixture, { type: 'directory', summary: next });
        await page
          .getByRole('button', {
            name: '2 个子智能体 · 2 个运行中',
            exact: true,
          })
          .waitFor();
        await expect
          .poll(() => row(page, 'parent-a').innerText())
          .toContain('2 个子智能体运行中');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
          .poll(() => calls.filter((call) => call.id === 'parent-a').length)
          .toBe(3);
        await expect
          .poll(() => calls.filter((call) => call.id === 'parent-b').length)
          .toBe(2);
        await expect
          .poll(() => calls.filter((call) => call.id === 'parent-c').length)
          .toBe(2);
        await expect
          .poll(() => originalBackground.response.destroyed)
          .toBe(true);
        await expect.poll(() => backgroundConnections().length).toBe(1);
        expect(backgroundConnections()[0]).not.toBe(originalBackground);
      } finally {
        release();
        await page.close();
      }
    },
  );

  it('clears detail on authorization failure and switches children and business scope without old text', async () => {
    const { page, fixture } = await open(
      summary(),
      1200,
      undefined,
      ownProcess,
    );
    try {
      await selectChild(page);
      await page.keyboard.press('Escape');
      const detail = await selectChild(page, 'idle-b');
      expect(await detail.innerText()).not.toContain('fork-a 中途基线');
      const old = [...feed.connections].find(
        (connection) =>
          connection.fixture === fixture && connection.childId === 'idle-b',
      )!;
      await row(page, 'parent-b').focus();
      await page.keyboard.press('Enter');
      expect(await detail.count()).toBe(0);
      feed.send(old, {
        type: 'snapshot',
        snapshot: ownProcess(summary(), 'idle-b'),
      });
      expect(
        await page.getByRole('complementary', { name: '子智能体摘要' }).count(),
      ).toBe(0);
      await page.locator('button[aria-haspopup="tree"]').click();
      await page.getByRole('button', { name: '查看fork-a摘要' }).waitFor();
      feed.sources.get(fixture)!.status = 403;
      await page.getByRole('button', { name: '查看fork-a摘要' }).click();
      const denied = page.getByRole('complementary', { name: '子智能体摘要' });
      await expect.poll(() => denied.innerText()).toContain('暂时无法读取摘要');
      expect(await denied.innerText()).not.toMatch(
        /中途基线|已记录文字|自己的最后回复/,
      );
    } finally {
      await page.close();
    }
  });

  it('keeps prepared source independent of explicit idle status, discloses truncation and never follows cold children', async () => {
    const value = summary();
    value.root.source = 'prepared';
    value.descendants = value.descendants.map((entry) =>
      entry.kind === 'child'
        ? {
            ...entry,
            running: false,
            activity: 'inactive',
            observation: { source: 'prepared', cursor: 8 },
            lastReplyTruncated: true,
          }
        : entry,
    );
    const { page, fixture } = await open(value);
    try {
      await page.locator('button[aria-haspopup="tree"]').click();
      await page.getByRole('button', { name: '查看idle-b摘要' }).click();
      const detail = page.getByRole('complementary', { name: '子智能体摘要' });
      expect(await detail.innerText()).toContain('历史摘要 · 上次回合已完成');
      expect(await detail.innerText()).toContain('最后回复已截断');
      expect(await detail.innerText()).not.toContain('当前活动状态未知');
      expect(
        feed.calls.filter(
          (call) => call.fixture === fixture && call.sessionId === 'parent-a',
        ),
      ).toEqual([]);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() => detail.innerText())
        .toContain('idle-b 自己的最后回复');
      expect(
        feed.calls.filter((call) => call.fixture === fixture && call.childId),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('uses the existing verbose and next-input disclosure preferences and preserves a manual tool choice across replacements', async () => {
    const initial: typeof snapshotFor = (value, id) => {
      const cut = ownProcess(value, id);
      cut.rows[1] = {
        kind: 'tool',
        seq: 6,
        turn: 0,
        step: 0,
        callId: 'call-1',
        name: '读取文件',
        truncated: false,
        result: { seq: 7, failed: false, summary: '安全结果摘要' },
      };
      return cut;
    };
    const value = summary(),
      { page, fixture } = await open(
        value,
        1200,
        undefined,
        initial,
        '?view=verbose&collapse=next-input',
      );
    try {
      const detail = await selectChild(page);
      expect(await detail.innerText()).toContain('安全结果摘要');
      await detail.getByText('读取文件', { exact: true }).click();
      await expect.poll(() => detail.innerText()).not.toContain('安全结果摘要');
      const cut = initial(value, 'fork-a');
      cut.stream.active = {
        ...cut.stream.active!,
        text: '替换后仍保留手动折叠',
      };
      feed.push(fixture, { type: 'snapshot', snapshot: cut }, 'fork-a');
      await expect
        .poll(() => detail.innerText())
        .toContain('替换后仍保留手动折叠');
      expect(await detail.innerText()).not.toContain('安全结果摘要');
    } finally {
      await page.close();
    }
  });
});
