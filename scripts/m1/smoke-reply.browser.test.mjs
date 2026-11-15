// Synthetic public controls and ChatTranscript DOM; no credentials or model Run.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { crc32 } from 'node:zlib';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  readSmokeReply,
  readSmokeCsvReply,
  findSmokeCsvDelivery,
  fetchSmokeCsvPng,
  validateSmokeCsvPng,
  decodeSmokeCsvPng,
} from './smoke-reply.mjs';
import { startSmokeWork } from './smoke-entry.mjs';
import { AssistantMarkdown } from '../../apps/web/app/chatflow/assistant-markdown.tsx';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const prompt = '冒烟测试 scope：生成一份 Word 文档，直接给我下载。';
const marker = '冒烟提醒-scope';
// Existing CSS module keys and DOM attributes from ChatTranscript,
// TranscriptUserMessage, WorkProcess, AutomationTaskCard and AutomationTrigger.
const user = (id, text = prompt) =>
  `<div id="message-${id}"><div data-actions-reveal="hover"><div class="dsh-saas-module__fixture__userBubble">${text}</div></div></div>`;
const assistant = (id, body, metadata = '') =>
  `<div id="message-${id}"><div data-actions-reveal="hover"><div class="dsh-saas-module__fixture__assistantIdentity">Rice</div><div data-process-region="run-${id}">${body}</div>${metadata}</div></div>`;
const final = (text) => `<div data-work-reply="final">${text}</div>`;
const timing = '<span aria-label="本轮运行时间">用时 8 秒</span>';
const trigger = (id, extra = '') =>
  `<div id="message-${id}"><section data-turn-trigger><button>自动化任务</button>${extra}</section><button>查看任务</button></div>`;

