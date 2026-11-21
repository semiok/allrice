import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deliveryName,
  documentSession,
  prepareNativeHistory,
  processSession,
} from './native-history.mjs';

declare global {
  interface Window {
    __allriceCompositionTest?: {
      openSession: (id: string) => void;
      setTheme: (mode: 'light' | 'dark') => void;
    };
  }
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

suite('installed AllRice native Web composition', () => {
  let root: string, browser: Browser, page: Page, child: ChildProcess;
  let exited: Promise<void>;
  const errors: string[] = [];

  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-composition-browser-')),
    );
    const home = join(root, 'home');
    const dshHome = join(root, 'dsh');
    const profile = join(dshHome, 'profiles/allrice-web');
    await mkdir(profile, { recursive: true });
    await mkdir(home, { recursive: true });
    // No inherited model/provider credentials, config HOME, API keys or proxies.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(root, 'agents'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      LANG: 'zh_CN.UTF-8',
      DO_NOT_TRACK: '1',
    };
    const pnpm = async (args: string[], cwd: string) => {
      const cli = process.env.npm_execpath;
      return run(cli ? process.execPath : 'pnpm', cli ? [cli, ...args] : args, {
        cwd,
        env,
      });
    };
    expect((await pnpm(['--version'], repoRoot)).stdout.trim()).toBe('10.33.3');
    await pnpm(['pack', '--pack-destination', root], packageRoot);
    const manifest = JSON.parse(
      await readFile(
        join(packageRoot, 'profiles/allrice-web/package.json'),
        'utf8',
      ),
    );
    manifest.dependencies['@allrice/dsh-web-composition'] =
      `file:${join(root, 'allrice-dsh-web-composition-0.1.0.tgz')}`;
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
    await pnpm(['install', '--offline', '--ignore-scripts'], profile);
    const installed = join(
      profile,
      'node_modules/@allrice/dsh-web-composition',
    );
    expect(await realpath(installed)).not.toBe(await realpath(packageRoot));
    expect(
      await readFile(join(installed, 'dist/client.js'), 'utf8'),
    ).not.toContain('__allriceCompositionTest');

    // Default is the repository's exact native dependency. An explicit override
    // may select an already cached same-generation Host for a local run.
    const hostRequire = createRequire(
      process.env.ALLRICE_DSH_WEB_HOST_ANCHOR
        ? resolve(process.env.ALLRICE_DSH_WEB_HOST_ANCHOR)
        : require.resolve('@deepseek-ai/dsh/package.json'),
    );
    expect(hostRequire('@deepseek-ai/dsh/package.json').version).toBe(
      '0.2.1-rc.2',
    );
    const history = await prepareNativeHistory(hostRequire, root);
    const fixture = join(root, 'fixture-plugin');
    await mkdir(fixture);
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: '@allrice/composition-test-fixture',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './index.js',
          './client': './client.js',
          './package.json': './package.json',
        },
        engines: { dsh: '0.2.1-rc.2' },
        dsh: {
          manifestVersion: 1,
          client: {
            platform: 'web',
            inject: [
              '@deepseek-ai/dsh-api-session-controller',
              '@deepseek-ai/dsh-api-workspace-controller',
              '@deepseek-ai/dsh-client-ui-workspace',
              '@deepseek-ai/dsh-client-ui-theme',
            ],
          },
        },
      }),
    );
    await writeFile(join(fixture, 'index.js'), 'export function apply() {}\n');
    await writeFile(
      join(fixture, 'client.js'),
      await readFile(new URL('./fixtures/client.js', import.meta.url)),
    );
    await symlink(
      fixture,
      join(profile, 'node_modules/@allrice/composition-test-fixture'),
      'dir',
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          insert: [
            {
              id: 'composition-test-fixture',
              name: '@allrice/composition-test-fixture',
            },
          ],
        },
        {
          id: 'session-persistence-jsonl',
          config: { root: history.sessions, compression: 'none' },
        },
        {
          id: 'workspace-controller',
          config: { documentsDirectory: history.workspace },
        },
        { id: 'session-title-llm', disabled: true },
        { id: 'agent-instructions', disabled: true },
      ]),
    );
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(
      join(dshHome, 'storages/workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
        tables: { workspaces: {} },
      }),
    );
    const reservation = createServer();
    await new Promise<void>((res) => reservation.listen(0, '127.0.0.1', res));
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('No isolated test port');
    const port = address.port;
    await new Promise<void>((res, reject) =>
      reservation.close((error) => (error ? reject(error) : res())),
    );
    const origin = `http://localhost:${port}`;
    let output = '',
      exitCode: number | null | undefined;
    child = spawn(
      process.execPath,
      [
        hostRequire.resolve('@deepseek-ai/dsh/lib/bin.js'),
        '--profile',
        'allrice-web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--public-url',
        origin,
        '--trusted-host',
        `localhost:${port}`,
      ],
      { cwd: history.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (data) => {
      output += String(data);
    });
    child.stderr?.on('data', (data) => {
      output += String(data);
    });
    exited = new Promise((res) => {
      child.once('error', () => {
        exitCode = -1;
        res();
      });
      child.once('exit', (code) => {
        exitCode = code;
        res();
      });
    });
    let authUrl: string | undefined;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined)
        throw new Error(`Native test Host exited before ready (${exitCode})`);
      authUrl = [
        ...output
          .replaceAll(String.fromCharCode(27), ' ')
          .matchAll(/http:\/\/[^\s]+/g),
      ]
        .map((match) => match[0])
        .find(
          (url) =>
            url.startsWith(origin + '/') &&
            new URL(url).searchParams.has('token'),
        );
      if (authUrl) break;
      await delay(100);
    }
    if (!authUrl)
      throw new Error('Native test Host did not publish its own Web login URL');
    // The generated Web token stays in memory; no credential file is read/copied.
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(authUrl);
    const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await page.goto(origin);
    await page.waitForFunction(() => !!window.__allriceCompositionTest);
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await Promise.race([exited, delay(5000)]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
        }
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps native disclosure, drafts, answered questions and document preview after actual installation', async () => {
    try {
      await page
        .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
          exact: true,
        })
        .waitFor();
      for (const width of [1440, 390])
        for (const theme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(
            (mode) => window.__allriceCompositionTest!.setTheme(mode),
            theme,
          );
          const group = page.getByRole('button', {
            name: '已完成，用时 10秒',
            exact: true,
          });
          if ((await group.getAttribute('aria-expanded')) === 'false')
            await group.click();
          const tool = page.getByRole('button', {
            name: '执行了命令',
            exact: true,
          });
          if ((await tool.getAttribute('aria-expanded')) === 'false')
            await tool.click();
          const command = page
            .getByRole('button', { name: /^运行命令/ })
            .first();
          if ((await command.getAttribute('aria-expanded')) === 'false')
            await command.click();
          expect(
            await page
              .getByText('node tasks/pair/action.cjs', { exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByText(/"totalCents":5630/)
              .first()
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('button', { name: '1 个子智能体', exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page
              .getByRole('tab', { name: /^(Chat|Trajectory|对话|轨迹)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('button', { name: /^(更多操作|More actions)$/ })
              .count(),
          ).toBe(0);
          expect(
            await page
              .locator('button:visible')
              .filter({
                hasText: /^(完全访问|选择模型|Full access|Select model)$/,
              })
              .count(),
          ).toBe(0);
          expect(
            await page.getByRole('button', { name: /上下文已用/ }).isVisible(),
          ).toBe(true); // documented upstream gap
          expect(await page.locator('body').innerText()).not.toMatch(
            /Open In|(?:Usage|Cache|用量|缓存)\s*[\d:]/,
          );
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          await command.click();
          await tool.click();
          await group.click();
        }
      const editor = page
        .locator('textarea:visible,[contenteditable=true]:visible')
        .first();
      await editor.fill('未发送的原生草稿');
      await page
        .getByRole('button', { name: '已完成，用时 10秒', exact: true })
        .click();
      expect(
        await editor.evaluate((node) =>
          node instanceof HTMLTextAreaElement ? node.value : node.textContent,
        ),
      ).toContain('未发送的原生草稿');
      await editor.fill('');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        documentSession,
      );
      await page
        .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
        .waitFor();
      const questionProcess = page
        .getByRole('button', { name: /^已完成，用时/ })
        .first();
      if ((await questionProcess.getAttribute('aria-expanded')) === 'false')
        await questionProcess.click();
      const questionStep = page.getByRole('button', {
        name: '向用户提出了问题并已调用工具',
        exact: true,
      });
      if ((await questionStep.getAttribute('aria-expanded')) === 'false')
        await questionStep.click();
      // The fixture follows the standard preset's legacy ask-user tool. Its
      // answered transcript opens inline; timed calls alone have View answers.
      const questionRow = page.getByRole('button', { name: /^提问/ });
      const questionExpanded = await questionRow.getAttribute('aria-expanded');
      expect(
        await page.getByText('1/1 已回答', { exact: true }).isVisible(),
      ).toBe(true);
      if (questionExpanded === 'false') await questionRow.click();
      expect(
        await page
          .getByText('核对说明采用哪种格式？', { exact: true })
          .isVisible(),
      ).toBe(true);
      expect(
        await page.getByText('Markdown', { exact: true }).first().isVisible(),
      ).toBe(true);
      await page
        .getByRole('button', {
          name: new RegExp(`^在侧边栏预览 .*${deliveryName}$`),
        })
        .click();
      await page.getByText('原生文档保留验证', { exact: true }).waitFor();
      expect(
        await page.getByText('56.30 元', { exact: true }).isVisible(),
      ).toBe(true);
      await page.reload();
      await page.waitForFunction(() => !!window.__allriceCompositionTest);
      await page.evaluate(
        (id) => window.__allriceCompositionTest!.openSession(id),
        processSession,
      );
      await page
        .getByText(/命令已执行一次，结果为 P4_ACTION_DONE=true/)
        .waitFor();
      expect(errors).toEqual([]);
    } catch (error) {
      // Optional screenshots contain the rendered UI only, never login URL or credentials.
      if (process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR) {
        const target = resolve(
          process.env.ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR,
        );
        await mkdir(target, { recursive: true });
        const attempt = await mkdtemp(
          join(target, 'installed-profile-failure-'),
        );
        await page.screenshot({
          path: join(attempt, 'page.png'),
          fullPage: true,
        });
        await writeFile(
          join(attempt, 'body.txt'),
          await page.locator('body').innerText(),
        );
      }
      throw error;
    }
  }, 60_000);
});
