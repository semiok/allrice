import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from '../../../worker/node_modules/playwright-core/index.js';
import {
  BrandContentBoardSchema,
  BrandFeedbackInputSchema,
  type BrandContentBoard,
  type WorkflowPackage,
} from '@allrice/contracts';
import {
  BrandContentArticleCard,
  BrandContentPlanCard,
  BrandContentTopicCard,
  brandContentStageAvailable,
  brandContentZonedTime,
  currentBrandContentApproval,
  currentBrandContentBundle,
  selectableBrandContentImages,
} from './brand-content-panel';

// Display fixtures only. They do not represent real publications, files or Runs.
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const now = '2026-10-20T03:00:00.000Z';
function boardFixture(): BrandContentBoard {
  return BrandContentBoardSchema.parse({
    brand: {
      id: id(1),
      name: '测试品牌',
      revision: 2,
      contextRevisionId: id(2),
      createdAt: now,
      updatedAt: now,
    },
    contexts: [
      {
        id: id(2),
        brandName: '测试品牌',
        number: 1,
        digest: digest('a'),
        createdAt: now,
        content: {
          audience: '需要真实依据的用户',
          tone: '准确清楚',
          requirements: '只采用已确认的事实',
          visualBrief: '',
          facts: [
            {
              id: 'fact_one',
              text: '仅用于单测的事实 <script>unsafe</script>',
            },
          ],
          sourceFiles: [{ objectId: id(3), checksum: digest('b') }],
          strategies: [],
        },
      },
    ],
    batches: [
      {
        id: id(4),
        contextRevisionId: id(2),
        platform: '小红书',
        revision: 2,
        topicIds: [id(5)],
        workflow: null,
        createdAt: now,
      },
    ],
    topics: [
      {
        id: id(5),
        contextRevisionId: id(2),
        platform: '小红书',
        revision: 2,
        state: 'accepted',
        decisionReason: '方向已确认',
        createdAt: now,
        candidate: {
          title: '展示稿件 <script>unsafe</script>',
          angle: '基于事实展开',
          outline: '第一段\n第二段',
          audience: '普通读者',
          rationale: '因为事实可核对',
          factIds: ['fact_one'],
          imageBrief: '',
          suggestedWindow: '',
        },
      },
    ],
    articles: [
      {
        id: id(6),
        topicId: id(5),
        topicRevision: 2,
        contextRevisionId: id(2),
        platform: '小红书',
        sessionId: id(7),
        revision: 3,
        state: 'awaiting_review',
        currentBundleId: id(9),
        createdAt: now,
        updatedAt: now,
      },
    ],
    bundles: [
      {
        id: id(9),
        articleId: id(6),
        number: 2,
        content: { objectId: id(10), versionId: id(11), checksum: digest('c') },
        images: [],
        digest: digest('d'),
        parentBundleId: id(8),
        changeSummary: '第二版修改说明',
        sourceReviewId: null,
        workflow: null,
        createdAt: now,
      },
      {
        id: id(8),
        articleId: id(6),
        number: 1,
        content: { objectId: id(12), versionId: id(13), checksum: digest('e') },
        images: [],
        digest: digest('f'),
        parentBundleId: null,
        changeSummary: '第一版说明',
        sourceReviewId: null,
        workflow: null,
        createdAt: now,
      },
    ],
    reviews: [
      {
        id: id(14),
        articleId: id(6),
        bundleId: id(8),
        bundleDigest: digest('f'),
        decision: 'approved',
        reason: '历史第一版通过',
        decidedBy: id(15),
        createdAt: now,
      },
    ],
    plans: [
      {
        id: id(16),
        articleId: id(6),
        bundleId: id(9),
        bundleDigest: digest('d'),
        reviewId: id(17),
        revision: 1,
        platform: '小红书',
        plannedAt: '2026-10-21T02:00:00.000Z',
        timezone: 'Asia/Shanghai',
        publisher: '单测发布者',
        notes: '',
        state: 'planned',
        reminderStatus: 'registered',
        automationId: id(18),
        automationRunId: null,
        runId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    receipts: [],
    truncated: false,
  });
}
const act = async () => true;
const start = async () => {};
function approvedFixture() {
  const board = boardFixture();
  board.articles[0]!.state = 'approved';
  board.reviews.push({
    ...board.reviews[0]!,
    id: id(17),
    bundleId: id(9),
    bundleDigest: digest('d'),
    reason: '当前第二版准确通过',
  });
  return board;
}

describe('current brand-content versions', () => {
  it('resolves the current bundle by exact identity rather than array order', () => {
    const board = boardFixture();
    expect(currentBrandContentBundle(board, board.articles[0]!)?.number).toBe(
      2,
    );
    board.bundles[0]!.articleId = id(99);
    expect(
      currentBrandContentBundle(board, board.articles[0]!),
    ).toBeUndefined();
  });

  it('requires approved article state plus the same current bundle and digest', () => {
    const board = boardFixture();
    expect(
      currentBrandContentApproval(board, board.articles[0]!),
    ).toBeUndefined();
    board.articles[0]!.state = 'approved';
    expect(
      currentBrandContentApproval(board, board.articles[0]!),
    ).toBeUndefined();
    const approved = approvedFixture();
    expect(
      currentBrandContentApproval(approved, approved.articles[0]!)?.id,
    ).toBe(id(17));
    approved.bundles[0]!.digest = digest('0');
    expect(
      currentBrandContentApproval(approved, approved.articles[0]!),
    ).toBeUndefined();
  });

  it('shows exact current download, preserves old download and does not reuse historical approval', () => {
    const board = boardFixture();
    const html = renderToStaticMarkup(
      <BrandContentArticleCard
        board={board}
        article={board.articles[0]!}
        files={[]}
        disabled={false}
        draftKey="test.article"
        onMutate={act}
        onStart={start}
        onOpenSession={() => {}}
        onPlans={() => {}}
        revisionAvailable
        headers={{}}
      />,
    );
    expect(html).toContain('下载当前稿件 v2');
    expect(html).toContain('历史稿件 v1');
    expect(html).toContain(id(11));
    expect(html).toContain(digest('d'));
    expect(html).toContain('审稿通过');
    expect(html).not.toContain('去排期');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('retains rejection feedback and starts revision only for a returned draft', () => {
    const board = boardFixture();
    board.articles[0]!.state = 'changes_requested';
    board.reviews.push({
      ...board.reviews[0]!,
      id: id(17),
      bundleId: id(9),
      bundleDigest: digest('d'),
      decision: 'rejected',
      reason: '请补充事实出处',
    });
    const html = renderToStaticMarkup(
      <BrandContentArticleCard
        board={board}
        article={board.articles[0]!}
        files={[]}
        disabled={false}
        draftKey="test.revision"
        onMutate={act}
        onStart={start}
        onOpenSession={() => {}}
        onPlans={() => {}}
        revisionAvailable
        headers={{}}
      />,
    );
    expect(html).toContain('请补充事实出处');
    expect(html).toContain('按审稿意见重新起草');
    expect(html).not.toContain('去排期');
    expect(html).not.toContain('对当前稿件 v2 的审稿意见');
  });

  it('uses the topic context for reasons and facts and permits drafting only after acceptance', () => {
    const board = boardFixture();
    const render = () =>
      renderToStaticMarkup(
        <BrandContentTopicCard
          board={board}
          topic={board.topics[0]!}
          files={[]}
          disabled={false}
          draftKey="test.topic"
          onMutate={act}
          onStart={start}
          articleAvailable
          onArticles={() => {}}
        />,
      );
    board.articles = [];
    expect(render()).toContain('让 AI 员工起草');
    expect(render()).toContain('因为事实可核对');
    expect(render()).toContain('仅用于单测的事实 &lt;script&gt;');
    board.topics[0]!.state = 'candidate';
    const pending = render();
    expect(pending).toContain('采纳选题');
    expect(pending).toContain('弃选');
    expect(pending).not.toContain('让 AI 员工起草');
  });
});

describe('publication and image honesty', () => {
  it('does not claim a registered reminder or schedule proves publication', () => {
    const board = approvedFixture();
    const html = renderToStaticMarkup(
      <BrandContentPlanCard
        board={board}
        plan={board.plans[0]!}
        disabled={false}
        draftKey="test.plan"
        onMutate={act}
      />,
    );
    expect(html).toContain('已排期 · 待人工发布');
    expect(html).toContain('提醒已登记，尚未确认执行');
    expect(html).toContain('实际发布后，填写人工回执');
    expect(html).toContain('真实公开发布链接');
    expect(html).not.toContain('发布成功');
    expect(html).not.toContain('提醒已送达原会话');
  });

  it('offers reminder registration only while unregistered, without inferring delivery from a Run ID', () => {
    const board = approvedFixture();
    const plan = board.plans[0]!;
    plan.reminderStatus = 'not_registered';
    const render = () =>
      renderToStaticMarkup(
        <BrandContentPlanCard
          board={board}
          plan={plan}
          disabled={false}
          draftKey="test.reminder.register"
          onMutate={act}
          onRegisterReminder={start}
          onOpenSession={() => {}}
        />,
      );
    expect(render()).toContain('开启到点提醒');
    expect(render()).not.toContain('查看提醒');
    plan.reminderStatus = 'registered';
    plan.runId = id(65);
    expect(render()).not.toContain('开启到点提醒');
    expect(render()).not.toContain('查看提醒');
    expect(render()).not.toContain('提醒已送达原会话');
  });

  it('links an actually delivered reminder to its original session even without a model Run', () => {
    const board = approvedFixture();
    const plan = board.plans[0]!;
    Object.assign(plan, {
      reminderStatus: 'reminded',
      reminderMessageId: id(66),
      runId: null,
      automationRunId: null,
    });
    const html = renderToStaticMarkup(
      <BrandContentPlanCard
        board={board}
        plan={plan}
        disabled={false}
        draftKey="test.reminder.delivered"
        onMutate={act}
        onOpenSession={() => {}}
      />,
    );
    expect(html).toContain('提醒已送达原会话');
    expect(html).toContain('查看提醒');
    expect(html).not.toContain('开启到点提醒');
    expect(html).toContain('已排期 · 待人工发布');
    expect(html).not.toContain('已提供人工发布回执');
  });

  it('labels a human-provided record as unverified and renders its actual recorded time', () => {
    const board = approvedFixture();
    board.receipts.push({
      id: id(19),
      planId: id(16),
      bundleDigest: digest('d'),
      platform: '小红书',
      publisher: '单测发布者',
      publishedUrl: 'https://www.xiaohongshu.com/explore/synthetic-unit-test',
      actualPublishedAt: '2026-10-21T04:30:00.000Z',
      sourceType: 'manual_confirmation',
      evidence: '合成单测依据，不是真实回执',
      evidenceFiles: [],
      recordedBy: id(15),
      verificationState: 'provided',
      createdAt: now,
    });
    const html = renderToStaticMarkup(
      <BrandContentPlanCard
        board={board}
        plan={board.plans[0]!}
        disabled={false}
        draftKey="test.receipt"
        onMutate={act}
      />,
    );
    expect(html).toContain('人工提供的发布记录 · 尚未核验');
    expect(html).toContain('12:30');
    expect(html).not.toContain('记录人工发布回执');
    expect(html).not.toContain('发布成功');
  });

  it('fails closed for unknown image origins and missing generated-image receipts', () => {
    const base = {
      objectId: id(30),
      checksum: digest('a'),
      fileName: 'fixture.png',
      mediaType: 'image/png',
    };
    const choices = selectableBrandContentImages([
      base,
      { ...base, objectId: id(31), sourceKind: 'uploaded' },
      { ...base, objectId: id(32), sourceKind: 'generated' },
      {
        ...base,
        objectId: id(33),
        sourceKind: 'generated',
        operationId: id(34),
      },
      {
        ...base,
        objectId: id(35),
        mediaType: 'application/pdf',
        sourceKind: 'uploaded',
      },
    ]);
    expect(choices.map((file) => file.objectId)).toEqual([id(31), id(33)]);
  });

  it('matches business workflow template keys exactly', () => {
    const packageFor = (templateKey: string) =>
      ({ manifest: { templateKey } }) as WorkflowPackage;
    expect(
      brandContentStageAvailable(
        [packageFor('other-brand-content-operations.topics')],
        'topics',
      ),
    ).toBe(false);
    expect(
      brandContentStageAvailable(
        [packageFor('brand-content-operations.topics')],
        'article',
      ),
    ).toBe(false);
    expect(
      brandContentStageAvailable(
        [packageFor('brand-content-operations.topics')],
        'topics',
      ),
    ).toBe(true);
  });
});

describe('IANA publication time conversion', () => {
  it('interprets wall time in the selected zone independently from the browser zone', () => {
    expect(brandContentZonedTime('2026-10-21T10:00', 'Asia/Shanghai')).toBe(
      '2026-10-21T02:00:00.000Z',
    );
    expect(brandContentZonedTime('2026-07-21T10:00', 'America/New_York')).toBe(
      '2026-07-21T14:00:00.000Z',
    );
    expect(brandContentZonedTime('2026-12-21T10:00', 'America/New_York')).toBe(
      '2026-12-21T15:00:00.000Z',
    );
  });

  it('rejects invalid calendars, zones, DST gaps and ambiguous repeated hours', () => {
    expect(() =>
      brandContentZonedTime('2026-02-30T10:00', 'Asia/Shanghai'),
    ).toThrow('日期或时间无效');
    expect(() =>
      brandContentZonedTime('2026-10-21T10:00', 'not-a-zone'),
    ).toThrow('IANA');
    expect(() =>
      brandContentZonedTime('2026-03-08T02:30', 'America/New_York'),
    ).toThrow('夏令时跳变');
    expect(() =>
      brandContentZonedTime('2026-11-01T01:30', 'America/New_York'),
    ).toThrow('重复出现');
    expect(() => brandContentZonedTime('', 'Asia/Shanghai')).toThrow('完整');
  });
});

const browserSuite =
  process.env.ALLRICE_RUN_BRAND_CONTENT_BROWSER === '1'
    ? describe
    : describe.skip;
browserSuite(
  'brand-content component browser checks (synthetic HTTP, no database or model)',
  () => {
    let browser: Browser;
    let server: Server;
    let origin: string;
    const board = boardFixture();
    const posts: Array<Record<string, unknown>> = [];
    let reads = 0;
    let failNextSave = true;
    let failNextReminder = true;
    let refuseNextReminder = false;

    beforeAll(async () => {
      const root = process.cwd();
      const require = createRequire(resolve(root, 'package.json'));
      const { build } = createRequire(require.resolve('tsx'))('esbuild');
      const built = await build({
        absWorkingDir: root,
        stdin: {
          contents: `import {createRoot} from 'react-dom/client'; import {BrandContentPanel} from './app/chatflow/brand-content-panel'; createRoot(document.getElementById('root')).render(<BrandContentPanel workspaceId="${id(40)}" instanceId="${id(41)}" employeeName="单测内容员工" headers={{}} onClose={()=>{}} onOpenSession={(sessionId)=>{document.documentElement.dataset.openedSession=sessionId}} />);`,
          resolveDir: resolve(root, 'apps/web'),
          sourcefile: 'brand-content-browser-fixture.tsx',
          loader: 'tsx',
        },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
        outdir: '/unused-brand-content-component-test',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const js = built.outputFiles.find((item: { path: string }) =>
        item.path.endsWith('.js'),
      )!.contents;
      const stylesheet = built.outputFiles.find((item: { path: string }) =>
        item.path.endsWith('.css'),
      )!.contents;
      server = createServer(async (request, response) => {
        const path = new URL(request.url!, 'http://localhost').pathname;
        if (path.startsWith('/api/')) {
          response.setHeader('content-type', 'application/json');
          if (request.method === 'GET') {
            reads++;
            response.end(
              JSON.stringify({
                brands: [board.brand],
                board,
                packages: [],
                files: [],
              }),
            );
            return;
          }
          let raw = '';
          for await (const chunk of request) raw += chunk;
          const input = JSON.parse(raw) as Record<string, unknown>;
          posts.push(input);
          if (path.endsWith('/reminder')) {
            if (refuseNextReminder) {
              refuseNextReminder = false;
              response.writeHead(503);
              response.end(
                JSON.stringify({
                  error: {
                    code: 'DEPENDENCY_UNAVAILABLE',
                    message: '到点提醒暂不可用，本次未登记；原排期已保留。',
                    retryable: false,
                    requestId: id(99),
                  },
                }),
              );
              return;
            }
            if (failNextReminder) {
              failNextReminder = false;
              response.writeHead(503);
              response.end(
                JSON.stringify({
                  error: 'synthetic reminder response failure',
                }),
              );
              return;
            }
            Object.assign(board.plans[0]!, {
              automationId: id(67),
              reminderStatus: 'registered',
              revision: 2,
            });
            response.end(
              JSON.stringify({
                automationId: id(67),
                planId: id(16),
                revision: 2,
                replayed: false,
              }),
            );
            return;
          }
          if (input.operation === 'context.save' && failNextSave) {
            failNextSave = false;
            response.writeHead(503);
            response.end(
              JSON.stringify({ error: 'synthetic network/service failure' }),
            );
            return;
          }
          if (input.operation === 'context.save') {
            board.contexts.push({
              ...board.contexts[0]!,
              id: id(50),
              number: 2,
              content:
                input.content as BrandContentBoard['contexts'][number]['content'],
            });
            board.brand.contextRevisionId = id(50);
            board.brand.revision++;
          } else if (input.operation === 'feedback.record') {
            board.feedback = [
              {
                ...BrandFeedbackInputSchema.strip().parse(input),
                id: id(70),
                digest: digest('a'),
                createdAt: now,
              },
            ];
          } else if (input.operation === 'article.review') {
            board.articles[0]!.state = 'changes_requested';
            board.articles[0]!.revision++;
            board.reviews.push({
              ...board.reviews[0]!,
              id: id(51),
              bundleId: id(9),
              bundleDigest: digest('d'),
              decision: 'rejected',
              reason: String(input.reason),
            });
          }
          response.end(
            JSON.stringify({
              receipt: {
                operation: input.operation,
                requestId: input.requestId,
                replayed: false,
                result: {
                  brandId: board.brand.id,
                  entityId: input.operation === 'context.save' ? id(50) : id(6),
                  revision:
                    input.operation === 'context.save'
                      ? board.brand.revision
                      : board.articles[0]!.revision,
                  state:
                    input.operation === 'context.save'
                      ? 'saved'
                      : 'changes_requested',
                },
              },
            }),
          );
          return;
        }
        response.writeHead(200, {
          'content-type':
            path === '/app.js'
              ? 'application/javascript'
              : path === '/app.css'
                ? 'text/css'
                : 'text/html',
        });
        response.end(
          path === '/app.js'
            ? js
            : path === '/app.css'
              ? stylesheet
              : '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="margin:0;font-family:system-ui;background:#f6f7f9;--dsw-specific-input-major:#fff;--dsw-alias-border-l2:#e3e5e9;--dsw-alias-label-primary:#202326;--dsw-alias-label-secondary:#626872"><div id="root"></div><script src="/app.js"></script></body></html>',
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Missing test loopback address');
      origin = `http://127.0.0.1:${address.port}`;
      const { chromium } = createRequire(
        resolve(root, 'apps/worker/package.json'),
      )('playwright-core');
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
          (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : chromium.executablePath()),
      });
    }, 60000);

    afterAll(async () => {
      await browser?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((done) => server.close(() => done()));
    }, 30000);

    it('contains every tab at desktop and 390px with no horizontal overflow', async () => {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
        });
        await page.goto(origin);
        const dialog = page.getByRole('dialog', { name: '内容工作台' });
        await dialog.getByLabel('品牌名称').waitFor();
        for (const label of [
          '品牌资料',
          '选题',
          '稿件',
          '排期与回执',
          '反馈与经验',
        ]) {
          await dialog
            .getByRole('button', { name: label, exact: true })
            .click();
          const bounds = await dialog.evaluate((element) => ({
            outer: element.getBoundingClientRect().right,
            inside: [...element.querySelectorAll('*')]
              .filter((item) => {
                const style = getComputedStyle(item);
                return (
                  style.display !== 'none' &&
                  style.clipPath === 'none' &&
                  item.getClientRects().length > 0
                );
              })
              .map((item) => ({
                width: item.clientWidth,
                scroll: item.scrollWidth,
              }))
              .filter((item) => item.width > 0 && item.scroll - item.width > 2),
          }));
          expect(bounds.outer).toBeLessThanOrEqual(width);
          expect(bounds.inside).toEqual([]);
        }
        await dialog
          .getByRole('button', { name: '品牌资料', exact: true })
          .click();
        if (width === 390)
          await page.screenshot({ path: '/tmp/met194-brand-content-390.png' });
        await page.close();
      }
    }, 30000);

    it('records an external metric snapshot with unknown fields, preserves a draft on refresh and rereads the saved source on mobile', async () => {
      Object.assign(board, boardFixture(), { feedback: [] });
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.goto(origin);
        const dialog = page.getByRole('dialog', { name: '内容工作台' });
        const openFeedback = async () => {
          await dialog
            .getByRole('button', { name: '反馈与经验', exact: true })
            .click();
          await dialog.getByText('录入发布反馈', { exact: true }).click();
        };
        await openFeedback();
        await dialog
          .getByLabel('发布内容标题', { exact: true })
          .fill('合成 UI 反馈样本');
        await dialog.getByLabel('平台', { exact: true }).fill('Bilibili');
        await dialog
          .getByLabel('公开发布链接', { exact: true })
          .fill('https://www.bilibili.com/video/BV1synthetic/');
        await dialog
          .getByLabel('实际发布时间（本地时间）', { exact: true })
          .fill('2026-01-01T10:00');
        await dialog
          .getByLabel('指标采样时间（本地时间）', { exact: true })
          .fill('2026-01-02T10:00');
        await dialog
          .getByLabel('数据来源链接', { exact: true })
          .fill('https://api.bilibili.com/x/web-interface/view?bvid=synthetic');
        await dialog.getByLabel('点赞', { exact: true }).fill('0');
        await dialog.getByLabel('收藏', { exact: true }).fill('2');
        await dialog
          .getByLabel('来源说明与观测证据', { exact: true })
          .fill('仅用于 UI 测试的合成观测数据。');
        await dialog
          .getByLabel('数据局限', { exact: true })
          .fill('阅读量未知，不能判断效果或转化。');
        await page.reload();
        await openFeedback();
        expect(
          await dialog.getByLabel('发布内容标题', { exact: true }).inputValue(),
        ).toBe('合成 UI 反馈样本');
        expect(
          await dialog.getByLabel('点赞', { exact: true }).inputValue(),
        ).toBe('0');
        expect(
          await dialog.getByLabel('阅读 / 播放', { exact: true }).inputValue(),
        ).toBe('');
        const previousReads = reads;
        await dialog
          .getByRole('button', { name: '保存反馈快照', exact: true })
          .click();
        await dialog
          .getByText('反馈快照已保存，未知指标保持未知。', { exact: true })
          .waitFor();
        expect(posts.at(-1)).toMatchObject({
          operation: 'feedback.record',
          publicationKind: 'imported_publication',
          metrics: {
            views: null,
            likes: 0,
            comments: null,
            shares: null,
            saves: 2,
          },
          sourceType: 'public_page',
        });
        expect(posts.at(-1)).not.toHaveProperty('receiptId');
        expect(reads).toBeGreaterThan(previousReads);
        await dialog
          .getByLabel('选择复盘样本 合成 UI 反馈样本', { exact: true })
          .waitFor();
        expect(
          await dialog
            .getByText(
              '阅读 / 播放：未知 · 点赞：0 · 评论：未知 · 分享：未知 · 收藏：2',
              { exact: true },
            )
            .count(),
        ).toBe(1);
        expect(
          await dialog
            .getByRole('link', { name: '查看数据来源', exact: true })
            .getAttribute('href'),
        ).toBe('https://api.bilibili.com/x/web-interface/view?bvid=synthetic');
        expect(
          await dialog
            .getByRole('button', { name: '复盘选中样本（0）', exact: true })
            .isDisabled(),
        ).toBe(true);
      } finally {
        await page.close();
      }
    }, 30000);

    it('preserves failed input across refresh, reuses the request ID, then rereads successful exact-version review', async () => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      await page.goto(origin);
      const dialog = page.getByRole('dialog', { name: '内容工作台' });
      await dialog.getByLabel('目标受众').fill('失败与刷新后仍保留的单测输入');
      await dialog
        .getByRole('button', { name: '保存品牌资料', exact: true })
        .click();
      await dialog.getByRole('alert').waitFor();
      expect(await dialog.getByLabel('目标受众').inputValue()).toBe(
        '失败与刷新后仍保留的单测输入',
      );
      const first = posts.at(-1)!;
      expect(first.expectedRevision).toBe(2);
      expect(first.instanceId).toBe(id(41));
      expect(String(first.requestId)).toMatch(/^[\da-f-]{36}$/);
      await page.reload();
      await dialog.getByLabel('目标受众').waitFor();
      expect(await dialog.getByLabel('目标受众').inputValue()).toBe(
        '失败与刷新后仍保留的单测输入',
      );
      const previousReads = reads;
      await dialog
        .getByRole('button', { name: '保存品牌资料', exact: true })
        .click();
      await dialog.getByText('品牌资料已保存。', { exact: true }).waitFor();
      expect(posts.at(-1)!.requestId).toBe(first.requestId);
      expect(reads).toBeGreaterThan(previousReads);
      await dialog.getByRole('button', { name: '稿件', exact: true }).click();
      await dialog
        .getByLabel('对当前稿件 v2 的审稿意见')
        .fill('请补充事实出处');
      await dialog
        .getByRole('button', { name: '退回修改', exact: true })
        .click();
      await dialog
        .getByRole('button', { name: '按审稿意见重新起草', exact: true })
        .waitFor();
      expect(posts.at(-1)).toMatchObject({
        operation: 'article.review',
        articleId: id(6),
        expectedRevision: 3,
        bundleDigest: digest('d'),
        decision: 'rejected',
        reason: '请补充事实出处',
      });
      expect(
        await dialog.getByText('请补充事实出处', { exact: true }).count(),
      ).toBe(1);
      await page.close();
    }, 30000);

    it('registers a reminder with a stable request, refreshes real state, and opens only a delivered message session', async () => {
      Object.assign(board, approvedFixture());
      Object.assign(board.plans[0]!, {
        reminderStatus: 'not_registered',
        automationId: null,
        runId: null,
        automationRunId: null,
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      await page.goto(origin);
      const dialog = page.getByRole('dialog', { name: '内容工作台' });
      await dialog.getByLabel('品牌名称').waitFor();
      await dialog
        .getByRole('button', { name: '排期与回执', exact: true })
        .click();
      const register = dialog.getByRole('button', {
        name: '开启到点提醒',
        exact: true,
      });
      await register.click();
      await dialog.getByRole('alert').waitFor();
      const first = posts.at(-1)!;
      expect(first).toMatchObject({
        workspaceId: id(40),
        instanceId: id(41),
        brandId: id(1),
        planId: id(16),
        expectedRevision: 1,
      });
      expect(first).not.toHaveProperty('workflow');
      expect(first).not.toHaveProperty('workflowRevisionId');
      expect(first).not.toHaveProperty('packageDigest');
      expect(Object.keys(first).sort()).toEqual(
        [
          'workspaceId',
          'instanceId',
          'brandId',
          'planId',
          'expectedRevision',
          'requestId',
        ].sort(),
      );
      expect(
        await dialog.getByText('未登记提醒', { exact: true }).count(),
      ).toBe(1);
      const previousReads = reads;
      await register.click();
      await dialog
        .getByText('提醒已登记，尚未确认执行', { exact: true })
        .waitFor();
      expect(posts.at(-1)!.requestId).toBe(first.requestId);
      expect(reads).toBeGreaterThan(previousReads);
      expect(await register.count()).toBe(0);
      expect(
        await dialog
          .getByRole('button', { name: '查看提醒', exact: true })
          .count(),
      ).toBe(0);
      expect(
        await dialog.getByText('提醒已送达原会话', { exact: true }).count(),
      ).toBe(0);
      Object.assign(board.plans[0]!, {
        reminderStatus: 'reminded',
        reminderMessageId: id(66),
        runId: null,
        automationRunId: null,
        revision: 3,
      });
      await dialog.getByRole('button', { name: '刷新', exact: true }).click();
      await dialog.getByText('提醒已送达原会话', { exact: true }).waitFor();
      await dialog
        .getByRole('button', { name: '查看提醒', exact: true })
        .click();
      expect(
        await page.locator('html').getAttribute('data-opened-session'),
      ).toBe(id(7));
      expect(
        await dialog.getByText('已排期 · 待人工发布', { exact: true }).count(),
      ).toBe(1);
      await page.close();
    }, 30000);
    it('shows a canonical unavailable reminder as unregistered, with no automatic resend or success claim', async () => {
      Object.assign(board, approvedFixture());
      Object.assign(board.plans[0]!, {
        reminderStatus: 'not_registered',
        automationId: null,
        runId: null,
        automationRunId: null,
      });
      refuseNextReminder = true;
      const before = posts.length;
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        const dialog = page.getByRole('dialog', { name: '内容工作台' });
        await dialog.getByLabel('品牌名称').waitFor();
        await dialog
          .getByRole('button', { name: '排期与回执', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '开启到点提醒', exact: true })
          .click();
        await dialog
          .getByRole('alert')
          .getByText('到点提醒暂不可用，本次未登记；原排期已保留。', {
            exact: true,
          })
          .waitFor();
        expect(posts).toHaveLength(before + 1);
        expect(board.plans[0]!.reminderStatus).toBe('not_registered');
        expect(
          await dialog
            .getByText('提醒已登记，尚未确认执行', { exact: true })
            .count(),
        ).toBe(0);
        await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await dialog.getByText('未登记提醒', { exact: true }).waitFor();
        expect(posts).toHaveLength(before + 1);
      } finally {
        refuseNextReminder = false;
        await page.close();
      }
    }, 30000);
  },
);
