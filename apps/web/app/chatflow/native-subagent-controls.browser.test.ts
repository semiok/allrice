/** Real directory WS, root SSE, fetch and Chrome; loopback fixture, no model/DB/Dev. */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ChatFlowEventEnvelope,
  NativeSubagentControlTicket,
  NativeSubagentControlInput,
  NativeSubagentSummary,
} from '@allrice/contracts';
import { NativeSubagentFixtureFeed } from '../../test/native-subagent-fixture-feed';
import type {
  Browser,
  Page,
} from '../../../worker/node_modules/playwright-core/index.js';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const runId = '44444444-4444-4444-8444-444444444444';
const summary: NativeSubagentSummary = {
  rootId: 'native-root',
  root: { source: 'live', cursor: 10 },
  descendants: ['甲', '乙', '闲置', '一次性'].map((label, index) => ({
    kind: 'child',
    id: `native-child-${index}`,
    parentId: 'native-root',
    depth: 1,
    mode: index === 3 ? 'one-shot' : 'continuable',
    label,
    running: index !== 2,
    parentAvailable: true,
    activity: index === 2 ? 'inactive' : 'running',
    observation: { source: 'live', cursor: 8 },
    task: `${label}自己的任务`,
    lastReply: null,
    timing: { settledMs: 0 },
    usage: {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
  })),
};
type Mode =
  | 'accepted'
  | 'recorded'
  | 'unknown'
  | 'rejected'
  | 'drop'
  | 'bad-json'
  | 'wrong-id'
  | 'wrong-kind'
  | 'wrong-acceptance'
  | 'forbidden'
  | 'conflict'
  | 'closed'
  | 'server-error';
type Body = {
  rootRunId: string;
  generation: number;
  input: NativeSubagentControlInput;
};
type PostFact = { at: number; body: Body; responseStatus?: number };
type Scenario = {
  feedId: string;
  mode: Mode;
  getMode: Mode;
  posts: Body[];
  postFacts: (PostFact & { remotePort: number | undefined })[];
  gets: string[];
  rootReads: string[];
  reply?: (body: Body) => Mode;
  observationUnavailable?: boolean;
  gate?: Promise<void>;
  release?: () => void;
  uploads: {
    id: string;
    fileName: string;
    mediaType: string;
    contentBase64: string;
    sizeBytes: number;
  }[];
  uploadGate?: Promise<void>;
  firstUploadFails?: boolean;
  parentAvailable?: boolean;
};
function result(
  mode: Mode,
  kind: 'prompt' | 'interrupt' = 'interrupt',
): NativeSubagentControlTicket['result'] {
  if (mode === 'recorded' || mode === 'unknown') return { status: mode };
  if (mode === 'rejected')
    return { status: 'rejected', code: 'subagent/unauthorized' };
  return {
    status: 'accepted',
    acceptance:
      kind === 'prompt'
        ? { kind, messageId: 'native-message' }
        : { kind, accepted: true },
    source: { kind: 'native_ack' },
  };
}

suite('native child Stop request identity and truthful receipts', () => {
  let browser: Browser, server: Server, origin: string;
  const feed = new NativeSubagentFixtureFeed();
  const scenarios = new Map<string, Scenario>();
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const bundle = await build({
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
      bundle.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
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
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const id =
        url.searchParams.get('fixture') ??
        req.headers.cookie?.match(/controls-fixture=([^;]+)/)?.[1];
      const scenario = id ? scenarios.get(id) : undefined;
      if (
        scenario &&
        url.pathname.endsWith('/attachments') &&
        req.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const file = {
          ...JSON.parse(Buffer.concat(chunks).toString()),
          id: randomUUID(),
        };
        file.sizeBytes = Buffer.from(file.contentBase64, 'base64').length;
        scenario.uploads.push(file);
        if (scenario.firstUploadFails && scenario.uploads.length === 1) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: 'fixture upload failed' } }),
          );
          return;
        }
        await scenario.uploadGate;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            attachment: {
              id: file.id,
              fileName: file.fileName,
              mediaType: file.mediaType,
              sizeBytes: file.sizeBytes,
            },
          }),
        );
        return;
      }
      if (scenario && url.pathname.endsWith('/sign')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ url: `/images/${url.pathname.split('/')[4]}` }),
        );
        return;
      }
      if (scenario && url.pathname.startsWith('/images/')) {
        const file = scenario.uploads.find(
          (file) => file.id === url.pathname.split('/')[2],
        );
        res.writeHead(file ? 200 : 404, {
          'content-type': file?.mediaType ?? 'image/png',
        });
        res.end(file ? Buffer.from(file.contentBase64, 'base64') : '');
        return;
      }
      if (
        scenario &&
        (url.pathname.startsWith('/api/v1/runs/') ||
          url.searchParams.get('follow') === 'true')
      ) {
        if (url.pathname.startsWith('/api/v1/runs/'))
          scenario.rootReads.push(url.pathname.split('/')[4]!);
        url.searchParams.set('fixture', scenario.feedId);
        req.url = url.pathname + url.search;
        if (feed.handle(req, res)) return;
      }
      if (scenario && url.pathname.endsWith('/subagents/controls')) {
        const post = req.method === 'POST';
        let body: Body | undefined;
        if (post) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
          scenario.posts.push(body);
          scenario.postFacts.push({
            at: Date.now(),
            body,
            remotePort: req.socket.remotePort,
          });
          await scenario.gate;
        }
        const requestId =
          body?.input.requestId ?? url.searchParams.get('requestId')!;
        if (!post) scenario.gets.push(requestId);
        const mode = post
          ? (scenario.reply?.(body!) ?? scenario.mode)
          : scenario.getMode;
        if (mode === 'drop') {
          // Lose the ACK body after headers, without a no-response HTTP replay.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"ticket":', () => res.destroy());
          return;
        }
        const code =
          mode === 'forbidden'
            ? 'AUTHORIZATION_DENIED'
            : mode === 'conflict'
              ? 'CHILD_CONTROL_CONFLICT'
              : 'CHILD_CONTROL_UNAVAILABLE';
        const status =
          mode === 'forbidden'
            ? 403
            : mode === 'conflict' || mode === 'closed'
              ? 409
              : mode === 'server-error'
                ? 503
                : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        if (status !== 200) {
          res.end(JSON.stringify({ error: { code } }));
          return;
        }
        if (mode === 'bad-json') {
          res.end('unreadable');
          return;
        }
        const original =
          body ??
          scenario.posts.find((post) => post.input.requestId === requestId);
        const kind = original?.input.kind ?? 'interrupt';
        const ticket = {
          requestId: mode === 'wrong-id' ? randomUUID() : requestId,
          kind:
            mode === 'wrong-kind'
              ? kind === 'interrupt'
                ? 'prompt'
                : 'interrupt'
              : kind,
          ...(original?.input.kind === 'prompt'
            ? {
                message: {
                  content: original.input.content,
                  images: original.input.content.flatMap((part) =>
                    part.type === 'image'
                      ? scenario.uploads
                          .filter((file) => file.id === part.objectId)
                          .map(({ id, fileName, mediaType, sizeBytes }) => ({
                            id,
                            fileName,
                            mediaType,
                            sizeBytes,
                          }))
                      : [],
                  ),
                },
              }
            : {}),
          result:
            mode === 'wrong-acceptance'
              ? {
                  status: 'accepted',
                  acceptance: { kind: 'prompt', messageId: 'message' },
                  source: { kind: 'native_ack' },
                }
              : result(mode, kind),
        };
        res.end(JSON.stringify({ ticket }));
        return;
      }
      if (scenario && url.pathname.endsWith('/subagents')) {
        res
          .writeHead(scenario.observationUnavailable ? 503 : 200, {
            'content-type': 'application/json',
          })
          .end(
            JSON.stringify({
              summary: scenario.observationUnavailable ? null : summary,
            }),
          );
        return;
      }
      const asset = assets.get(url.pathname);
      res.setHeader(
        'content-type',
        asset
          ? url.pathname.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      if (id && !asset)
        res.setHeader(
          'set-cookie',
          `controls-fixture=${id}; Path=/; SameSite=Lax`,
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
    for (const scenario of scenarios.values()) scenario.release?.();
    await browser?.close();
    await feed.close();
    server?.closeAllConnections();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }, 60_000);

  function rootEvent(
    scenario: Scenario,
    type: 'turn.started' | 'run.succeeded',
    sequence: number,
    targetRunId = runId,
    generation = 7,
  ) {
    feed.pushRoot(scenario.feedId, {
      schemaVersion: 3,
      eventId: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      conversationId: null,
      runId: targetRunId,
      generation,
      cursor: `${targetRunId}:${sequence}`,
      sequence,
      harness: 'dsh',
      type,
      occurredAt: '2026-10-31T00:00:00Z',
      sourceEvent: null,
      payload: { turnId: 'root-turn', generation },
    } satisfies ChatFlowEventEnvelope);
  }
  async function open(mode: Mode = 'accepted', hold = false, start = true) {
    const scenario: Scenario = {
      feedId: feed.register({
        summary: () => ({
          ...summary,
          descendants: summary.descendants.map((row) =>
            row.kind === 'child'
              ? { ...row, parentAvailable: scenario.parentAvailable }
              : row,
          ),
        }),
      }),
      mode,
      getMode: 'accepted',
      posts: [],
      postFacts: [],
      gets: [],
      rootReads: [],
      uploads: [],
      parentAvailable: true,
    };
    if (hold)
      scenario.gate = new Promise<void>((done) => {
        scenario.release = done;
      });
    const id = String(scenarios.size + 1);
    scenarios.set(id, scenario);
    const page = await browser.newPage({
      viewport: { width: 390, height: 850 },
    });
    await page.addInitScript(() => {
      const target = window as unknown as { nativeControlFetches: PostFact[] },
        send = window.fetch.bind(window);
      target.nativeControlFetches = [];
      window.fetch = (input, init) => {
        let fact: PostFact | undefined;
        if (
          init?.method === 'POST' &&
          String(input).includes('/subagents/controls?')
        ) {
          fact = {
            at: Date.now(),
            body: JSON.parse(String(init.body)),
          };
          target.nativeControlFetches.push(fact);
        }
        const pending = send(input, init),
          observed = fact;
        if (observed)
          void pending.then(
            (response) => (observed.responseStatus = response.status),
            () => {},
          );
        return pending;
      };
    });
    const browserPosts = () =>
      page.evaluate(
        () =>
          (window as unknown as { nativeControlFetches: PostFact[] })
            .nativeControlFetches,
      );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?controls&fixture=${id}`);
    await expect
      .poll(
        () =>
          [...feed.rootConnections].filter((c) => c.fixture === scenario.feedId)
            .length,
      )
      .toBe(1);
    if (start) rootEvent(scenario, 'turn.started', 1);
    await show(page, '甲');
    const connections = () => ({
      directory: [...feed.connections].filter(
        (c) => c.fixture === scenario.feedId && c.childId === null,
      ).length,
      detail: [...feed.connections].filter(
        (c) => c.fixture === scenario.feedId && c.childId !== null,
      ).length,
      root: [...feed.rootConnections].filter(
        (c) => c.fixture === scenario.feedId,
      ).length,
    });
    await expect
      .poll(connections)
      .toEqual({ directory: 3, detail: 1, root: 1 });
    if (scenarios.size === 1)
      console.info(
        'Full page observations (native WS, root SSE) before Stop:',
        connections(),
      );
    return { page, scenario, errors, browserPosts };
  }
  async function show(page: Page, label: string) {
    await page.getByRole('button', { name: /4 个子智能体/ }).click();
    await page
      .getByRole('button', { name: `查看${label}摘要`, exact: true })
      .click();
    await page.getByRole('complementary', { name: '子智能体摘要' }).waitFor();
  }
  const detail = (page: Page) =>
    page.getByRole('complementary', { name: '子智能体摘要' });
  const receipt = (page: Page) =>
    detail(page).locator('[aria-label="Stop 回执"]');

  async function pasteImage(
    page: Page,
    mixed = false,
    drop = false,
    pasted = '',
  ) {
    await detail(page)
      .getByRole('textbox')
      .evaluate(
        (element, { mixed, drop, pasted }) => {
          const transfer = new DataTransfer();
          if (pasted) transfer.setData('text/plain', pasted);
          const data = Uint8Array.from(
            atob(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
            ),
            (c) => c.charCodeAt(0),
          );
          transfer.items.add(
            new File([data], '补充.png', { type: 'image/png' }),
          );
          if (mixed)
            transfer.items.add(
              new File(['bad'], '不可用.txt', { type: 'text/plain' }),
            );
          element.dispatchEvent(
            drop
              ? new DragEvent('drop', {
                  bubbles: true,
                  cancelable: true,
                  dataTransfer: transfer,
                })
              : new ClipboardEvent('paste', {
                  bubbles: true,
                  cancelable: true,
                  clipboardData: transfer,
                }),
          );
        },
        { mixed, drop, pasted },
      );
  }
  it('“图文 Queue，再纯图 Steer”：shared paste/drop, native keys and readable original receipts without persisted payloads', async () => {
    const { page, scenario, errors } = await open();
    try {
      const input = detail(page).getByRole('textbox');
      await input.fill('请核对待替换图片');
      await pasteImage(page, true);
      expect(
        await detail(page).getByRole('group', { name: '待发送附件' }).count(),
      ).toBe(0);
      await input.evaluate((element: HTMLTextAreaElement) =>
        element.setSelectionRange(3, 6),
      );
      await pasteImage(page, false, false, '这张');
      await expect.poll(() => input.inputValue()).toBe('请核对这张图片');
      await detail(page)
        .getByRole('button', { name: '移除 补充.png' })
        .waitFor();
      await input.evaluate((element) =>
        element.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true }),
        ),
      );
      await input.press('Enter');
      expect(scenario.posts).toHaveLength(0);
      await input.evaluate(async (element) => {
        element.dispatchEvent(
          new CompositionEvent('compositionend', { bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await input.fill('请核对这张图片');
      await input.press('Enter');
      await expect.poll(() => scenario.posts.length).toBe(1);
      expect(scenario.posts[0]?.input).toMatchObject({
        kind: 'prompt',
        delivery: 'queue',
        content: [
          { type: 'text', text: '请核对这张图片' },
          { type: 'image', objectId: scenario.uploads[0]!.id },
        ],
      });
      const receipts = detail(page).locator('[aria-label="发送回执"]');
      await expect
        .poll(() => receipts.textContent())
        .toContain('请核对这张图片');
      await expect.poll(() => receipts.locator('img').count()).toBe(1);
      await expect
        .poll(() =>
          receipts
            .locator('img')
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth === 1,
            ),
        )
        .toBe(true);
      expect(await receipts.textContent()).toContain(
        '消息已被原生接收；不代表已经处理',
      );
      await expect.poll(() => input.inputValue()).toBe('');
      await pasteImage(page, false, true);
      await detail(page)
        .getByRole('button', { name: '移除 补充.png' })
        .waitFor();
      await input.press('Control+Enter');
      await expect.poll(() => scenario.posts.length).toBe(2);
      expect(scenario.posts[1]?.input).toMatchObject({
        kind: 'prompt',
        delivery: 'steer',
        content: [{ type: 'image', objectId: scenario.uploads[1]!.id }],
      });
      await expect.poll(() => input.isEnabled()).toBe(true);
      await input.fill('修饰点击仍Queue');
      await detail(page)
        .getByRole('button', { name: 'Queue', exact: true })
        .click({ modifiers: ['Meta'] });
      await expect.poll(() => scenario.posts.length).toBe(3);
      expect(scenario.posts[2]?.input).toMatchObject({
        kind: 'prompt',
        delivery: 'queue',
        content: [{ type: 'text', text: '修饰点击仍Queue' }],
      });
      const stored = await page.evaluate(() =>
        Object.values(sessionStorage).join('\n'),
      );
      expect(stored).not.toContain('请核对这张图片');
      expect(stored).not.toContain('contentBase64');
      expect(stored).not.toContain(scenario.uploads[0]!.id);
      await page.reload();
      await show(page, '甲');
      const original = detail(page).locator('[aria-label="发送回执"]').first();
      await original.getByRole('button', { name: '查看回执' }).click();
      await expect
        .poll(() => original.textContent())
        .toContain('请核对这张图片');
      await expect.poll(() => original.locator('img').count()).toBe(1);
      await expect
        .poll(() =>
          original
            .locator('img')
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth === 1,
            ),
        )
        .toBe(true);
      expect(scenario.posts).toHaveLength(3);
      expect(scenario.gets).toEqual([scenario.posts[0]!.input.requestId]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('“上传中仍可 Stop；父失联后不发”：the same pending image cannot dispatch across lost parent observation', async () => {
    const { page, scenario } = await open();
    let release!: () => void;
    scenario.uploadGate = new Promise<void>((done) => {
      release = done;
    });
    try {
      await pasteImage(page);
      await detail(page)
        .getByRole('button', { name: '移除 补充.png' })
        .waitFor();
      await detail(page)
        .getByRole('button', { name: 'Queue', exact: true })
        .click();
      await expect.poll(() => scenario.uploads.length).toBe(1);
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect.poll(() => scenario.posts.length).toBe(1);
      scenario.parentAvailable = undefined;
      feed.push(scenario.feedId, {
        type: 'directory',
        summary: {
          ...summary,
          descendants: summary.descendants.map((row) =>
            row.kind === 'child' ? { ...row, parentAvailable: undefined } : row,
          ),
        },
      });
      await expect
        .poll(() => detail(page).textContent())
        .toContain('直属父智能体状态未知');
      release();
      await expect
        .poll(() => detail(page).getByText('上传中', { exact: true }).count())
        .toBe(0);
      expect(scenario.posts.map((post) => post.input.kind)).toEqual([
        'interrupt',
      ]);
      expect(
        await detail(page)
          .getByRole('button', { name: 'Queue', exact: true })
          .isDisabled(),
      ).toBe(true);
    } finally {
      release();
      await page.close();
    }
  });

  it('“A失败但B仍上传”：waits for the whole upload batch and reuses B on the next explicit Send', async () => {
    const { page, scenario } = await open();
    let release!: () => void;
    scenario.firstUploadFails = true;
    scenario.uploadGate = new Promise<void>((done) => {
      release = done;
    });
    try {
      await pasteImage(page);
      await pasteImage(page);
      const queue = detail(page).getByRole('button', {
        name: 'Queue',
        exact: true,
      });
      await expect
        .poll(() =>
          detail(page).getByRole('button', { name: '移除 补充.png' }).count(),
        )
        .toBe(2);
      await queue.click();
      await expect.poll(() => scenario.uploads.length).toBe(2);
      await expect
        .poll(() =>
          detail(page)
            .getByRole('button', { name: '重试', exact: true })
            .count(),
        )
        .toBe(1);
      expect(await queue.isDisabled()).toBe(true);
      expect(scenario.posts).toHaveLength(0);
      release();
      await expect.poll(() => queue.isEnabled()).toBe(true);
      await queue.click();
      await expect.poll(() => scenario.posts.length).toBe(1);
      expect(scenario.uploads).toHaveLength(3);
      expect(scenario.posts[0]?.input).toMatchObject({
        kind: 'prompt',
        content: [
          { type: 'image', objectId: scenario.uploads[2]!.id },
          { type: 'image', objectId: scenario.uploads[1]!.id },
        ],
      });
    } finally {
      release();
      await page.close();
    }
  });

  it('“只停甲”：double click and detail close/reopen retain one request; accepted is not stopped', async () => {
    const { page, scenario, errors } = await open('accepted', true);
    try {
      await detail(page)
        .getByRole('button', { name: 'Stop 此子任务', exact: true })
        .dblclick();
      await expect.poll(() => scenario.posts.length).toBe(1);
      await detail(page).getByRole('button', { name: '关闭摘要' }).focus();
      await page.keyboard.press('Escape');
      expect(
        await page
          .getByRole('button', { name: /4 个子智能体/ })
          .evaluate((button) => document.activeElement === button),
      ).toBe(true);
      await show(page, '甲');
      expect(
        await detail(page)
          .getByRole('button', { name: '发起新的 Stop 请求' })
          .isDisabled(),
      ).toBe(true);
      scenario.release!();
      await expect
        .poll(() => detail(page).textContent())
        .toContain(
          '停止请求已接收；不代表子任务已经停止。在途工具仍可能继续输出、生成文件和产生用量，请以实际运行状态为准。',
        );
      expect(scenario.posts).toHaveLength(1);
      expect(scenario.posts[0]).toMatchObject({
        rootRunId: runId,
        generation: 7,
        input: {
          parentSessionId: 'native-root',
          childSessionId: 'native-child-0',
          mode: 'continuable',
          kind: 'interrupt',
        },
      });
      expect(scenario.posts[0]!.input.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(await receipt(page).locator('code').textContent()).toBe(
        scenario.posts[0]!.input.requestId,
      );
      expect(await detail(page).textContent()).toContain('运行摘要 · 运行中');
      await page.keyboard.press('Escape');
      await show(page, '乙');
      await expect
        .poll(() => detail(page).textContent())
        .toContain('乙自己的任务');
      expect(await receipt(page).count()).toBe(0);
      expect(scenario.gets).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      scenario.release?.();
      await page.close();
    }
  });

  it('unknown is queried by the original ID; an explicit independent Stop keeps the old receipt', async () => {
    const { page, scenario } = await open('unknown');
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      const id = scenario.posts[0]!.input.requestId;
      scenario.getMode = 'unknown';
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect.poll(() => scenario.gets).toEqual([id]);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      expect(scenario.posts).toHaveLength(1);
      scenario.mode = 'accepted';
      await detail(page)
        .getByRole('button', { name: '发起新的 Stop 请求' })
        .click();
      await expect.poll(() => scenario.posts.length).toBe(2);
      await expect.poll(() => receipt(page).count()).toBe(2);
      expect(scenario.posts[1]!.input.requestId).not.toBe(id);
      expect(await receipt(page).first().textContent()).toContain(
        '原生接收结果未知',
      );
    } finally {
      await page.close();
    }
  });

  it('reload restores only query references and never a cached confirmation or POST', async () => {
    const { page, scenario } = await open();
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      const id = scenario.posts[0]!.input.requestId;
      const stored = await page.evaluate(() =>
        Object.entries(sessionStorage)
          .filter(([key]) => key.startsWith('allrice-child-control-refs:'))
          .map(([, value]) => JSON.parse(value)),
      );
      expect(stored).toEqual([[scenario.posts[0]]]);
      await page.reload();
      await show(page, '甲');
      expect(await detail(page).textContent()).toContain('尚无确认结果');
      expect(await detail(page).textContent()).not.toContain('停止请求已接收');
      expect(scenario.posts).toHaveLength(1);
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect.poll(() => scenario.gets).toEqual([id]);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      expect(scenario.posts).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('a late response from an unmounted business session cannot erase its successor request reference', async () => {
    const { page, scenario, errors } = await open('accepted', true);
    const releaseA = scenario.release!;
    let releaseB: (() => void) | undefined;
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect.poll(() => scenario.posts.length).toBe(1);
      const idA = scenario.posts[0]!.input.requestId;
      console.info('Unmount recovery: A held, leaving the business session');
      await detail(page).getByRole('button', { name: '关闭摘要' }).click();
      for (const [index, id] of ['parent-b', 'parent-a'].entries()) {
        await page.locator(`[data-row-key="session:${id}"]`).focus();
        await page.keyboard.press('Enter');
        await expect
          .poll(() => page.getByRole('heading', { level: 1 }).textContent())
          .toBe(`${id} 父级任务`);
        await expect.poll(() => scenario.rootReads.length).toBe(index + 2);
        await expect
          .poll(
            () =>
              [...feed.rootConnections].filter(
                (c) => c.fixture === scenario.feedId,
              ).length,
          )
          .toBe(1);
      }
      rootEvent(scenario, 'turn.started', 1);
      console.info('Unmount recovery: returned to the business session');
      await show(page, '甲');
      scenario.gate = new Promise<void>((done) => {
        releaseB = done;
      });
      await detail(page)
        .getByRole('button', { name: '发起新的 Stop 请求' })
        .click();
      await expect.poll(() => receipt(page).count()).toBe(2);
      const ids = await receipt(page).locator('code').allTextContents();
      expect(ids[0]).toBe(idA);
      expect(new Set(ids).size).toBe(2);
      const responseA = page.waitForResponse(
        (response) =>
          response.url().includes('/subagents/controls') &&
          response.request().method() === 'POST' &&
          response.request().postDataJSON().input.requestId === idA,
      );
      releaseA();
      await (await responseA).finished();
      console.info(
        'Unmount recovery: old A response delivered after B creation',
      );
      // Five held SSE plus old A occupy all six HTTP/1 connections. B is created
      // before A returns, then reaches the server and stays held through reload.
      await expect.poll(() => scenario.posts.length).toBe(2);
      expect(scenario.posts.map((body) => body.input.requestId)).toEqual(ids);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const savedIds = await page.evaluate(() =>
        Object.entries(sessionStorage)
          .filter(([key]) => key.startsWith('allrice-child-control-refs:'))
          .flatMap(([, value]) =>
            JSON.parse(value).map((r: Body) => r.input.requestId),
          ),
      );
      expect(savedIds).toEqual(ids);
      expect(await receipt(page).last().textContent()).toContain('正在提交');
      await detail(page).getByRole('button', { name: '关闭摘要' }).click();
      await expect.poll(() => detail(page).count()).toBe(0);
      // Closing detail frees a real HTTP/1 slot so navigation can start while B
      // remains held. Keep the full Sidebar and all shared directory reads.
      await expect
        .poll(
          () =>
            [...feed.connections].filter(
              (c) => c.fixture === scenario.feedId && c.childId !== null,
            ).length,
        )
        .toBe(0);
      console.info(
        'Unmount recovery: both IDs saved; reloading while B remains held',
      );
      await page.reload();
      releaseB!();
      await show(page, '甲');
      expect(await receipt(page).locator('code').allTextContents()).toEqual(
        ids,
      );
      expect(await detail(page).textContent()).not.toContain('停止请求已接收');
      for (const id of ids) {
        const original = receipt(page).filter({ hasText: id });
        await original.getByRole('button', { name: '查看回执' }).click();
        await expect
          .poll(() => original.textContent())
          .toContain('停止请求已接收');
      }
      expect(scenario.gets).toEqual(ids);
      expect(scenario.posts).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally {
      releaseA();
      releaseB?.();
      await page.close();
    }
  });

  it.each(['recorded', 'unknown'] as const)(
    '%s references remain queryable when directory and detail observation fail, including after reload',
    async (mode) => {
      const { page, scenario } = await open(mode);
      try {
        await detail(page)
          .getByRole('button', { name: 'Stop 此子任务' })
          .click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain(mode === 'recorded' ? '请求已记录' : '原生接收结果未知');
        const id = scenario.posts[0]!.input.requestId;
        scenario.observationUnavailable = true;
        feed.sources.get(scenario.feedId)!.status = 503;
        feed.end(scenario.feedId, null, true);
        feed.end(scenario.feedId, 'native-child-0', true);
        await expect
          .poll(() => detail(page).textContent())
          .toContain('暂时无法读取摘要');
        expect(await receipt(page).locator('code').textContent()).toBe(id);
        expect(
          await detail(page).getByRole('button', { name: /Stop/ }).count(),
        ).toBe(0);
        expect(await detail(page).textContent()).not.toContain(
          '运行摘要 · 运行中',
        );
        await detail(page).getByRole('button', { name: '查看回执' }).click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('停止请求已接收；不代表子任务已经停止。');
        expect(scenario.posts).toHaveLength(1);
        await page.reload();
        await page
          .getByRole('button', { name: '子智能体读取失败', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: '查看native-child-0原请求回执',
            exact: true,
          })
          .click();
        expect(await receipt(page).locator('code').textContent()).toBe(id);
        expect(await detail(page).textContent()).toContain('尚无确认结果');
        expect(await detail(page).textContent()).not.toContain(
          '停止请求已接收',
        );
        expect(
          await detail(page).getByRole('button', { name: /Stop/ }).count(),
        ).toBe(0);
        await detail(page).getByRole('button', { name: '查看回执' }).click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('停止请求已接收；不代表子任务已经停止。');
        expect(scenario.gets).toEqual([id, id]);
        expect(scenario.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    },
  );

  it('current root/owner gate new actions while a closed root still permits original-ticket GET', async () => {
    const { page, scenario } = await open('unknown', false, false);
    try {
      const stop = detail(page).getByRole('button', { name: 'Stop 此子任务' });
      expect(await stop.isDisabled()).toBe(true);
      rootEvent(scenario, 'turn.started', 1);
      await expect.poll(() => stop.isEnabled()).toBe(true);
      await stop.click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('原生接收结果未知');
      rootEvent(scenario, 'run.succeeded', 2);
      await expect
        .poll(() => detail(page).textContent())
        .toContain('当前没有可控制的根运行');
      expect(
        await detail(page)
          .getByRole('button', { name: '发起新的 Stop 请求' })
          .isDisabled(),
      ).toBe(true);
      await detail(page).getByRole('button', { name: '查看回执' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('停止请求已接收');
      await page.getByRole('button', { name: '切换会话所有者' }).click();
      await expect
        .poll(() => detail(page).textContent())
        .toContain('仅会话所有者可控制');
      expect(
        await detail(page)
          .getByRole('button', { name: '查看回执' })
          .isDisabled(),
      ).toBe(true);
      expect(scenario.posts).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('native idle continuable allows Send; one-shot has no Stop or composer', async () => {
    const { page, scenario } = await open();
    try {
      for (const label of ['闲置', '一次性']) {
        await page.keyboard.press('Escape');
        await show(page, label);
        expect(
          await detail(page).getByRole('button', { name: /Stop/ }).count(),
        ).toBe(0);
        expect(await detail(page).getByRole('textbox').count()).toBe(
          label === '闲置' ? 1 : 0,
        );
      }
      expect(scenario.posts).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('switching roots creates an independent request and keeps late receipts bound to their own root', async () => {
    const { page, scenario } = await open('accepted', true);
    try {
      await detail(page).getByRole('button', { name: 'Stop 此子任务' }).click();
      await expect.poll(() => scenario.posts.length).toBe(1);
      await page
        .getByRole('button', { name: '切换根运行', exact: true })
        .click();
      const nextRunId = '55555555-5555-4555-8555-555555555555';
      await expect.poll(() => scenario.rootReads).toEqual([runId, nextRunId]);
      await expect
        .poll(
          () =>
            [...feed.rootConnections].filter(
              (c) => c.fixture === scenario.feedId,
            ).length,
        )
        .toBe(1);
      rootEvent(scenario, 'turn.started', 1, nextRunId, 8);
      const nextStop = detail(page).getByRole('button', {
        name: '发起新的 Stop 请求',
      });
      await expect.poll(() => nextStop.isEnabled()).toBe(true);
      scenario.reply = (body) =>
        body.rootRunId === runId ? 'unknown' : 'accepted';
      // The old reply stays held; the new root can receive its own ACK first.
      scenario.gate = undefined;
      await nextStop.click();
      await expect.poll(() => receipt(page).count()).toBe(2);
      const ids = await receipt(page).locator('code').allTextContents();
      expect(new Set(ids).size).toBe(2);
      await expect
        .poll(() => receipt(page).last().textContent())
        .toContain('停止请求已接收');
      expect(await receipt(page).first().textContent()).toContain('正在提交');
      scenario.release!();
      await expect.poll(() => scenario.posts.length).toBe(2);
      expect(scenario.posts[0]!.rootRunId).toBe(runId);
      expect(scenario.posts[1]).toMatchObject({
        rootRunId: nextRunId,
        generation: 8,
      });
      await expect
        .poll(() => receipt(page).last().textContent())
        .toContain('停止请求已接收');
      await expect
        .poll(() => receipt(page).first().textContent())
        .toContain('原生接收结果未知');
      expect(await receipt(page).first().textContent()).toContain(
        '此前根运行的请求',
      );
      expect(await receipt(page).last().textContent()).not.toContain(
        '此前根运行的请求',
      );
      scenario.getMode = 'unknown';
      await receipt(page)
        .first()
        .getByRole('button', { name: '查看回执' })
        .click();
      await expect
        .poll(() => receipt(page).first().textContent())
        .toContain('原生接收结果未知');
      expect(await receipt(page).last().textContent()).toContain(
        '停止请求已接收',
      );
      expect(scenario.gets).toEqual([scenario.posts[0]!.input.requestId]);
      expect(scenario.posts).toHaveLength(2);
    } finally {
      scenario.release?.();
      await page.close();
    }
  });

  it.each([
    'drop',
    'bad-json',
    'wrong-id',
    'wrong-kind',
    'wrong-acceptance',
    'server-error',
  ] as const)(
    '%s never fabricates acceptance and only GET recovers the original request',
    async (mode) => {
      const { page, scenario, browserPosts } = await open(mode);
      try {
        await detail(page)
          .getByRole('button', { name: 'Stop 此子任务' })
          .click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('提交结果未知');
        expect(await detail(page).textContent()).not.toContain(
          '停止请求已接收',
        );
        const id = scenario.posts[0]!.input.requestId;
        await detail(page).getByRole('button', { name: '查看回执' }).click();
        await expect
          .poll(() => detail(page).textContent())
          .toContain('停止请求已接收');
        expect(scenario.gets).toEqual([id]);
        if (mode === 'drop') {
          expect((await browserPosts())[0]?.responseStatus).toBe(200);
          console.info(
            'CONTROL_DROP_NETWORK',
            JSON.stringify({
              browser: await browserPosts(),
              server: scenario.postFacts,
            }),
          );
        }
        expect(await browserPosts()).toHaveLength(1);
        expect(scenario.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    ['rejected', '请求被拒绝：subagent/unauthorized'],
    ['forbidden', '当前没有控制此子任务的权限。'],
    ['conflict', '请求 ID 与原请求冲突。'],
    ['closed', '根运行或控制权限已变化。'],
    ['recorded', '请求已记录，等待原生回执。'],
  ] as const)(
    '%s displays the actual refusal or recorded state',
    async (mode, text) => {
      const { page, scenario } = await open(mode);
      try {
        await detail(page)
          .getByRole('button', { name: 'Stop 此子任务' })
          .click();
        await expect.poll(() => detail(page).textContent()).toContain(text);
        expect(await detail(page).textContent()).not.toContain(
          '停止请求已接收',
        );
        expect(scenario.posts).toHaveLength(1);
      } finally {
        await page.close();
      }
    },
  );
});
