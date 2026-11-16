import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaTopic,
  type ReferenceRevision,
  type RunSnapshot,
} from '@allrice/contracts';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

// Actual public primitives, host, entry controller, client and business page.
// HTTP/model/storage outcomes below are synthetic; the PG suite owns authority.
const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const id = (n: number) =>
  `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  instanceId: id(4),
};
const stamp = '2026-11-16T12:00:00.000Z',
  checksum = 'sha256:' + 'a'.repeat(64);
const file = { objectId: id(8), versionId: id(9), checksum };
const cursor = { createdAt: stamp, id: id(200) };
const topic = (n = 10): BrandMediaTopic => ({
  workspaceId: scope.workspaceId,
  instanceId: scope.instanceId,
  id: id(n),
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  candidate: { title: '新品故事 ' + n, summary: '让用户理解新品的日常用途' },
  direction: '新品日常',
  sourceRunId: id(30),
  references: [],
});
// Keep wire records strict: tenancy comes from the client, not business rows.
function article(n = 20): BrandMediaArticle {
  return {
    workspaceId: scope.workspaceId,
    instanceId: scope.instanceId,
    id: id(n),
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    topicId: id(10),
    title: n === 99 ? '月历里的旧文章' : '文章 ' + n,
    requirements: '',
    body: file,
    references: [],
    images: [],
    publication: { state: 'draft', schedule: null, links: null },
  };
}
function runSnapshot(
  n: number,
  status: RunSnapshot['status'] = 'succeeded',
): RunSnapshot {
  return {
    id: id(n),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    status,
    job: {
      id: id(n + 1000),
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      status: status === 'needs_attention' ? 'failed' : status,
      idempotencyKey: 'browser-' + n,
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      availableAt: stamp,
      timeoutAt: stamp,
      payload: { schemaVersion: 1, type: 'allrice.employee.run', input: {} },
      lease: null,
    },
    cancelRequestedAt: null,
    result: null,
    error:
      status === 'failed'
        ? { code: 'fixture_failure', message: '本次生成未完成' }
        : null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function reference(n: number, name: string): ReferenceRevision {
  return {
    sourceId: id(n),
    revisionId: id(n + 100),
    revision: 2,
    ownership: { scope: 'company', organizationId: scope.organizationId },
    fileName: name,
    purpose: '经审核的品牌资料',
    checksum,
    sizeBytes: 20,
    mediaType: 'text/plain',
    status: 'active',
    processing: 'ready',
    failure: null,
    canMaintain: false,
    canReference: true,
    publication: {
      origin: 'upload',
      publisherId: scope.ownerId,
      publisherName: '品牌同事',
      audience: { scope: 'company', departmentIds: [] },
      audienceRevision: 1,
    },
    createdAt: stamp,
    origin: null,
  };
}
const refs = [reference(50, '品牌介绍.txt'), reference(51, '客户问题.txt')];
const binding = {
  ...scope,
  release: brandMediaRelease,
  revision: 1,
  enabledAt: stamp,
  revokedAt: null,
};
type Recovery = {
  run: RunSnapshot;
  sessionId: string;
  invocation: { module: typeof binding; intent: Record<string, unknown> };
  submission: { articleUpdated: boolean; revision: number | null } | null;
  addedCandidates: BrandMediaTopic['candidate'][];
  unavailable: boolean;
  deliveries: Array<{ file: typeof file; format: string; content: string }>;
};
function recovery(
  operation: 'candidates' | 'article',
  status: RunSnapshot['status'] = 'succeeded',
  n = 300,
): Recovery {
  const intent =
    operation === 'candidates'
      ? {
          operation,
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          requestId: id(n + 1),
          direction: '面向通勤族',
          references: [],
        }
      : {
          operation,
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          requestId: id(n + 1),
          articleId: id(20),
          expectedRevision: 1,
          instructions: '写完整',
          references: [],
        };
  return {
    run: runSnapshot(n, status),
    sessionId: id(6),
    invocation: { module: binding, intent },
    submission: null,
    addedCandidates: [],
    unavailable: false,
    deliveries:
      status === 'succeeded'
        ? [
            {
              file,
              format: operation === 'candidates' ? 'json' : 'txt',
              content:
                operation === 'candidates'
                  ? JSON.stringify({
                      candidates: [
                        {
                          title: '十分钟的新品体验',
                          summary: '下班后的轻松时刻',
                        },
                      ],
                    })
                  : '保留的正文成果',
            },
          ]
        : [],
  };
}

type State = {
  installed: Set<string>;
  topics: BrandMediaTopic[];
  articles: BrandMediaArticle[];
  runs: Recovery[];
  requests: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }>;
  helpGate?: Promise<void>;
  addGate?: Promise<void>;
  failGenerateOnce?: boolean;
  failCandidateOnce?: boolean;
  failAllRecovery?: boolean;
  failRecoveryAfterGenerate?: boolean;
  moreTopics?: boolean;
  moreArticles?: boolean;
};

suite('MET-224 main-area brand media text workflow', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met224-brand-media-p3');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      stdin: {
        sourcefile: 'brand-media-page.tsx',
        resolveDir: resolve('.'),
        contents: `
        import { useMemo, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrandMediaHost, BrandMediaPluginSection, BrandMediaPluginPicker, useBrandMediaEntry } from './apps/web/app/chatflow/brand-media/frontend-wiring';
        import { BrandMediaPanel } from './apps/web/app/chatflow/brand-media/panel';
        import './apps/web/app/dsh-upstream/design-platform.css';
        import './apps/web/app/dsh-upstream/base.css';
        import '@allrice/ui/tokens.css';
        import './apps/web/app/styles/base.css';
        import '@allrice/ui/styles.css';
        const ids = ${JSON.stringify(scope)};
        function Fixture() {
          const [instanceId, setInstance] = useState(ids.instanceId), [open, setOpen] = useState(false), [serial, setSerial] = useState(0);
          const [draft, setDraft] = useState('未发送的聊天草稿');
          const headers = useMemo(() => ({ 'x-allrice-organization-id': ids.organizationId, 'x-allrice-workspace-id': ids.workspaceId }), []);
          const controller = useBrandMediaEntry({ ...ids, instanceId, headers });
          const launch = () => { setSerial(n => n + 1); setOpen(true); };
          return <div style={{ display:'flex', height:'100vh', width:'100vw' }}>
            <aside aria-label="员工侧栏" style={{ width:300, flexShrink:0 }}>
              <button onClick={() => setOpen(false)}>Rice 员工</button>
              <button onClick={() => { setOpen(false); setInstance(${JSON.stringify(id(5))}); }}>另一个员工</button>
              {controller.picker ? <BrandMediaPluginPicker controller={controller} employeeName={instanceId === ids.instanceId ? 'Rice' : '小米'}/> : <BrandMediaPluginSection controller={controller} headingId="plugins" onOpen={launch}/>}
            </aside>
            <main style={{ display:'flex', flex:1, minWidth:0 }}>
              <BrandMediaHost open={open} serial={serial} panel={controller.client ? <BrandMediaPanel key={instanceId + ':' + serial} client={controller.client} active={open} sessionId={${JSON.stringify(id(6))}} onReturn={() => setOpen(false)}/> : null}>
                <h1>原聊天</h1><textarea aria-label="聊天草稿" value={draft} onChange={e => setDraft(e.target.value)}/><span aria-label="草稿附件">原附件.pdf</span><button>发送</button>
              </BrandMediaHost>
            </main>
          </div>;
        }
        createRoot(document.getElementById('root')).render(<Fixture/>);
      `,
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/brand-media-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map(
        (entry: { path: string; contents: Uint8Array }) => [
          entry.path.slice(entry.path.lastIndexOf('/')),
          entry.contents,
        ],
      ),
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
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/stdin.js"></script></body></html>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('No browser fixture port');
    origin = 'http://127.0.0.1:' + address.port;
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
    options: Partial<State> = {},
    reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
  ) {
    const state: State = {
      installed: new Set([scope.instanceId]),
      topics: [topic()],
      articles: [article()],
      runs: [],
      requests: [],
      ...options,
    };
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion,
        timezoneId: 'Asia/Shanghai',
      }),
      page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.route('**/api/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      const body =
        req.method() === 'POST'
          ? (req.postDataJSON() as Record<string, unknown>)
          : undefined;
      state.requests.push({
        method: req.method(),
        path: path + url.search,
        body,
      });
      const reply = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(value),
        });
      if (path.endsWith('/modules')) {
        const employee = path.split('/')[4]!;
        if (body) {
          if (state.addGate && employee === scope.instanceId)
            await state.addGate;
          state.installed.add(employee);
          return reply({ binding });
        }
        return reply({
          modules: [
            {
              descriptor: {
                id: 'allrice.brand-media',
                displayName: '品牌自媒体',
              },
              binding: state.installed.has(employee)
                ? { ...binding, instanceId: employee }
                : null,
              enabled: state.installed.has(employee),
              available: !state.installed.has(employee),
            },
          ],
        });
      }
      if (path.endsWith('/brand-media')) {
        const view = url.searchParams.get('view');
        if (!body) {
          if (view === 'help') {
            if (state.helpGate) await state.helpGate;
            return reply({
              content: '# 使用说明\n填写方向，再把喜欢的候选加入选题库。',
              checksum,
            });
          }
          if (view === 'runs') {
            if (
              state.failAllRecovery ||
              (state.failRecoveryAfterGenerate && state.runs.length)
            )
              return reply({ message: '恢复读取暂时失败' }, 503);
            return reply({ runs: state.runs });
          }
          if (view === 'topics')
            return reply({
              view,
              items: state.topics,
              nextCursor:
                state.moreTopics && !url.searchParams.has('cursor')
                  ? cursor
                  : null,
            });
          if (view === 'article')
            return reply({
              view,
              article:
                state.articles.find(
                  (row) => row.id === url.searchParams.get('articleId'),
                ) ?? article(99),
            });
          if (view === 'articles')
            return reply({
              view,
              items: state.articles
                .filter(
                  (row) =>
                    !url.searchParams.has('state') ||
                    row.publication.state === url.searchParams.get('state'),
                )
                .filter((row) => !state.moreArticles || row.id !== id(99)),
              nextCursor: state.moreArticles ? cursor : null,
            });
          if (view === 'calendar') {
            const month = url.searchParams.get('month')!;
            return reply({
              view,
              items: state.articles.filter((row) =>
                row.publication.schedule?.plannedAt.startsWith(month),
              ),
            });
          }
        }
        if (body?.operation === 'candidates' || body?.operation === 'article') {
          if (state.failGenerateOnce) {
            state.failGenerateOnce = false;
            return reply({ message: '网络中断，请重试' }, 503);
          }
          const row = recovery(
            body.operation,
            'queued',
            310 + state.runs.length * 2,
          );
          row.invocation.intent = body;
          state.runs.unshift(row);
          return reply({
            run: row.run,
            invocation: row.invocation,
            userMessage: { sessionId: row.sessionId },
          });
        }
        if (body?.operation === 'topic.add') {
          if (state.failCandidateOnce) {
            state.failCandidateOnce = false;
            return reply({ message: '选入请求网络中断' }, 503);
          }
          const run = state.runs.find((row) => row.run.id === body.sourceRunId);
          run?.addedCandidates.push(
            body.candidate as BrandMediaTopic['candidate'],
          );
          const added = {
            ...topic(11),
            candidate: body.candidate,
          } as BrandMediaTopic;
          state.topics.push(added);
          return reply({
            result: { kind: 'topic', topic: added },
            replayed: false,
          });
        }
        if (body?.operation === 'article.start') {
          const added = {
            ...article(21),
            body: null,
            requirements: body.requirements,
            references: body.references,
          } as BrandMediaArticle;
          state.articles.unshift(added);
          return reply({
            result: { kind: 'article', article: added },
            replayed: false,
          });
        }
        if (body?.operation === 'article.references') {
          const row = state.articles.find((row) => row.id === body.articleId)!;
          row.references = body.references as BrandMediaArticle['references'];
          row.revision++;
          return reply({
            result: { kind: 'article', article: row },
            replayed: false,
          });
        }
      }
      if (path.endsWith('/cancel')) {
        const row = state.runs.find((row) => path.includes(row.run.id))!;
        row.run = runSnapshot(Number(row.run.id.slice(-12)), 'canceled');
        return reply({ run: row.run });
      }
      if (path.endsWith('/events'))
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: '',
        });
      if (path.endsWith('/download'))
        return route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: '不可直接改写的正文\n第二段',
        });
      if (path === '/api/v1/references/publications') {
        const query = url.searchParams.get('query') ?? '';
        return reply({
          viewerId: scope.ownerId,
          references: query
            ? refs.filter((row) => row.fileName.includes(query))
            : url.searchParams.has('cursor')
              ? [refs[1]]
              : [refs[0]],
          nextCursor:
            !query && !url.searchParams.has('cursor')
              ? {
                  queryDigest: checksum,
                  createdAt: stamp,
                  sourceId: refs[0]!.sourceId,
                }
              : null,
        });
      }
      if (path.endsWith('/selection')) {
        const row = refs.find((row) => path.includes(row.revisionId))!;
        return reply({
          viewerId: scope.ownerId,
          workspaceId: scope.workspaceId,
          selection: {
            sourceId: row.sourceId,
            revisionId: row.revisionId,
            revision: row.revision,
            fileName: row.fileName,
            purpose: row.purpose,
            digest: checksum,
            checksum,
            ownership: row.ownership,
          },
          canReference: true,
        });
      }
      if (path === '/api/v1/workbench/files') {
        if (body) return reply({ objectId: id(90) }, 201);
        return reply({
          viewerId: scope.ownerId,
          files: [
            {
              objectId: id(90),
              workspaceId: scope.workspaceId,
              fileName: '品牌参考.jpg',
              mediaType: 'image/jpeg',
              checksum,
              sizeBytes: 4,
              createdAt: stamp,
              ownedByMe: true,
              canMaintain: true,
              revision: 0,
              sharing: {
                scope: 'personal',
                departmentIds: [],
                departmentNames: [],
              },
              category: 'upload',
              sessionIds: [],
              artifact: null,
              isReference: false,
              reference: null,
              origin: 'user-upload',
              sources: [],
              favorite: false,
            },
          ],
          employees: [],
          nextCursor: null,
        });
      }
      return reply(
        { message: 'Unexpected fixture request ' + req.method() + ' ' + path },
        500,
      );
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: '原聊天' }).waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const open = async () => {
      await page
        .getByRole('button', { name: '打开 品牌自媒体', exact: true })
        .click();
      await page.getByRole('tabpanel', { name: '排期表' }).waitFor();
    };
    return {
      page,
      state,
      open,
      close: async () => {
        await context.close();
        expect(errors).toEqual([]);
      },
    };
  }
  const panel = (page: Page) =>
    page.getByRole('region', { name: '品牌自媒体', exact: true });
  async function topicsPage(page: Page) {
    await page.getByRole('tab', { name: '选题库', exact: true }).click();
  }
  async function candidatesPage(page: Page) {
    await topicsPage(page);
    await page.getByRole('button', { name: '＋ 想选题', exact: true }).click();
    await page.getByLabel('内容方向', { exact: true }).waitFor();
  }
  const generates = (state: State) =>
    state.requests.filter(
      (req) =>
        req.body?.operation === 'candidates' ||
        req.body?.operation === 'article',
    );

  it('opening only the main area preserves the original draft/attachment, sidebar geometry and visible focus across all tabs', async () => {
    const f = await fixture();
    const { page } = f;
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
      'BODY',
    );
    await page.getByLabel('聊天草稿').fill('写到一半\n保留换行');
    const before = await page.getByLabel('员工侧栏').boundingBox();
    await f.open();
    expect(await page.getByLabel('员工侧栏').boundingBox()).toEqual(before);
    const slide = page.locator('[data-brand-media-host]');
    expect(
      await slide.evaluate((el) => ({
        duration: getComputedStyle(el).transitionDuration,
        timing: getComputedStyle(el).transitionTimingFunction,
      })),
    ).toEqual({ duration: '0.24s', timing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    expect(
      await page
        .getByLabel('聊天草稿')
        .evaluate((el) => !!el.closest('[inert]')),
    ).toBe(true);
    for (const tab of ['选题库', '文章库', '排期表']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(
        await page.getByRole('button', { name: 'ⓘ 使用说明' }).isVisible(),
      ).toBe(true);
    }
    await page.getByRole('button', { name: 'ⓘ 使用说明' }).click();
    await page.getByRole('dialog', { name: '使用说明' }).waitFor();
    await page.screenshot({ path: resolve(evidence, 'help-main-area.png') });
    await page
      .getByRole('button', { name: 'Rice 员工', exact: true })
      .click({ force: true });
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await expect
      .poll(() =>
        page
          .getByLabel('聊天草稿')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
      '写到一半\n保留换行',
    );
    expect(await page.getByLabel('草稿附件').textContent()).toBe('原附件.pdf');
    expect(await page.getByLabel('员工侧栏').boundingBox()).toEqual(before);
    await f.open();
    expect(
      await page.getByRole('tabpanel', { name: '排期表' }).isVisible(),
    ).toBe(true);
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await f.close();
  });

  it('reduced motion disables the main slide and late help responses cannot revive a hidden modal layer', async () => {
    let release!: () => void;
    const f = await fixture(
      {
        helpGate: new Promise<void>((done) => {
          release = done;
        }),
      },
      'reduce',
    );
    await f.open();
    expect(
      await f.page
        .locator('[data-brand-media-host]')
        .evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe('0s');
    await f.page.getByRole('button', { name: 'ⓘ 使用说明' }).click();
    await expect
      .poll(() =>
        f.state.requests.some((req) => req.path.includes('view=help')),
      )
      .toBe(true);
    await f.page
      .getByRole('button', { name: 'Rice 员工', exact: true })
      .click();
    release();
    await expect
      .poll(() =>
        f.page
          .getByLabel('聊天草稿')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    await f.page.keyboard.press('Escape');
    expect(await f.page.getByRole('dialog').count()).toBe(0);
    await f.open();
    expect(await f.page.getByRole('dialog').count()).toBe(0);
    await f.close();
  });

  it('the side picker uses the approved hierarchy and native checkbox; a late A addition cannot disable B', async () => {
    let release!: () => void;
    const f = await fixture({
      installed: new Set(),
      addGate: new Promise<void>((done) => {
        release = done;
      }),
    });
    const { page } = f;
    await page.getByRole('button', { name: '添加插件' }).click();
    expect(
      await page
        .getByRole('heading', { name: '添加插件', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByText('选择插件，添加给 Rice。', { exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByText('想选题、写文章、安排发布计划', { exact: true })
        .isVisible(),
    ).toBe(true);
    expect(await page.getByRole('dialog').count()).toBe(0);
    await page
      .getByRole('checkbox', { name: '品牌自媒体', exact: true })
      .check();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect
      .poll(
        () =>
          f.state.requests.filter(
            (req) => req.method === 'POST' && req.path.endsWith('/modules'),
          ).length,
      )
      .toBe(1);
    await page.getByRole('button', { name: '另一个员工' }).click();
    await page.getByRole('button', { name: '添加插件' }).click();
    await page
      .getByRole('checkbox', { name: '品牌自媒体', exact: true })
      .check();
    expect(
      await page.getByRole('button', { name: '添加', exact: true }).isEnabled(),
    ).toBe(true);
    release();
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await page
      .getByRole('button', { name: '打开 品牌自媒体', exact: true })
      .waitFor();
    const adds = f.state.requests.filter(
      (req) => req.method === 'POST' && req.path.endsWith('/modules'),
    );
    expect(adds).toHaveLength(2);
    expect(adds[0]!.body!.instanceId).toBe(scope.instanceId);
    expect(adds[1]!.body!.instanceId).toBe(id(5));
    expect(adds[0]!.body!.requestId).not.toBe(adds[1]!.body!.requestId);
    expect(
      await page
        .getByText('带有独立界面的工具，点击打开新页面。', { exact: true })
        .isVisible(),
    ).toBe(true);
    await f.close();
  });

  it('candidate direction, references and immutable candidates stay on one page, and only a human adds a topic', async () => {
    const f = await fixture({
      runs: [recovery('candidates')],
      moreTopics: true,
    });
    const { page } = f;
    await f.open();
    await topicsPage(page);
    expect(
      await page.getByRole('heading', { name: '已加载 1 个选题' }).isVisible(),
    ).toBe(true);
    await candidatesPage(page);
    expect(
      await page.getByRole('button', { name: '← 选题库' }).isVisible(),
    ).toBe(true);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(
      await page
        .getByRole('heading', { name: '十分钟的新品体验', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(f.state.topics).toHaveLength(1);
    await page.getByRole('button', { name: '加入选题库', exact: true }).click();
    await expect.poll(() => f.state.topics.length).toBe(2);
    const selected = f.state.requests.find(
      (req) => req.body?.operation === 'topic.add',
    )!.body!;
    expect(selected.sourceRunId).toBe(id(300));
    expect(selected.candidate).toEqual({
      title: '十分钟的新品体验',
      summary: '下班后的轻松时刻',
    });
    expect(selected).not.toHaveProperty('moduleInvocation');
    await page.getByRole('button', { name: '已加入 ✓', exact: true }).waitFor();
    await page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await candidatesPage(page);
    expect(
      await page
        .getByRole('button', { name: '已加入 ✓', exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(
      f.state.requests.filter((req) => req.body?.operation === 'topic.add'),
    ).toHaveLength(1);
    await page.getByRole('button', { name: '← 选题库' }).click();
    expect(
      await page.getByRole('heading', { name: '已加载 2 个选题' }).isVisible(),
    ).toBe(true);
    await f.close();
  });

  it('candidate selection keeps the same operation identity after an uncertain request and a full host remount', async () => {
    const f = await fixture({
      runs: [recovery('candidates')],
      failCandidateOnce: true,
    });
    await f.open();
    await candidatesPage(f.page);
    await f.page
      .getByRole('button', { name: '加入选题库', exact: true })
      .click();
    await f.page.getByText('选入请求网络中断', { exact: false }).waitFor();
    await f.page.getByRole('button', { name: '← 回到对话' }).click();
    await f.open();
    await candidatesPage(f.page);
    await f.page
      .getByRole('button', { name: '加入选题库', exact: true })
      .click();
    await f.page
      .getByRole('button', { name: '已加入 ✓', exact: true })
      .waitFor();
    const adds = f.state.requests.filter(
      (req) => req.body?.operation === 'topic.add',
    );
    expect(adds).toHaveLength(2);
    expect(adds[1]!.body!.requestId).toBe(adds[0]!.body!.requestId);
    expect(f.state.topics).toHaveLength(2);
    await f.close();
  });

  it.each(['failed', 'canceled'] as const)(
    'cold article %s retry sends the original instructions, exact target and pins as a new controlled request',
    async (status) => {
      const failed = recovery('article', status),
        pin = { origin: 'upload', file: { objectId: id(90), checksum } };
      failed.invocation.intent.instructions = '保留结构，给通勤族增加真实场景';
      failed.invocation.intent.references = [pin];
      const f = await fixture({ runs: [failed] });
      await f.open();
      await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
      await f.page.getByRole('button', { name: '重试', exact: true }).click();
      await f.page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
      const sent = generates(f.state);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body).toMatchObject({
        operation: 'article',
        articleId: id(20),
        expectedRevision: 1,
        instructions: failed.invocation.intent.instructions,
        references: [pin],
        sessionId: failed.sessionId,
      });
      expect(sent[0]!.body!.requestId).not.toBe(
        failed.invocation.intent.requestId,
      );
      expect(sent[0]!.body).not.toHaveProperty('deliveryMode');
      await f.close();
    },
  );

  it('applies legal topics, articles and calendar even when recovery reading fails, and preserves cancel for an unavailable historical target', async () => {
    const missing = recovery('article', 'queued');
    missing.invocation.intent.articleId = id(777);
    missing.unavailable = true;
    const scheduled = article();
    scheduled.publication = {
      state: 'scheduled',
      schedule: { plannedAt: '2026-11-20T08:00:00.000Z', timezone: 'UTC' },
      links: null,
    };
    const f = await fixture({
      failAllRecovery: true,
      articles: [scheduled],
      runs: [missing],
    });
    await f.open();
    await f.page.getByText('恢复读取暂时失败', { exact: false }).waitFor();
    await f.page
      .getByRole('button', { name: '文章 20', exact: true })
      .waitFor();
    await topicsPage(f.page);
    await f.page
      .getByRole('heading', { name: '1 个选题', exact: true })
      .waitFor();
    await f.page.getByRole('tab', { name: '文章库', exact: true }).click();
    await f.page
      .getByRole('heading', { name: '文章 20', exact: true })
      .waitFor();
    f.state.failAllRecovery = false;
    await f.page.getByRole('button', { name: '刷新', exact: true }).click();
    await f.page
      .getByText(
        '这次生成的文章或参考资料已不可用。已保存的成果可在交付成果中核对。',
      )
      .waitFor();
    await f.page.getByRole('button', { name: '取消', exact: true }).click();
    await f.page.getByText('已取消生成', { exact: true }).waitFor();
    expect(
      f.state.requests.some((req) => req.path.includes(id(300) + '/cancel')),
    ).toBe(true);
    expect(
      await f.page.getByRole('button', { name: '重试', exact: true }).count(),
    ).toBe(0);
    await f.close();
  });

  it('uncertain HTTP retry keeps its request ID, native active Run disables regeneration, cancel and terminal retry use actual Run facts', async () => {
    const f = await fixture({ failGenerateOnce: true });
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('给通勤上班族想几个新品选题');
    const action = page.getByRole('button', {
      name: '让 Rice 想选题 / 换一批',
      exact: true,
    });
    await action.click();
    await page.getByText('网络中断，请重试', { exact: true }).waitFor();
    await action.click();
    await page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    expect(generates(f.state)).toHaveLength(2);
    expect(generates(f.state)[1]!.body!.requestId).toBe(
      generates(f.state)[0]!.body!.requestId,
    );
    expect(await action.isDisabled()).toBe(true);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('已取消生成', { exact: true }).waitFor();
    expect(await action.isEnabled()).toBe(true);
    await action.click();
    await expect.poll(() => generates(f.state).length).toBe(3);
    expect(generates(f.state)[2]!.body!.requestId).not.toBe(
      generates(f.state)[1]!.body!.requestId,
    );
    expect(generates(f.state)[2]!.body).toMatchObject({
      operation: 'candidates',
      direction: '给通勤上班族想几个新品选题',
      sessionId: id(6),
    });
    expect(generates(f.state)[2]!.body).not.toHaveProperty('deliveryMode');
    await f.close();
  });

  it('uses the new native Run receipt to keep generation disabled and cancellable when recovery reading fails', async () => {
    const f = await fixture({ failRecoveryAfterGenerate: true }),
      { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('面向上班族的新品选题');
    const action = page.getByRole('button', {
      name: '让 Rice 想选题 / 换一批',
      exact: true,
    });
    await action.click();
    await page.getByText('已排队，等待当前员工', { exact: true }).waitFor();
    await page.getByText('恢复读取暂时失败', { exact: false }).waitFor();
    expect(await action.isDisabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: '取消', exact: true }).isVisible(),
    ).toBe(true);
    expect(generates(f.state)).toHaveLength(1);
    f.state.failRecoveryAfterGenerate = false;
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('已取消生成', { exact: true }).waitFor();
    expect(await action.isEnabled()).toBe(true);
    await f.close();
  });

  it('start writing accepts empty optional requirements and editing stays inline below a read-only body', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await topicsPage(page);
    await page.getByRole('button', { name: '写正文', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '写正文' });
    await modal.waitFor();
    expect(await modal.getByLabel('补充写作要求（可选）').inputValue()).toBe(
      '',
    );
    expect(
      await modal
        .getByRole('button', { name: '开始写', exact: true })
        .isEnabled(),
    ).toBe(true);
    await modal.getByRole('button', { name: '开始写', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    const start = f.state.requests.find(
      (req) => req.body?.operation === 'article.start',
    )!.body!;
    expect(start.requirements).toBe('');
    expect(generates(f.state)[0]!.body).toMatchObject({
      operation: 'article',
      articleId: id(21),
      expectedRevision: 1,
    });
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page.getByRole('button', { name: '文章 20', exact: true }).click();
    const body = page.getByLabel('文章正文');
    await expect.poll(() => body.textContent()).toContain('不可直接改写的正文');
    expect(
      await body.locator('textarea,input,[contenteditable=true]').count(),
    ).toBe(0);
    expect(await page.getByLabel('修改意见').isVisible()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: '修改', exact: true })
        .isDisabled(),
    ).toBe(true);
    await page.getByLabel('修改意见').fill('缩短第二段');
    await page.getByRole('button', { name: '修改', exact: true }).click();
    await expect.poll(() => generates(f.state).length).toBe(2);
    expect(generates(f.state)[1]!.body).toMatchObject({
      operation: 'article',
      articleId: id(20),
      expectedRevision: 1,
      instructions: '缩短第二段',
    });
    expect(
      f.state.requests.some((req) => req.body?.operation === 'article.submit'),
    ).toBe(false);
    await f.close();
  });

  it('enterprise search and cursor use exact selection pins, preserve multiselect and scope labels', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: '添加参考资料' });
    await modal.waitFor();
    await modal
      .getByRole('checkbox', { name: '品牌介绍.txt · v2', exact: true })
      .check();
    expect(await modal.getByText('公司', { exact: true }).isVisible()).toBe(
      true,
    );
    await modal.getByRole('button', { name: '加载更多资料' }).click();
    await modal
      .getByRole('checkbox', { name: '客户问题.txt · v2', exact: true })
      .check();
    await modal.getByRole('button', { name: '添加所选资料' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    const selected = f.state.requests.filter((req) =>
      req.path.includes('/selection'),
    );
    expect(selected).toHaveLength(2);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    await modal.getByLabel('搜索企业资料').fill('客户');
    await expect.poll(() => modal.getByRole('checkbox').count()).toBe(1);
    expect(
      await modal
        .getByRole('checkbox', { name: '客户问题.txt · v2', exact: true })
        .isChecked(),
    ).toBe(true);
    await modal.getByRole('button', { name: '添加所选资料' }).click();
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('把两个企业资料结合起来');
    await page
      .getByRole('button', { name: '让 Rice 想选题 / 换一批', exact: true })
      .click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    expect(generates(f.state)[0]!.body!.references).toEqual(
      refs.map((row) => ({
        origin: 'reference',
        sourceId: row.sourceId,
        revisionId: row.revisionId,
      })),
    );
    expect(
      f.state.requests.some(
        (req) =>
          req.path.includes('cursor=') &&
          req.path.startsWith('/api/v1/references/publications'),
      ),
    ).toBe(true);
    await f.close();
  });

  it('upload saves a JPG in private deliverables and nominates its upload pin without publishing or creating an index', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: '添加参考资料' });
    await modal.getByRole('tab', { name: '上传文件', exact: true }).click();
    await modal.getByLabel('上传参考文件').setInputFiles({
      name: '品牌参考.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from([255, 216, 255, 217]),
    });
    await modal.getByRole('button', { name: '上传并添加' }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page
      .getByLabel('内容方向', { exact: true })
      .fill('参考这张产品照片想选题');
    await page
      .getByRole('button', { name: '让 Rice 想选题 / 换一批', exact: true })
      .click();
    await expect.poll(() => generates(f.state).length).toBe(1);
    expect(generates(f.state)[0]!.body!.references).toEqual([
      { origin: 'upload', file: { objectId: id(90), checksum } },
    ]);
    const upload = f.state.requests.find(
      (req) =>
        req.method === 'POST' && req.path.startsWith('/api/v1/workbench/files'),
    )!;
    expect(upload.body).toMatchObject({
      fileName: '品牌参考.jpg',
      mediaType: 'image/jpeg',
      workspaceId: scope.workspaceId,
    });
    expect(
      f.state.requests.some(
        (req) =>
          req.method === 'POST' && req.path.startsWith('/api/v1/references'),
      ),
    ).toBe(false);
    expect(
      f.state.requests.some((req) => req.path.includes('/reference?')),
    ).toBe(false);
    await f.close();
  });

  it('closing with a candidate reference Modal releases its focus layer and keeps the original conversation', async () => {
    const f = await fixture();
    const { page } = f;
    await f.open();
    await candidatesPage(page);
    await page
      .getByRole('button', { name: '添加参考资料', exact: true })
      .click();
    await page.getByRole('dialog', { name: '添加参考资料' }).waitFor();
    await page
      .getByRole('button', { name: 'Rice 员工', exact: true })
      .click({ force: true });
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await expect
      .poll(() =>
        page
          .getByLabel('聊天草稿')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.getByLabel('聊天草稿').inputValue()).toBe(
      '未发送的聊天草稿',
    );
    await f.close();
  });

  it('a calendar article beyond the first page stays selected after filter reset and Run refresh; conflicts report retained delivery facts', async () => {
    const old = article(99),
      receipt = recovery('article');
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    old.publication = {
      state: 'scheduled',
      schedule: {
        plannedAt: month + '-16T08:00:00.000Z',
        timezone: 'Asia/Shanghai',
      },
      links: null,
    };
    receipt.invocation.intent.articleId = old.id;
    receipt.submission = { articleUpdated: false, revision: null };
    const f = await fixture({
      articles: [article(), old],
      moreArticles: true,
      runs: [receipt],
    });
    const { page } = f;
    await f.open();
    await page.getByRole('tab', { name: '文章库', exact: true }).click();
    await page.getByRole('button', { name: '草稿', exact: true }).click();
    await page.getByRole('tab', { name: '排期表', exact: true }).click();
    await page
      .getByRole('button', { name: '月历里的旧文章', exact: true })
      .click();
    await page
      .getByRole('heading', { name: '月历里的旧文章', exact: true })
      .waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    expect(
      await page
        .getByRole('heading', { name: '月历里的旧文章', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByText('本次正文成果已保留，文章未更新，请核对当前文章。', {
          exact: true,
        })
        .isVisible(),
    ).toBe(true);
    expect(
      await page
        .getByRole('link', { name: '查看本次正文成果' })
        .getAttribute('href'),
    ).toContain(file.objectId);
    expect(
      await page
        .getByRole('button', { name: '修改排期', exact: true })
        .isVisible(),
    ).toBe(true);
    await f.close();
  });
});
