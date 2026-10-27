/* global Buffer, process */
// MET-210 PR1: lock the DSH behaviours the timed-question design relies on,
// with the production AllRice JSON-RPC host, the pinned DSH loop and a
// loopback model. Only the model responses are synthetic.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DshProtocolClient } from '../src/harness/dsh-protocol-client.ts';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../src/harness/dsh-distribution.ts';

// Generated test grant; never read ambient credentials or call a remote model.
const syntheticToken = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-loopback',
      },
    }),
  ).toString('base64url'),
  'synthetic-signature',
].join('.');

const question = {
  id: 'go',
  question: '要继续吗？',
  options: [{ label: '继续' }, { label: '停止' }],
};
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One host per launch() over one session root; the model asks once (with the
 * given timeout argument), then answers every later request with plain text. */
async function fixture({ timeout }) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-question-detach-'));
  const requests = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body =
        req.headers['content-encoding'] === 'zstd'
          ? zstdDecompressSync(raw)
          : raw;
      requests.push(body.toString());
      const index = requests.length - 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const item =
        index === 0
          ? {
              type: 'function_call',
              id: 'fc_ask',
              call_id: 'call_ask_go',
              name: 'ask_user_question',
              arguments: JSON.stringify({ questions: [question], timeout }),
              status: 'completed',
            }
          : {
              type: 'message',
              id: `msg_${index}`,
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: `DONE_${index}`, annotations: [] },
              ],
            };
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          ...item,
          ...(item.type === 'message' ? { content: [] } : { arguments: '' }),
        },
      });
      if (item.type === 'message')
        send({
          type: 'response.output_text.delta',
          output_index: 0,
          delta: `DONE_${index}`,
        });
      else
        send({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: item.arguments,
        });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({
        type: 'response.completed',
        response: {
          id: `resp_${index}`,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 7,
            total_tokens: 27,
          },
        },
      });
      res.end();
    })().catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  await symlink(
    resolve(import.meta.dirname, '../node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const source = await readFile(
    resolve(import.meta.dirname, 'allrice-restricted.cordis.yml'),
    'utf8',
  );
  const askLine =
    "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'\n";
  expect(source).toContain(askLine);
  await writeFile(
    join(root, 'profile.yml'),
    source
      .replace(
        '      openai-codex:\n',
        `      openai-codex:\n        baseURL: ${baseURL}\n        transport: sse\n`,
      )
      // The timed mode this design turns on (PR4); DSH's own default timeout.
      .replace(askLine, `${askLine}  config:\n    mode: timed\n`),
  );
  await writeFile(
    join(root, 'credentials.yaml'),
    JSON.stringify({
      version: 1,
      records: {
        'llm-pi-ai/openai-codex': {
          kind: 'grant',
          payload: {
            type: 'oauth',
            access: syntheticToken,
            refresh: 'never-used',
            expires: Date.now() + 3600000,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const notices = [];
  const clients = [];
  cleanups.push(async () => {
    for (const client of clients) await client.close().catch(() => {});
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function launch() {
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'allrice-jsonrpc-runtime.mjs')],
      cwd: root,
      requestTimeoutMs: 15000,
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DSH_CORDIS_CONFIG: join(root, 'profile.yml'),
        DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
        DSH_SESSION_ROOT: join(root, 'sessions'),
        DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
        DSH_HOME: root,
        DSH_CWD: root,
        DSH_CODEX_MODEL: 'gpt-5.6-luna',
        DSH_SYSTEM_PROMPT: 'Synthetic question fixture.',
      },
    });
    clients.push(client);
    client.subscribe((notice) => notices.push(notice));
    client.onFailure(() => {});
    client.setRequestHandler(async (method) => {
      throw Error(`unexpected_fixture_bridge:${method}`);
    });
    await client.initialize({
      cwd: root,
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      maxTokens: 64,
      nativeTools: ['local.fs.list'],
      nativeSkills: [],
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      contentScenes: [],
      requireContentGuard: false,
      requireTaskProgress: false,
    });
    return client;
  }
  const events = () =>
    notices
      .filter((n) => n.method === 'session.event')
      .map((n) => n.params.event);
  const askCall = () =>
    events().find(
      (e) => e.type === 'tool/call' && e.data.name === 'ask_user_question',
    );
  return { launch, notices, events, askCall, requests };
}

const replyText = (requests, callId) =>
  requests.filter(
    (text) =>
      text.includes('answer_to_pending_question') && text.includes(callId),
  );

describe('MET-210 timed questions on the AllRice host', () => {
  it('detaches a blocked question without an outcome; DSH resumes it as continued and answer() delivers the reply', async () => {
    const f = await fixture({ timeout: -1 });
    const sessionId = `synthetic-detach-${randomUUID()}`;
    let client = await f.launch();
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.notices.some((n) => n.method === 'session.user-question'), {
        timeout: 15000,
      })
      .toBe(true);
    // A follow-up queued while the root waits sits in DSH's durable inbox.
    await client.prompt(sessionId, 'QUEUED_FOLLOWUP_77');
    const detach = await client.detachQuestion(sessionId);
    expect(detach).toMatchObject({
      detached: true,
      callId: f.askCall().data.callId,
    });
    await expect
      .poll(() => client.processState(), { timeout: 10000 })
      .toMatchObject({ state: 'exited', exitCode: 0 });
    // No result was recorded for the question before the Host exited.
    expect(f.events().some((e) => e.type === 'tool/result')).toBe(false);

    client = await f.launch();
    await client.resume(sessionId);
    const state = await client.userQuestions(sessionId);
    expect(state.questions).toEqual([
      expect.objectContaining({ callId: detach.callId, state: 'continued' }),
    ]);
    // Two concurrent replies: DSH queues one; the other is refused or finds the
    // question no longer continued. The question is answered exactly once.
    const answers = [{ id: 'go', selected: ['继续'] }];
    const replies = await Promise.allSettled([
      client.questionReply({ sessionId, callId: detach.callId, answers }),
      client.questionReply({ sessionId, callId: detach.callId, answers }),
    ]);
    expect(
      replies.filter((r) => r.status === 'fulfilled' && r.value.queued),
    ).toHaveLength(1);
    for (const r of replies)
      if (r.status === 'rejected')
        expect(String(r.reason)).toContain('REPLY_QUEUED');
    await expect
      .poll(() => replyText(f.requests, detach.callId).length, {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    // The follow-up queued before the detach is delivered after the reply.
    await expect
      .poll(
        () => f.requests.some((text) => text.includes('QUEUED_FOLLOWUP_77')),
        { timeout: 15000 },
      )
      .toBe(true);
    const settled = await client.userQuestions(sessionId);
    expect(
      settled.questions?.some(
        (q) => q.callId === detach.callId && q.state === 'continued',
      ),
    ).toBe(false);
    expect(
      await client.questionReply({ sessionId, callId: detach.callId, answers }),
    ).toEqual({ queued: false });
  }, 60000);

  it('control: an ordinary shutdown cancels the question and DSH drops it', async () => {
    const f = await fixture({ timeout: -1 });
    const sessionId = `synthetic-shutdown-${randomUUID()}`;
    let client = await f.launch();
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.notices.some((n) => n.method === 'session.user-question'), {
        timeout: 15000,
      })
      .toBe(true);
    const callId = f.askCall().data.callId;
    await client.close();
    client = await f.launch();
    await client.resume(sessionId);
    const state = await client.userQuestions(sessionId);
    expect(state.questions?.some((q) => q.callId === callId)).toBe(false);
    expect(
      await client.questionReply({
        sessionId,
        callId,
        answers: [{ id: 'go', selected: ['继续'] }],
      }),
    ).toEqual({ queued: false });
  }, 60000);

  it('a timed question that runs out returns pending, stays continued, and takes a late answer in the live root', async () => {
    const f = await fixture({ timeout: 1 });
    const sessionId = `synthetic-pending-${randomUUID()}`;
    const client = await f.launch();
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.events().some((e) => e.type === 'turn/end'), {
        timeout: 15000,
      })
      .toBe(true);
    const callId = f.askCall().data.callId;
    // The model continued after the pending result.
    expect(
      f.requests.some((text) =>
        text.includes('No answer batch arrived before the timeout'),
      ),
    ).toBe(true);
    expect((await client.userQuestions(sessionId)).questions).toEqual([
      expect.objectContaining({ callId, state: 'continued' }),
    ]);
    expect(
      await client.questionReply({
        sessionId,
        callId,
        answers: [{ id: 'go', selected: ['继续'] }],
      }),
    ).toEqual({ queued: true });
    await expect
      .poll(() => replyText(f.requests, callId).length, { timeout: 15000 })
      .toBeGreaterThan(0);
  }, 60000);

  it('refuses to detach without a pending question and rejects an answer outside the options', async () => {
    const f = await fixture({ timeout: 1 });
    const sessionId = `synthetic-refuse-${randomUUID()}`;
    const client = await f.launch();
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.events().some((e) => e.type === 'turn/end'), {
        timeout: 15000,
      })
      .toBe(true);
    expect(await client.detachQuestion(sessionId)).toEqual({
      detached: false,
      reason: 'NO_QUESTION',
    });
    const callId = f.askCall().data.callId;
    // DSH's answer() checks each question once but not labels; the shared rule does.
    await expect(
      client.questionReply({
        sessionId,
        callId,
        answers: [{ id: 'go', selected: ['不存在'] }],
      }),
    ).rejects.toThrow('QUESTION_ANSWER_INVALID');
    expect((await client.userQuestions(sessionId)).questions).toEqual([
      expect.objectContaining({ callId, state: 'continued' }),
    ]);
  }, 60000);
});
