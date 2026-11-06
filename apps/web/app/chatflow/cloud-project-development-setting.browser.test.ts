/** Real settings components and Chrome; synthetic HTTP, no DB/model/Run. */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const capabilityId = 'allrice.cloud-project-development';
const title = '云端项目开发';
const description = '在云端保存项目、运行构建、打开预览并发布成果。';
const scope = '适用于你的所有 AI 员工。更改仅对新对话生效，进行中的对话不变。';
const local = '本机开发由“我的电脑”控制，不受此开关影响。';
const failure = '个人偏好暂时无法保存或读取，请重试';
const hint =
  '“准备任务”会将指引加入输入框，发送后开始。执行时遵循你的授权与工作方式。';
const payload = (enabled: boolean, viewerId = 'viewer-a') => ({
  viewerId,
  preferences: {
    appearance: 'dark',
    streamingOutput: false,
    capabilities: { [capabilityId]: { configVersion: 1, enabled } },
  },
});
type Reply = { status: number; body: unknown; wait?: Promise<void> };
const screenshots = resolve('.local/feedback/met223-cloud-project-settings');

suite('account cloud project development in work settings', () => {
  let browser: Browser, server: Server, origin: string;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      stdin: {
        contents: `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkAutomationSettings} from './app/chatflow/work-automation-settings';
import {CapabilityContent} from './app/chatflow/capability-panel';
import styles from './app/chatflow/sidebar-settings.module.css';
import './app/dsh-upstream/design-platform.css';
import './app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';
import './app/styles/base.css';
import '@allrice/ui/styles.css';
const data={observedAt:'2026-11-06T00:00:00Z',capabilities:['report','cloud_command','cloud_browser','boost','teamwork','local_files','changeset','local_command','local_browser'].map(id=>({id,state:['boost','teamwork'].includes(id)?'not_released':'ready',reason:['boost','teamwork'].includes(id)?'release_disabled':'ready',action:'guide'}))};
const capabilities=scope=><CapabilityContent scope={scope} data={data} loading={false} error="" busy={false} onRefresh={()=>{}} onBridge={()=>{}} onCompose={()=>{}}/>;
function App(){const [generation,setGeneration]=useState(0);return <main style={{maxWidth:640,margin:'0 auto',padding:16}}><button type="button" onClick={()=>setGeneration(value=>value+1)}>更换设置宿主</button><div className={styles.section}><h2>工作方式</h2><WorkAutomationSettings key={generation} workspaceId={'00000000-0000-4000-8000-'+String(generation+1).padStart(12,'0')} capabilities={capabilities('work')}/><CapabilityContent scope="computer" data={data} loading={false} error="" busy={false} onRefresh={()=>{}} onBridge={()=>{}} onCompose={()=>{}}/></div></main>}
if(new URLSearchParams(location.search).get('theme')==='dark')document.body.setAttribute('data-ds-dark-theme','');
createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir: resolve('apps/web'),
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      write: false,
      outdir: '/cloud-project-setting-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"' },
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
          '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/stdin.css"><div id="root"></div><script src="/stdin.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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
    await mkdir(screenshots, { recursive: true });
  }, 30000);
  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 30000);

  async function fixture(
    width = 390,
    theme = 'light',
    read: Reply = { status: 200, body: payload(false) },
  ) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const state = {
      read,
      save: null as Reply | null,
      reads: 0,
      completedReads: 0,
      writes: [] as unknown[],
    };
    await page.route('**/api/v1/me/work-automation?*', (route) =>
      route.fulfill({
        json: {
          workspaceId: new URL(route.request().url()).searchParams.get(
            'workspaceId',
          ),
          revision: 0,
          editable: true,
          settings: { cloud: true, computer: true },
        },
      }),
    );
    await page.route('**/api/v1/me/preferences', async (route) => {
      const saving = route.request().method() === 'PATCH';
      if (saving) state.writes.push(route.request().postDataJSON());
      else state.reads++;
      const reply = saving
        ? (state.save ?? {
            status: 200,
            body: payload(
              route.request().postDataJSON().capabilities[capabilityId].enabled,
            ),
          })
        : state.read;
      if (reply.wait) await reply.wait;
      // An intentionally unmounted settings request may already be cancelled.
      await route
        .fulfill({
          status: reply.status,
          contentType: 'application/json',
          body: JSON.stringify(reply.body),
        })
        .catch(() => undefined);
      if (!saving) state.completedReads++;
    });
    await page.goto(`${origin}/?theme=${theme}`);
    const work = page.locator('[data-capability-scope="work"]');
    const group = work.locator(':scope > details');
    expect(await group.getAttribute('open')).toBeNull();
    await group.locator(':scope > summary').click();
    const row = work.locator('[data-cloud-project-development]');
    const toggle = row.getByRole('switch', { name: title, exact: true });
    return { page, state, errors, work, group, row, toggle };
  }

  for (const width of [1440, 390])
    for (const theme of ['light', 'dark'])
      it(`keeps approved copy and independent native controls at ${width}px in ${theme}`, async () => {
        const f = await fixture(width, theme);
        try {
          await expect.poll(() => f.toggle.isEnabled()).toBe(true);
          expect(await f.toggle.getAttribute('aria-checked')).toBe('false');
          expect(await f.toggle.getAttribute('title')).toBe(
            `${description} ${scope} ${local}`,
          );
          const accessibility = await f.page.context().newCDPSession(f.page);
          const { root } = await accessibility.send('DOM.getDocument');
          const { nodeId } = await accessibility.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: '[data-cloud-project-development] [role="switch"]',
          });
          const { nodes } = await accessibility.send(
            'Accessibility.getPartialAXTree',
            { nodeId },
          );
          const nativeSwitch = nodes.find(
            (node) => node.role?.value === 'switch',
          );
          expect(nativeSwitch?.name?.value).toBe(title);
          expect(nativeSwitch?.description?.value).toBe(
            `${description} ${scope} ${local}`,
          );
          await accessibility.detach();
          await f.page
            .getByRole('switch', { name: '云端自动工作', exact: true })
            .waitFor();
          expect(await f.page.getByRole('switch').count()).toBe(3);
          const fold = f.row.locator(':scope > details');
          const heading = fold.locator(':scope > summary');
          expect(await fold.getAttribute('open')).toBeNull();
          expect(
            await f.work
              .locator('[data-capability]')
              .evaluateAll((cards) =>
                cards.map((card) => card.getAttribute('data-capability')),
              ),
          ).toEqual([
            'report',
            'cloud_command',
            'cloud_browser',
            'boost',
            'teamwork',
          ]);
          expect(await f.work.getByText(hint, { exact: true }).count()).toBe(0);
          expect(
            await f.page
              .locator('[data-capability-scope="computer"]')
              .getByText(hint, { exact: true })
              .count(),
          ).toBe(1);
          expect(
            await f.row.evaluate((node) => {
              const footnote = document.querySelector(
                '[aria-label="工作方式设置"] > p:last-of-type',
              )!;
              const work = node.closest('[data-capability-scope]')!;
              return [
                !!(
                  footnote.compareDocumentPosition(work) &
                  Node.DOCUMENT_POSITION_FOLLOWING
                ),
                node.previousElementSibling?.querySelector('button')
                  ?.textContent,
                node.nextElementSibling?.getAttribute('data-capability'),
              ];
            }),
          ).toEqual([true, '刷新能力状态', 'report']);
          const typography = (selector: string) =>
            f.work.locator(selector).evaluate((node) => {
              const css = getComputedStyle(node);
              return [
                css.fontFamily,
                css.fontSize,
                css.fontWeight,
                css.lineHeight,
              ];
            });
          expect(
            await typography('[data-cloud-project-development] h3'),
          ).toEqual(await typography('[data-capability="report"] h3'));
          const box = (await f.toggle.boundingBox())!;
          expect([box.width, box.height]).toEqual([36, 20]);
          await f.page.screenshot({
            path: resolve(screenshots, `${width}-${theme}-collapsed.png`),
          });
          await heading.click();
          for (const text of [description, scope, local])
            expect(
              await fold.getByText(text, { exact: true }).isVisible(),
            ).toBe(true);
          expect(f.state.writes).toEqual([]);
          await f.page.screenshot({
            path: resolve(screenshots, `${width}-${theme}-expanded.png`),
          });
          await f.toggle.click();
          await expect
            .poll(() => f.toggle.getAttribute('aria-checked'))
            .toBe('true');
          expect(await fold.getAttribute('open')).not.toBeNull();
          await heading.focus();
          await f.page.keyboard.press('Enter');
          expect(await fold.getAttribute('open')).toBeNull();
          await f.page.keyboard.press(' ');
          expect(await fold.getAttribute('open')).not.toBeNull();
          await expect.poll(() => f.toggle.isEnabled()).toBe(true);
          await f.toggle.focus();
          await f.page.keyboard.press(' ');
          await expect
            .poll(() => f.toggle.getAttribute('aria-checked'))
            .toBe('false');
          expect(await fold.getAttribute('open')).not.toBeNull();
          expect(f.state.writes).toEqual(
            [true, false].map((enabled) => ({
              capabilities: { [capabilityId]: { configVersion: 1, enabled } },
            })),
          );
          expect(
            await f.page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(f.errors).toEqual([]);
        } finally {
          await f.page.close();
        }
      });

  const badReads: [string, Reply][] = [
    [
      'storage failure',
      {
        status: 503,
        body: { error: { message: 'synthetic internal detail' } },
      },
    ],
    [
      'missing capability',
      { status: 200, body: { viewerId: 'viewer-a', preferences: {} } },
    ],
    [
      'missing enabled',
      {
        status: 200,
        body: {
          viewerId: 'viewer-a',
          preferences: {
            capabilities: { [capabilityId]: { configVersion: 1 } },
          },
        },
      },
    ],
    [
      'wrong version',
      {
        status: 200,
        body: {
          viewerId: 'viewer-a',
          preferences: {
            capabilities: {
              [capabilityId]: { configVersion: 2, enabled: false },
            },
          },
        },
      },
    ],
    [
      'nonboolean',
      {
        status: 200,
        body: {
          viewerId: 'viewer-a',
          preferences: {
            capabilities: {
              [capabilityId]: { configVersion: 1, enabled: 'false' },
            },
          },
        },
      },
    ],
    ['unreadable response', { status: 200, body: undefined }],
  ];
  it.each(badReads)(
    'does not treat %s as a successful off value and rereads explicitly',
    async (_name, reply) => {
      const f = await fixture(390, 'light', reply);
      try {
        const alert = f.row.getByRole('alert');
        await alert.waitFor();
        expect(await alert.innerText()).toContain(failure);
        expect(await alert.innerText()).not.toContain(
          'synthetic internal detail',
        );
        expect(
          await alert
            .getByRole('button', { name: '重新读取', exact: true })
            .count(),
        ).toBe(1);
        expect(await f.toggle.isDisabled()).toBe(true);
        await f.page.clock.install();
        await f.page.clock.fastForward(30000);
        expect(f.state.reads).toBe(1);
        expect(f.state.writes).toEqual([]);
        f.state.read = { status: 200, body: payload(true) };
        await alert.getByRole('button', { name: '重新读取' }).click();
        await expect
          .poll(() => f.toggle.getAttribute('aria-checked'))
          .toBe('true');
        await expect.poll(() => f.toggle.isEnabled()).toBe(true);
        expect(f.state.reads).toBe(2);
        expect(await f.row.getByRole('alert').count()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.page.close();
      }
    },
  );

  it.each([
    { status: 503, body: {} },
    { status: 200, body: { viewerId: 'viewer-a', preferences: {} } },
    { status: 200, body: payload(false, 'another-account') },
    { status: 200, body: undefined },
  ])(
    'preserves the confirmed on value after a failed or invalid write %#',
    async (reply) => {
      const f = await fixture(390, 'light', {
        status: 200,
        body: payload(true),
      });
      try {
        await expect.poll(() => f.toggle.isEnabled()).toBe(true);
        f.state.save = reply;
        await f.toggle.click();
        await f.row.getByRole('alert').waitFor();
        expect(await f.toggle.getAttribute('aria-checked')).toBe('true');
        expect(await f.toggle.isDisabled()).toBe(true);
        expect(f.state.writes).toEqual([
          {
            capabilities: {
              [capabilityId]: { configVersion: 1, enabled: false },
            },
          },
        ]);
        expect(f.errors).toEqual([]);
      } finally {
        await f.page.close();
      }
    },
  );

  it('waits for the response value without optimistic success or duplicate writes', async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      await expect.poll(() => f.toggle.isEnabled()).toBe(true);
      f.state.save = {
        status: 200,
        body: payload(false),
        wait: new Promise<void>((done) => {
          release = done;
        }),
      };
      await f.toggle.click();
      await expect.poll(() => f.state.writes.length).toBe(1);
      expect(await f.toggle.isDisabled()).toBe(true);
      expect(await f.toggle.getAttribute('aria-checked')).toBe('false');
      await f.page.keyboard.press(' ');
      expect(f.state.writes).toHaveLength(1);
      release();
      await expect.poll(() => f.toggle.isEnabled()).toBe(true);
      expect(await f.toggle.getAttribute('aria-checked')).toBe('false');
      expect(await f.row.getByRole('alert').count()).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.page.close();
    }
  });

  // ChatFlowClient keys CapabilityContent by section/viewer/workspace/activeId.
  // This focused fixture proves cleanup on remount, not the real host's key;
  // the full workbench file and source review cover that integration separately.
  it('ignores a late read after settings remounts with a different account response', async () => {
    let release!: () => void;
    const f = await fixture(390, 'light', {
      status: 200,
      body: payload(false),
      wait: new Promise<void>((done) => {
        release = done;
      }),
    });
    try {
      await expect.poll(() => f.state.reads).toBe(1);
      expect(await f.toggle.isDisabled()).toBe(true);
      f.state.read = { status: 200, body: payload(true, 'viewer-b') };
      await f.page.getByRole('button', { name: '更换设置宿主' }).click();
      await f.group.locator(':scope > summary').click();
      await expect
        .poll(() => f.toggle.getAttribute('aria-checked'))
        .toBe('true');
      release();
      await expect.poll(() => f.state.completedReads).toBe(2);
      expect(await f.toggle.getAttribute('aria-checked')).toBe('true');
      expect(f.state.writes).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally {
      release?.();
      await f.page.close();
    }
  });
});