suite('smoke reply evidence belongs to the requested assistant turn', () => {
  let browser, page;
  beforeAll(async () => {
    const { chromium } = createRequire(
      new URL('../../apps/web/package.json', import.meta.url),
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
  beforeEach(async () => {
    page = await browser.newPage();
  });
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });
  async function mount(messages, outside = '') {
    await page.setContent(
      `<main><div data-chat-scroll><div>${messages}</div></div>${outside}</main>`,
    );
  }
  const read = (extra = {}) =>
    page
      .locator('[data-chat-scroll]')
      .evaluate(readSmokeReply, { prompt, ...extra });

  it.each([false, true])(
    'starts fresh Rice work through the shared entry (existing session: %s)',
    async (existing) => {
      const base = 'https://smoke-entry.invalid';
      const writes = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET') writes.push(request.method());
      });
      await page.route(`${base}/**`, (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html>
            <button onclick="document.body.dataset.created = 'yes'">创建员工</button>
            <button aria-label="和 Rice 开新会话" onclick="
              document.body.dataset.started = 'Rice';
              history.replaceState({}, '', '/chatflow');
              const input = document.querySelector('textarea');
              input.hidden = false;
              input.value = '';
            ">＋</button>
            <textarea aria-label="给 Rice 的消息" ${existing ? '' : 'hidden'}>${existing ? '未发送的旧草稿' : ''}</textarea>
            <script>
              if (${existing}) history.replaceState({}, '', '/chatflow?session=old');
            </script>`,
        }),
      );
      await startSmokeWork(page, base);
      expect(new URL(page.url()).pathname).toBe('/chatflow');
      expect(new URL(page.url()).searchParams.get('session')).toBeNull();
      expect(
        await page
          .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
          .inputValue(),
      ).toBe('');
      const state = await page.evaluate(() => ({
        ...globalThis.document.body.dataset,
      }));
      expect(state).toEqual({ started: 'Rice' });
      expect(writes).toEqual([]);
    },
  );

  it('reads the reply despite a later sidebar repeating the prompt', async () => {
    const text = '我是 Rice，可以帮助你整理资料、分析数据并完成日常工作。';
    await mount(
      user('current') + assistant('answer', final(text), timing),
      `<aside><h2>详情</h2><p>${prompt}</p><p>sidebar.docx sidebar.png Example Domain</p><button>用时</button></aside>`,
    );
    expect(await read()).toEqual({
      text,
      links: [],
      timing: '用时 8 秒',
      automation: '',
      delivered: false,
    });
  });

  it('does not anchor to a prompt that only appears in a sidebar', async () => {
    await mount(
      user('other', '另一个问题') + assistant('old', final('old.docx')),
      `<aside>${prompt}<p>wrong.png</p></aside>`,
    );
    expect((await read()).text).toBe('');
    expect((await read()).links).toEqual([]);
  });

  it('does not use old replies, history, tools, artifact cards or toolbar files as the current reply', async () => {
    await mount(
      user('old', '旧问题') +
        assistant(
          'old-answer',
          final('<a href="old.docx">old.png</a>'),
          timing,
        ) +
        user('current') +
        assistant(
          'pending',
          '<div data-work-reply="earlier" data-process-member>history.docx history.png</div><div data-process-member><pre>created tool.docx tool.png</pre></div>',
          timing +
            '<div class="Deliverables-module__fixture__root"><div data-single="false"><div><button title="current.docx" aria-label="侧栏预览 current.docx"></button><span>current.docx</span></div><div><button title="current.png" aria-label="侧栏预览 current.png"></button><span>current.png</span></div></div></div>',
        ),
      `<aside>${prompt}<a href="sidebar.docx">sidebar.png</a></aside><div role="toolbar">toolbar.docx toolbar.png</div>`,
    );
    const reply = await read();
    expect(reply.text).toBe('');
    expect(reply.links).toEqual([]);
    expect(/\.(docx|png)/.test([reply.text, ...reply.links].join('\n'))).toBe(
      false,
    );
  });

  it('anchors to the newest exact user bubble and does not cross another user message', async () => {
    await mount(
      user('old') +
        assistant('old-answer', final('old.docx')) +
        user('current') +
        assistant('pending', '') +
        user('later', '另一个问题') +
        assistant('later-answer', final('later.png')),
    );
    expect((await read()).text).toBe('');
    await mount(
      user('current') +
        user('later', '另一个问题') +
        assistant('later-answer', final('later.docx')),
    );
    expect((await read()).text).toBe('');
  });

  it.each([
    ['parts streaming/final', final('当前回复正文')],
    [
      'non-parts streaming',
      '<div class="dsh-saas-module__fixture__assistantCopy" data-streaming>当前回复正文</div>',
    ],
    [
      'non-parts settled',
      '<div class="dsh-saas-module__fixture__assistantCopy">当前回复正文</div>',
    ],
  ])('reads the existing %s body shape', async (_, body) => {
    await mount(user('current') + assistant('answer', body));
    expect((await read()).text).toBe('当前回复正文');
  });

  it.each([
    ['docx', '下载 Word 文档《冒烟测试》'],
    ['png', '查看/下载柱状图'],
  ])(
    'keeps the original .%s assertion through the body link target',
    async (ext, label) => {
      const href = `https://allrice.invalid/api/v1/files/00000000-0000-4000-8000-000000000001/download?name=${encodeURIComponent(`冒烟测试.${ext}`)}`;
      await mount(
        user('current') +
          assistant('answer', final(`<a href="${href}">${label}</a>`)),
      );
      const reply = await read();
      expect(reply.text).toBe(label);
      expect(reply.links).toEqual([href]);
      expect(
        (ext === 'docx' ? /\.docx/ : /\.png/).test(
          [reply.text, ...reply.links].join('\n'),
        ),
      ).toBe(true);
    },
  );

  it('does not invent a type for a plain file ID or read hidden/history link targets', async () => {
    const href = '/api/v1/files/00000000-0000-4000-8000-000000000001';
    await mount(
      user('current') +
        assistant(
          'answer',
          `<div data-work-reply="old" data-process-member><a href="history.docx">旧结果</a></div>${final(`<a href="${href}">下载文档</a><a hidden href="hidden.png">隐藏</a>`)}`,
        ),
    );
    const reply = await read();
    expect(reply.text).toBe('下载文档');
    expect(reply.links).toEqual([href]);
    expect(/\.(docx|png)/.test([reply.text, ...reply.links].join('\n'))).toBe(
      false,
    );
  });

  it('requires the same assistant timing and keeps body length separate from URLs', async () => {
    await mount(
      user('old', '旧问题') +
        assistant('old-answer', final('旧回复'), timing) +
        user('current') +
        assistant(
          'answer',
          final(
            '<a href="https://allrice.invalid/a-very-long-result.docx">用时</a>',
          ),
        ),
      `<aside>${timing}</aside>`,
    );
    const reply = await read();
    expect(reply.timing).toBe('');
    expect(reply.text.replace(/\s+/g, '').length).toBeLessThanOrEqual(20);
    await page.locator('#message-answer').evaluate((element, html) => {
      element.insertAdjacentHTML('beforeend', html);
    }, timing);
    expect((await read()).timing).toBe('用时 8 秒');
  });

  it('reads creation state only from the same assistant task card', async () => {
    await mount(
      user('old', '旧问题') +
        assistant(
          'old-answer',
          '',
          '<div data-tool="schedule_create">一次性 · 待执行</div>',
        ) +
        user('current') +
        assistant('answer', final('已安排提醒。')),
      '<aside><div data-tool="schedule_create">一次性 · 待执行</div></aside>',
    );
    expect((await read()).automation).toBe('');
    await page.locator('#message-answer').evaluate((element) => {
      element.insertAdjacentHTML(
        'beforeend',
        '<div data-tool="schedule_create">一次性 · 待执行</div>',
      );
    });
    const reply = await read();
    expect(reply.automation).toBe('一次性 · 待执行');
    expect(reply.text).toBe('已安排提醒。');
  });

  it('requires a later task trigger followed by the marker in its assistant body', async () => {
    await mount(
      trigger('old-trigger') +
        assistant('old-reminder', final(marker)) +
        user('current') +
        assistant('created', final('已安排提醒。')) +
        trigger('fired', `<p>${marker}</p>`) +
        assistant(
          'delivery',
          `<div data-process-member>${marker}</div>${final('没有标记的正文')}`,
        ),
      `<aside><button>查看任务</button>${marker}</aside>`,
    );
    expect((await read({ marker })).delivered).toBe(false);
    await page
      .locator('#message-delivery [data-work-reply]')
      .evaluate((element, text) => {
        element.textContent = text;
      }, marker);
    expect((await read({ marker })).delivered).toBe(true);
  });

  const csvPrompt = '冒烟测试 scope：按渠道汇总这个 CSV，画一张柱状图。';
  const csvId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [csvSession, csvUser, csvAssistant, csvRun, csvObject] = [
    1, 2, 3, 4, 5,
  ].map(csvId);
  const csvBase = 'https://allrice.invalid';
  const csvHref = `/api/v1/files/${csvObject}/download`;
  const csvCaption = '渠道下单量柱状图';
  const csvMarkdown = `![${csvCaption}](${csvHref})`;
  const native = (text, props = {}) =>
    renderToStaticMarkup(createElement(AssistantMarkdown, { text, ...props }));
  const csvTurn = (body, metadata = '') =>
    assistant(csvAssistant, body, metadata).replace(
      `data-process-region="run-${csvAssistant}"`,
      `data-process-region="${csvRun}"`,
    );
  const readCsv = () =>
    page
      .locator('[data-chat-scroll]')
      .evaluate(readSmokeCsvReply, { prompt: csvPrompt });
  const csvProof = (text = csvMarkdown) => ({
    sessionId: csvSession,
    userMessageId: csvUser,
    assistantMessageId: csvAssistant,
    runId: csvRun,
    text,
    objects: [
      {
        id: csvObject,
        runId: csvRun,
        sessionId: csvSession,
        state: 'ready',
        immutable: true,
        format: 'png',
        mediaType: 'image/png',
      },
    ],
  });
  async function findCsv(observed, proof = csvProof()) {
    const { fromMarkdown } = await import(
      webRequire.resolve('mdast-util-from-markdown')
    );
    return findSmokeCsvDelivery({
      observed,
      proof,
      sessionId: csvSession,
      base: csvBase,
      fromMarkdown,
    });
  }

  it.each([
    ['relative native caption', csvHref, 'native-caption'],
    ['absolute native image', `${csvBase}${csvHref}`, 'img'],
  ])(
    'accepts the actual %s for an extensionless authenticated file URL',
    async (_, destination, kind) => {
      const text = `![${csvCaption}](${destination})`;
      const html = native(text);
      if (kind === 'native-caption') {
        expect(html).not.toContain('<img');
        expect(html).toContain('imageAlt');
      } else expect(html).toContain('<img');
      await mount(user(csvUser, csvPrompt) + csvTurn(final(html)));
      const observed = await readCsv();
      expect(observed).toMatchObject({
        userMessageId: csvUser,
        assistantMessageId: csvAssistant,
        runId: csvRun,
      });
      expect(await findCsv(observed, csvProof(text))).toMatchObject({
        id: csvObject,
        kind,
      });
    },
  );
  it('keeps ordinary PNG anchors through actual native Markdown', async () => {
    const text = `[下载柱状图](${csvBase}${csvHref}?name=result.png)`;
    await mount(user(csvUser, csvPrompt) + csvTurn(final(native(text))));
    expect(await findCsv(await readCsv(), csvProof(text))).toMatchObject({
      id: csvObject,
      kind: 'anchor',
    });
  });
  it('accepts a reference image rewritten by real AssistantMarkdown artifact and origin context', async () => {
    const text = `![${csvCaption}][chart]\n\n[chart]: ${csvHref}`;
    const fileName = '渠道下单量汇总.png';
    const rewritten = `${csvBase}${csvHref}?name=${encodeURIComponent(fileName)}`;
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    let html;
    try {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: csvBase },
      });
      html = native(text, {
        artifacts: [{ object: { id: csvObject }, version: { fileName } }],
      });
    } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous);
      else Reflect.deleteProperty(globalThis, 'location');
    }
    expect(html).toContain('<img');
    expect(html).toContain(`src="${rewritten}"`);
    expect(html).not.toContain('imageAlt');
    await mount(user(csvUser, csvPrompt) + csvTurn(final(html)));
    const observed = await readCsv();
    expect(observed.images).toEqual([rewritten]);
    expect(observed.captions).toEqual([]);
    expect(await findCsv(observed, csvProof(text))).toMatchObject({
      id: csvObject,
      kind: 'img',
    });
  });
  it.each([
    'history',
    'tool',
    'card',
    'sidebar',
    'hidden',
    'old',
    'later',
    'plain caption',
  ])(
    'rejects PNG evidence from %s even when its image and caption match',
    async (position) => {
      const html = native(csvMarkdown);
      let body = '',
        before = '',
        after = '',
        metadata = '',
        outside = '';
      if (position === 'history')
        body = `<div data-work-reply="old" data-process-member>${html}</div>`;
      if (position === 'tool')
        body = `<div data-process-member><pre>${html}</pre></div>`;
      if (position === 'card')
        metadata = `<div class="Deliverables-module__fixture__root">${html}</div>`;
      if (position === 'sidebar')
        outside = `<aside>${csvPrompt}${html}<img src="${csvHref}"></aside>`;
      if (position === 'hidden')
        body = final(`<div hidden>${html}<img src="${csvHref}"></div>`);
      if (position === 'old')
        before = user('old', '旧问题') + assistant('old-answer', final(html));
      if (position === 'later')
        after =
          user('later', '另一个问题') + assistant('later-answer', final(html));
      if (position === 'plain caption') body = final(csvCaption);
      await mount(
        before + user(csvUser, csvPrompt) + csvTurn(body, metadata) + after,
        outside,
      );
      const observed = await readCsv();
      expect(observed.images).toEqual([]);
      expect(observed.captions).toEqual([]);
      await expect(findCsv(observed)).rejects.toThrow(
        'csv_current_png_delivery_missing',
      );
    },
  );
  it('does not anchor CSV proof to a sidebar prompt or a different assistant Run', async () => {
    await mount(
      user('other', '另一个问题') + csvTurn(final(native(csvMarkdown))),
      `<aside>${csvPrompt}</aside>`,
    );
    expect((await readCsv()).userMessageId).toBeNull();
    await expect(findCsv(await readCsv())).rejects.toThrow(
      'csv_turn_not_confirmed',
    );
    await mount(user(csvUser, csvPrompt) + csvTurn(final(native(csvMarkdown))));
    await page
      .locator('[data-process-region]')
      .evaluate((region) =>
        region.setAttribute(
          'data-process-region',
          '00000000-0000-4000-8000-000000000099',
        ),
      );
    await expect(findCsv(await readCsv())).rejects.toThrow(
      'csv_turn_not_confirmed',
    );
  });
  async function withCsvDownloadServer(check) {
    const url = await page.evaluate(() => {
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL('image/png');
    });
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    const object = {
      mediaType: 'image/png',
      sizeBytes: bytes.length,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
    const server = createServer((request, response) => {
      if (request.url === csvHref) {
        const authenticated = request.headers.cookie
          ?.split('; ')
          .includes('allrice_session=smoke-png-fixture');
        response.writeHead(authenticated ? 200 : 401, {
          'content-type': authenticated ? 'image/png' : 'application/json',
        });
        response.end(
          authenticated ? bytes : '{"error":"authentication_required"}',
        );
      } else {
        if (request.url === '/login')
          response.setHeader(
            'set-cookie',
            'allrice_session=smoke-png-fixture; Path=/; HttpOnly; Secure; SameSite=Lax',
          );
        response.end('<!doctype html><title>CSV download fixture</title>');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await check({
        origin: `http://127.0.0.1:${server.address().port}`,
        bytes,
        object,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('downloads exact CSV PNG bytes using the page Secure HttpOnly login cookie on HTTP 127.0.0.1', async () => {
    await withCsvDownloadServer(async ({ origin, bytes, object }) => {
      await page.goto(`${origin}/login`);
      expect(await page.context().cookies()).toEqual([
        expect.objectContaining({
          name: 'allrice_session',
          domain: '127.0.0.1',
          httpOnly: true,
          secure: true,
        }),
      ]);
      const response = await page.evaluate(fetchSmokeCsvPng, origin + csvHref);
      expect(response).toMatchObject({
        ok: true,
        status: 200,
        mediaType: 'image/png',
      });
      const downloaded = Buffer.from(response.bytes);
      expect(downloaded).toEqual(bytes);
      expect(
        validateSmokeCsvPng(downloaded, object, response.mediaType),
      ).toMatchObject({
        width: 1,
        height: 1,
      });
      expect(await page.evaluate(decodeSmokeCsvPng, response.bytes)).toEqual({
        width: 1,
        height: 1,
      });
    });
  });

  it('keeps unauthenticated CSV downloads denied and refuses a different origin', async () => {
    await withCsvDownloadServer(async ({ origin, object }) => {
      await page.goto(origin);
      const response = await page.evaluate(fetchSmokeCsvPng, origin + csvHref);
      expect(response).toMatchObject({
        ok: false,
        status: 401,
        mediaType: 'application/json',
      });
      expect(() =>
        validateSmokeCsvPng(
          Buffer.from(response.bytes),
          object,
          response.mediaType,
        ),
      ).toThrow('csv_png_bytes_or_type_invalid');
      await expect(
        page.evaluate(
          fetchSmokeCsvPng,
          origin.replace('127.0.0.1', 'localhost') + csvHref,
        ),
      ).rejects.toThrow('csv_png_download_origin_mismatch');
    });
  });

  it('decodes captured PNG bytes and rejects a CRC-valid but undecodable payload', async () => {
    const url = await page.evaluate(() => {
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL('image/png');
    });
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    expect(await page.evaluate(decodeSmokeCsvPng, [...bytes])).toEqual({
      width: 1,
      height: 1,
    });
    const broken = Buffer.from(bytes);
    for (let offset = 8; offset + 12 <= broken.length;) {
      const length = broken.readUInt32BE(offset),
        end = offset + length + 12;
      if (broken.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        broken.fill(0, offset + 8, end - 4);
        broken.writeUInt32BE(
          crc32(broken.subarray(offset + 4, end - 4)),
          end - 4,
        );
      }
      offset = end;
    }
    const object = {
      mediaType: 'image/png',
      sizeBytes: broken.length,
      checksum: `sha256:${createHash('sha256').update(broken).digest('hex')}`,
    };
    expect(validateSmokeCsvPng(broken, object, 'image/png')).toMatchObject({
      width: 1,
      height: 1,
    });
    await expect(
      page.evaluate(decodeSmokeCsvPng, [...broken]),
    ).rejects.toThrow();
  });
});
