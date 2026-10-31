/* global Buffer, process */
// MET-210 PR1: lock the DSH behaviours the timed-question design relies on,
// with the production AllRice JSON-RPC host, the pinned DSH loop and a
// loopback model. Only the model responses are synthetic.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createAllRiceRuntime } from './allrice-jsonrpc-implementation.mjs';
import { readStoredDshSession } from './allrice-session-compatibility.mjs';
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
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** One host per launch() over one session root; the model asks once (with the
 * given timeout argument), then answers every later request with plain text. */
async function fixture({
  timeout,
  child = false,
  extraTool = false,
  configuredTimeout,
  modelCallId = 'call_ask_go',
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-question-detach-')),
  );
  const requests = [];
  const childGate = barrier();
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
      const isChild =
        child &&
        body.toString().includes('CHILD_JOB_HOLD_77') &&
        !body.toString().includes('要继续吗');
      if (isChild) await childGate.promise;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      const item =
        index === 0
          ? {
              type: 'function_call',
              id: 'fc_ask',
              call_id: modelCallId,
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
      const items = [item];
      if (index === 0 && extraTool)
        items.push({
          type: 'function_call',
          id: 'fc_other',
          call_id: 'call_other',
          name: 'local_fs_list',
          arguments: '{}',
          status: 'completed',
        });
      for (const [outputIndex, item] of items.entries()) {
        send({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            ...item,
            ...(item.type === 'message' ? { content: [] } : { arguments: '' }),
          },
        });
        if (item.type === 'message')
          send({
            type: 'response.output_text.delta',
            output_index: outputIndex,
            delta: `DONE_${index}`,
          });
        else
          send({
            type: 'response.function_call_arguments.delta',
            output_index: outputIndex,
            delta: item.arguments,
          });
        send({
          type: 'response.output_item.done',
          output_index: outputIndex,
          item,
        });
      }
      send({
        type: 'response.completed',
        response: {
          id: `resp_${index}`,
          status: 'completed',
          output: items,
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
    source.replace(
      '      openai-codex:\n',
      `      openai-codex:\n        baseURL: ${baseURL}\n        transport: sse\n`,
    ) +
      (child
        ? `
- name: '@deepseek-ai/dsh-user-approval'
  config: { policy: never }
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: './child-fixture.mjs'
`
        : ''),
  );
  if (child)
    await writeFile(
      join(root, 'child-fixture.mjs'),
      `
export const inject = ['subagents'];
export function apply(ctx) {
  ctx.on('user-questions/request', async (request, next) => {
    const { agent, signal } = request;
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'fixture child', delivery: 'parent', signal,
      request: { parent: agent, prompt: [{ type: 'text', text: 'CHILD_JOB_HOLD_77' }] },
    });
    void activation.result.catch(() => {});
    return next();
  });
}
`,
    );
  // Hold the scheduled detach exit before it starts, so each late exit entry
  // must choose the uncanceled path itself. No production knob or timer.
  await writeFile(
    join(root, 'hold-exit.mjs'),
    `
const immediate = globalThis.setImmediate;
const exits = [];
globalThis.setImmediate = (callback, ...args) => {
  if (!String(callback).includes('exitDetached')) return immediate(callback, ...args);
  exits.push(() => callback(...args));
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture.exit-ready', params: {} }) + '\\n');
};
process.on('SIGUSR2', () => { for (const exit of exits.splice(0)) immediate(exit); });
`,
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
  const heldClients = [];
  cleanups.push(async () => {
    childGate.release();
    for (const client of heldClients) client.child.kill('SIGUSR2');
    for (const client of clients) await client.close().catch(() => {});
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    DSH_CORDIS_CONFIG: join(root, 'profile.yml'),
    DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
    DSH_SESSION_ROOT: join(root, 'sessions'),
    DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
    DSH_HOME: root,
    DSH_CWD: root,
    DSH_CODEX_MODEL: 'gpt-5.6-luna',
    DSH_SYSTEM_PROMPT: 'Synthetic question fixture.',
    ALLRICE_ASK_USER_MODE: 'timed',
    ...(configuredTimeout === undefined
      ? {}
      : { ALLRICE_ASK_USER_TIMEOUT: configuredTimeout }),
  };
  const initialize = {
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
  };
  async function launch({ holdExit = false } = {}) {
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        ...(holdExit ? ['--import', join(root, 'hold-exit.mjs')] : []),
        resolve(import.meta.dirname, 'allrice-jsonrpc-runtime.mjs'),
      ],
      cwd: root,
      requestTimeoutMs: 15000,
      environment,
    });
    clients.push(client);
    if (holdExit) heldClients.push(client);
    client.subscribe((notice) => notices.push(notice));
    client.onFailure(() => {});
    client.setRequestHandler(async (method) => {
      throw Error(`unexpected_fixture_bridge:${method}`);
    });
    await client.initialize(initialize);
    return client;
  }
  async function launchInProcess() {
    const listeners = new Map(
      ['uncaughtException', 'unhandledRejection'].map((event) => [
        event,
        process.listeners(event),
      ]),
    );
    cleanups.push(() => {
      for (const [event, previous] of listeners)
        for (const listener of process.listeners(event))
          if (!previous.includes(listener))
            process.removeListener(event, listener);
    });
    for (const [key, value] of Object.entries(environment))
      vi.stubEnv(key, value);
    for (const key of [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_PROGRESS_GUARD_ENABLED',
      'DSH_RUNTIME_HOME',
    ])
      vi.stubEnv(key, undefined);
    const runtime = await createAllRiceRuntime(
      {
        notify: (method, params) => notices.push({ method, params }),
        request: async (method) => {
          throw Error(`unexpected_fixture_bridge:${method}`);
        },
      },
      {
        runtimeName: 'allrice-question-test',
        installedDshRuntimeVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        assertInitializationOpen() {},
        ownContext() {},
        ownServer() {},
      },
    );
    cleanups.push(async () => {
      runtime.server.detaching = undefined;
      await runtime.server.shutdown().catch(() => {});
      await runtime.ctx.fiber.dispose();
    });
    await runtime.server.handleRequest('initialize', initialize);
    return runtime;
  }
  async function journal(sessionId) {
    const ctx = new Context();
    try {
      await ctx.plugin(SessionStore);
      await ctx.plugin(JsonlPersistence, {
        root: join(root, 'sessions'),
        compression: 'none',
      });
      return (await readStoredDshSession(ctx, sessionId)).events;
    } finally {
      await ctx.fiber.dispose();
    }
  }
  const events = () =>
    notices
      .filter((n) => n.method === 'session.event')
      .map((n) => n.params.event);
  const askCall = () =>
    events().find(
      (e) => e.type === 'tool/call' && e.data.name === 'ask_user_question',
    );
  return {
    launch,
    launchInProcess,
    journal,
    notices,
    events,
    askCall,
    requests,
    releaseChild: childGate.release,
  };
}

const replyText = (requests, callId) =>
  requests.filter(
    (text) =>
      text.includes('answer_to_pending_question') && text.includes(callId),
  );

describe('MET-210 timed questions on the AllRice host', () => {
  it.each([
    ['default', undefined, 120],
    ['N', '2', 2],
    ['forever', '-1', undefined],
  ])(
    'PR4 production profile uses native %s when the model omits timeout',
    async (_mode, configuredTimeout, seconds) => {
      const f = await fixture({ configuredTimeout });
      const sessionId = `dsh-${randomUUID()}`;
      const client = await f.launch();
      const started = Date.now();
      await client.prompt(sessionId, '请按员工的等待设置，先问我要不要继续。');
      const notice = () =>
        f.notices.find((n) => n.method === 'session.user-question')?.params;
      await expect.poll(notice, { timeout: 15000 }).toBeDefined();
      const callId = f.askCall().data.callId;
      expect(JSON.parse(f.askCall().data.arguments)).not.toHaveProperty(
        'timeout',
      );
      expect(notice()).toMatchObject({
        questionId: `${sessionId}:${callId}`,
        nativeSessionId: sessionId,
        callId,
        durable: true,
      });
      if (seconds === undefined)
        expect(notice()).not.toHaveProperty('deadlineAt');
      else {
        expect(Date.parse(notice().deadlineAt)).toBeGreaterThanOrEqual(
          started + seconds * 1000 - 100,
        );
        expect(Date.parse(notice().deadlineAt)).toBeLessThanOrEqual(
          Date.now() + seconds * 1000,
        );
      }
      if (configuredTimeout === '2') {
        await expect
          .poll(async () => (await client.userQuestions(sessionId)).questions, {
            timeout: 15000,
          })
          .toEqual([expect.objectContaining({ callId, state: 'continued' })]);
        expect(
          f.notices.filter((n) => n.method === 'session.user-questions').at(-1)
            ?.params.questions.settled,
        ).toEqual([]);
      } else {
        const input = {
          inputId: randomUUID(),
          turnId: `${sessionId}:turn:1`,
          kind: 'ask_user',
        };
        const text =
          'allrice:user-question:v1:' +
          JSON.stringify({
            questionId: `${sessionId}:${callId}`,
            answers: [{ id: 'go', selected: ['继续'] }],
          });
        await expect
          .poll(() => client.steer(sessionId, text, input), { timeout: 15000 })
          .toMatchObject({
            status: 'adopted',
            callId,
            checkpoint: 'question_resolved',
          });
        expect(
          await client.questionReply({
            sessionId,
            callId,
            answers: [{ id: 'go', selected: ['继续'] }],
          }),
        ).toEqual({ queued: false });
      }
    },
    60000,
  );

  it('refuses to initialize when the configured optional ask tool failed validation', async () => {
    const f = await fixture({
      timeout: 1,
      configuredTimeout: 'not-an-integer',
    });
    await expect(f.launch()).rejects.toThrow();
    expect(f.requests).toEqual([]);
  }, 30000);
  it('keeps an answer refused during detach retryable through DSH recovery and answer()', async () => {
    const f = await fixture({ timeout: -1 });
    const sessionId = `synthetic-detach-${randomUUID()}`;
    let client = await f.launch({ holdExit: true });
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.notices.some((n) => n.method === 'session.user-question'), {
        timeout: 15000,
      })
      .toBe(true);
    // A follow-up queued while the root waits sits in DSH's durable inbox.
    await client.prompt(sessionId, 'QUEUED_FOLLOWUP_77');
    // Keep the caller's original answer while the Host releases its lease.
    const answers = [{ id: 'go', selected: ['继续'] }];
    const input = {
      sessionId,
      inputId: randomUUID(),
      turnId: `${sessionId}:turn:1`,
      kind: 'ask_user',
      text: `allrice:user-question:v1:${JSON.stringify({ questionId: f.notices.find((n) => n.method === 'session.user-question').params.questionId, answers })}`,
    };
    const detach = await client.detachQuestion(sessionId);
    expect(detach).toMatchObject({
      detached: true,
      callId: f.askCall().data.callId,
    });
    await expect(client.request('session/steer', input)).rejects.toThrow(
      'QUESTION_DETACHING',
    );
    // No orphan request can poison this inputId with a permanent unknown ACK.
    expect(
      (await f.journal(sessionId)).filter(
        (e) =>
          e.type === 'allrice/input/request' &&
          e.data.inputId === input.inputId,
      ),
    ).toEqual([]);
    client.child.kill('SIGUSR2');
    await expect
      .poll(() => client.processState(), { timeout: 10000 })
      .toMatchObject({ state: 'exited', exitCode: 0 });
    // No result was recorded for the question before the Host exited.
    expect(f.events().some((e) => e.type === 'tool/result')).toBe(false);

    client = await f.launch();
    const beforeRecovery = f.notices.length;
    await client.resume(sessionId);
    const state = await client.userQuestions(sessionId);
    // DSH repairs the journal without broadcasting the synthetic result.
    // ensureRoot must publish its public projection even in that case.
    expect(
      f.notices
        .slice(beforeRecovery)
        .filter(
          (n) =>
            n.method === 'session.event' &&
            n.params.event.type === 'tool/result' &&
            n.params.event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN',
        ),
    ).toEqual([]);
    expect(
      f.notices.filter((n) => n.method === 'session.user-questions').at(-1)
        ?.params.questions.active,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: detach.callId, state: 'continued' }),
      ]),
    );
    expect(state.questions).toEqual([
      expect.objectContaining({ callId: detach.callId, state: 'continued' }),
    ]);
    expect(
      (await f.journal(sessionId)).find(
        (e) =>
          e.type === 'tool/result' &&
          e.data.message.toolCallId === detach.callId,
      )?.data.error.code,
    ).toBe('TOOL_OUTCOME_UNKNOWN');
    // Both requests arrive before the next native step can claim the inbox.
    const replies = await Promise.allSettled([
      client.questionReply({ sessionId, callId: detach.callId, answers }),
      client.questionReply({ sessionId, callId: detach.callId, answers }),
    ]);
    expect(
      replies.filter((r) => r.status === 'fulfilled' && r.value.queued),
    ).toHaveLength(1);
    const rejected = replies.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toContain('REPLY_QUEUED');
    await expect
      .poll(() => replyText(f.requests, detach.callId).length, {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    // Native inbox recovery delivers both in the first resumed model step.
    await expect
      .poll(
        () => f.requests.some((text) => text.includes('QUEUED_FOLLOWUP_77')),
        { timeout: 15000 },
      )
      .toBe(true);
    expect(f.requests[1]).toContain('QUEUED_FOLLOWUP_77');
    expect(f.requests[1]).toContain('answer_to_pending_question');
    expect(f.requests[1]).toContain('Its outcome is unknown');
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

  it.each(['shutdown', 'SIGTERM'])(
    'control: %s records ASK_ABORTED and DSH drops the question',
    async (mode) => {
      const f = await fixture({ timeout: -1 });
      const sessionId = `synthetic-shutdown-${randomUUID()}`;
      let client = await f.launch();
      await client.prompt(sessionId, '请先问我要不要继续。');
      await expect
        .poll(
          () => f.notices.some((n) => n.method === 'session.user-question'),
          {
            timeout: 15000,
          },
        )
        .toBe(true);
      const callId = f.askCall().data.callId;
      expect(JSON.parse(f.askCall().data.arguments).timeout).toBe(-1);
      expect(
        f.notices.find((n) => n.method === 'session.user-question').params,
      ).not.toHaveProperty('deadlineAt');
      expect(
        f
          .events()
          .filter(
            (e) =>
              e.type === 'tool/result' && e.data.message.toolCallId === callId,
          ),
      ).toEqual([]);
      if (mode === 'shutdown') await client.close();
      else {
        client.child.kill('SIGTERM');
        await expect
          .poll(() => client.processState(), { timeout: 10000 })
          .toMatchObject({ state: 'exited', exitCode: 0 });
      }
      expect(
        (await f.journal(sessionId)).find(
          (e) =>
            e.type === 'tool/result' && e.data.message.toolCallId === callId,
        )?.data,
      ).toMatchObject({ error: { code: 'ASK_ABORTED' } });
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
    },
    60000,
  );

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
      f.notices.find((n) => n.method === 'session.user-question')?.params,
    ).toMatchObject({
      questionId: `${sessionId}:${callId}`,
      callId,
      durable: true,
      nativeSessionId: sessionId,
    });
    expect(
      f.notices.filter((n) => n.method === 'session.user-questions').at(-1)
        ?.params.questions.active,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId, state: 'continued' }),
      ]),
    );
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
    await expect
      .poll(
        () =>
          f.notices.filter((n) => n.method === 'session.user-questions').at(-1)
            ?.params.questions.settled,
      )
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callId,
            answers: [{ id: 'go', selected: ['继续'] }],
          }),
        ]),
      );
  }, 60000);

  it('adopts a foreground typed answer only after the actual native tool result', async () => {
    const f = await fixture({
      timeout: 30,
      modelCallId: 'native:call:'.repeat(40),
    });
    const sessionId = `dsh-${randomUUID()}`;
    const client = await f.launch();
    await client.prompt(sessionId, '请先问我。');
    await expect
      .poll(() => f.notices.some((n) => n.method === 'session.user-question'))
      .toBe(true);
    const callId = f.askCall().data.callId;
    const typed = {
      inputId: randomUUID(),
      turnId: `${sessionId}:turn:1`,
      kind: 'ask_user',
    };
    const text =
      'allrice:user-question:v1:' +
      JSON.stringify({
        questionId: `${sessionId}:${callId}`,
        answers: [{ id: 'go', selected: ['继续'] }],
      });
    await expect
      .poll(() => client.steer(sessionId, text, typed))
      .toMatchObject({
        status: 'adopted',
        inputId: typed.inputId,
        messageId: `${sessionId}:${callId}`,
        callId,
        checkpoint: 'question_resolved',
      });
    const proof = await client.steer(sessionId, text, typed);
    expect(f.events().find((e) => e.seq === proof.sequence)).toMatchObject({
      type: 'tool/result',
      data: { message: { toolCallId: callId } },
    });
    expect(
      f.notices.some((n) => n.method === 'session.user-question-answered'),
    ).toBe(false);
    await client.close();
    expect(
      (await f.journal(sessionId)).find(
        (e) => e.type === 'allrice/input/request',
      )?.data.messageId,
    ).toBe(`${sessionId}:${callId}`);
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

  it.each(['shutdown', 'stdin', 'SIGTERM', 'SIGINT'])(
    'detach remains uncanceled when %s arrives before process exit',
    async (mode) => {
      const f = await fixture({ timeout: -1 });
      const sessionId = `detach-exit-${randomUUID()}`;
      const client = await f.launch({ holdExit: true });
      await client.prompt(sessionId, '请先问我要不要继续。');
      await expect.poll(() => f.askCall(), { timeout: 15000 }).toBeDefined();
      await expect
        .poll(
          () => f.notices.some((n) => n.method === 'session.user-question'),
          { timeout: 15000 },
        )
        .toBe(true);
      const detached = await client.detachQuestion(sessionId);
      expect(detached).toEqual({
        detached: true,
        callId: f.askCall().data.callId,
      });
      await expect
        .poll(() => f.notices.some((n) => n.method === 'fixture.exit-ready'), {
          timeout: 10000,
        })
        .toBe(true);
      await expect(client.steer(sessionId, '稍等')).rejects.toThrow(
        'QUESTION_DETACHING',
      );
      await expect(
        client.questionReply({
          sessionId,
          callId: detached.callId,
          answers: [{ id: 'go', selected: ['继续'] }],
        }),
      ).rejects.toThrow('QUESTION_DETACHING');
      if (mode === 'shutdown')
        expect(await client.request('shutdown', {})).toEqual({
          detached: true,
        });
      else if (mode === 'stdin') client.child.stdin.end();
      else client.child.kill(mode);
      // shutdown schedules the held exit; stdin/signals directly choose it.
      if (mode === 'shutdown') client.child.kill('SIGUSR2');
      await expect
        .poll(() => client.processState(), { timeout: 10000 })
        .toMatchObject({ state: 'exited', exitCode: 0 });
      expect(
        (await f.journal(sessionId)).filter((e) => e.type === 'tool/result'),
      ).toEqual([]);
      const restored = await f.launch();
      await restored.resume(sessionId);
      expect((await restored.userQuestions(sessionId)).questions).toEqual([
        expect.objectContaining({
          callId: detached.callId,
          state: 'continued',
        }),
      ]);
    },
    60000,
  );

  it('refuses a second requested tool even when it has not started', async () => {
    const f = await fixture({ timeout: -1, extraTool: true });
    const client = await f.launch();
    const sessionId = `extra-tool-${randomUUID()}`;
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(() => f.notices.some((n) => n.method === 'session.user-question'), {
        timeout: 15000,
      })
      .toBe(true);
    expect(await client.detachQuestion(sessionId)).toEqual({
      detached: false,
      reason: 'TOOL_CALLS_OPEN',
    });
    expect((await client.userQuestions(sessionId)).questions[0].state).toBe(
      'open',
    );
  }, 60000);

  it('keeps a real child settlement in next-step and admits it with the reply after recovery', async () => {
    const f = await fixture({ timeout: -1, child: true });
    const sessionId = `child-settlement-${randomUUID()}`;
    let client = await f.launch();
    await client.prompt(sessionId, '请先问我要不要继续。');
    await expect
      .poll(
        () => ({
          question: f.notices.some((n) => n.method === 'session.user-question'),
          errors: f
            .events()
            .filter((e) => e.type === 'tool/result' || e.type === 'turn/end'),
        }),
        { timeout: 15000 },
      )
      .toMatchObject({ question: true })
      .catch(() => {
        throw Error(
          JSON.stringify(
            f
              .events()
              .filter((e) => e.type === 'tool/result' || e.type === 'turn/end'),
          ),
        );
      });
    expect(await client.detachQuestion(sessionId)).toEqual({
      detached: false,
      reason: 'AGENTS_RUNNING',
    });
    f.releaseChild();
    const settlement = () =>
      f
        .events()
        .find(
          (e) =>
            e.type === 'agent/inbox/spliced' &&
            JSON.stringify(e.data).includes('subagent-settled'),
        );
    await expect.poll(settlement, { timeout: 15000 }).toBeDefined();
    expect(JSON.stringify(settlement().data)).toContain('next-step');
    const detached = await client.detachQuestion(sessionId);
    expect(detached.detached).toBe(true);
    await expect
      .poll(() => client.processState(), { timeout: 10000 })
      .toMatchObject({ state: 'exited', exitCode: 0 });
    expect(
      (await f.journal(sessionId)).find((e) => e.seq === settlement().seq),
    ).toEqual(settlement());
    const before = f.requests.length;
    client = await f.launch();
    await client.resume(sessionId);
    expect(
      await client.questionReply({
        sessionId,
        callId: detached.callId,
        answers: [{ id: 'go', selected: ['继续'] }],
      }),
    ).toEqual({ queued: true });
    await expect
      .poll(() => f.requests.length, { timeout: 15000 })
      .toBeGreaterThan(before);
    expect(f.requests[before]).toContain('Background subagent');
    expect(f.requests[before]).toContain('DONE_1');
    expect(f.requests[before]).toContain('answer_to_pending_question');
  }, 60000);
});

async function blockedHost() {
  const f = await fixture({ timeout: -1 });
  const { server, ctx } = await f.launchInProcess();
  const sessionId = `in-process-${randomUUID()}`;
  await server.handleRequest('session/prompt', {
    sessionId,
    contentBlocks: [{ type: 'text', text: '请先问我要不要继续。' }],
  });
  await expect
    .poll(() => server.pendingUserQuestions.has(sessionId), { timeout: 15000 })
    .toBe(true);
  return {
    ...f,
    server,
    ctx,
    sessionId,
    agent: server.roots.get(sessionId).agent,
  };
}

describe('detach failure and ingress interleavings on the real host', () => {
  it.each(['drain', 'cancel'])(
    'root disposal releases the waiter when native %s fails during shutdown',
    async (stage) => {
      const h = await blockedHost();
      const failure = new Error(`fixture ${stage} failure`);
      if (stage === 'drain')
        vi.spyOn(h.ctx.subagents, 'drainDescendants').mockRejectedValueOnce(
          failure,
        );
      else
        vi.spyOn(h.agent, 'cancel').mockImplementationOnce(() => {
          throw failure;
        });
      const shutdown = h.server.shutdown();
      await expect(shutdown).rejects.toBeInstanceOf(AggregateError);
      const shutdownFailure = await shutdown.catch((error) => error);
      // Both closeRoot and shutdown retain stage failures while completing
      // teardown. Check the injected Error itself, not just its message.
      expect(shutdownFailure.errors).toHaveLength(1);
      const [closeFailure] = shutdownFailure.errors;
      expect(closeFailure).toBeInstanceOf(AggregateError);
      expect(closeFailure.errors).toHaveLength(1);
      expect(closeFailure.errors[0]).toBe(failure);
      expect(h.server.phase).toBe('failed');
      expect(h.ctx.agents.get(h.sessionId)).toBeUndefined();
      expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined();
      const journal = await h.journal(h.sessionId);
      const results = journal.filter((event) => event.type === 'tool/result');
      expect(results).toHaveLength(1);
      expect(results[0].data).toMatchObject({ error: { code: 'ASK_ABORTED' } });
      expect(
        journal.findLast((event) => event.type === 'turn/end').data,
      ).toMatchObject({
        reason: {
          kind: 'aborted',
          reason: { kind: stage === 'cancel' ? 'disposed' : 'user' },
        },
      });
      await expect(h.server.closeRoot(h.sessionId)).rejects.toBe(closeFailure);
      // The production shutdown coordinator always attempts root disposal,
      // even when SDK shutdown failed; no cleanup success receipt is invented.
      await h.ctx.root.fiber.dispose();
      await h.agent.whenIdle();
      expect(h.server.phase).toBe('failed');
      expect(h.server.pendingUserQuestions.has(h.sessionId)).toBe(false);
      expect(h.requests).toHaveLength(1);
    },
  );

  it.each([
    'shutdown',
    'session/close',
    'session/interrupt',
    'session/recover',
  ])(
    '%s keeps the question pending while native descendants drain, then records cancellation through DSH',
    async (method) => {
      const h = await blockedHost();
      const entered = barrier(),
        gate = barrier();
      const drain = h.ctx.subagents.drainDescendants.bind(h.ctx.subagents);
      vi.spyOn(h.ctx.subagents, 'drainDescendants').mockImplementation(
        async (parents) => {
          entered.release();
          await gate.promise;
          return drain(parents);
        },
      );
      const closing =
        method === 'shutdown'
          ? h.server.shutdown()
          : h.server.handleRequest(method, { sessionId: h.sessionId });
      try {
        await entered.promise;
        expect(h.server.pendingUserQuestions.has(h.sessionId)).toBe(true);
        expect(h.events().some((e) => e.type === 'tool/result')).toBe(false);
        expect(h.requests).toHaveLength(1);
        gate.release();
        const outcome = await closing;
        const journal = await h.journal(h.sessionId);
        const results = journal.filter(
          (e) =>
            e.type === 'tool/result' &&
            e.data.message.toolCallId === h.askCall().data.callId,
        );
        expect(results).toHaveLength(1);
        expect(results[0].data).toMatchObject({
          error: { code: 'ASK_ABORTED' },
        });
        expect(
          journal.findLast((event) => event.type === 'turn/end').data,
        ).toMatchObject({
          reason: { kind: 'aborted', reason: { kind: 'user' } },
        });
        expect(h.server.pendingUserQuestions.has(h.sessionId)).toBe(false);
        if (method === 'session/interrupt' || method === 'session/recover') {
          expect(outcome).toMatchObject(
            method === 'session/interrupt'
              ? { interrupted: true }
              : { recovered: true },
          );
          const restored = h.server.requireRoot(h.sessionId).agent;
          expect(restored).not.toBe(h.agent);
          expect(
            restored.session.snapshotEvents().slice(0, journal.length),
          ).toEqual(journal);
          await h.server.waitRoot(h.sessionId);
        } else {
          expect(h.server.phase).toBe('closed');
          expect(h.ctx.agents.get(h.sessionId)).toBeUndefined();
          expect(h.ctx.sessions.get(h.sessionId)).toBeUndefined();
        }
        expect(h.requests).toHaveLength(1);
      } finally {
        gate.release();
        await closing;
      }
    },
  );

  it('a previously admitted legacy park cannot cancel after detach commits', async () => {
    const h = await blockedHost();
    const entered = barrier(),
      gate = barrier();
    h.server.taskProgress = {
      flush: vi
        .fn()
        .mockImplementationOnce(async () => {
          entered.release();
          await gate.promise;
        })
        .mockResolvedValue(undefined),
    };
    const park = h.server.handleRequest('session/park-question', {
      sessionId: h.sessionId,
      questionId: h.server.pendingUserQuestions.get(h.sessionId).questionId,
    });
    await entered.promise;
    expect(
      (
        await h.server.handleRequest('session/detach', {
          sessionId: h.sessionId,
        })
      ).detached,
    ).toBe(true);
    gate.release();
    expect(await park).toEqual({ checkpoint: null });
    expect(
      h.agent.session.snapshotEvents().some((e) => e.type === 'tool/result'),
    ).toBe(false);
  }, 30000);

  it('a reply awaiting root lookup is refused after detach commits', async () => {
    const h = await blockedHost();
    const entered = barrier(),
      gate = barrier();
    const record = h.server.roots.get(h.sessionId);
    vi.spyOn(h.server, 'ensureRoot').mockImplementationOnce(async () => {
      entered.release();
      await gate.promise;
      return record;
    });
    const reply = h.server
      .handleRequest('session/question-reply', {
        sessionId: h.sessionId,
        callId: h.askCall().data.callId,
        answers: [{ id: 'go', selected: ['继续'] }],
      })
      .catch((e) => e);
    await entered.promise;
    expect(
      (
        await h.server.handleRequest('session/detach', {
          sessionId: h.sessionId,
        })
      ).detached,
    ).toBe(true);
    gate.release();
    expect(await reply).toMatchObject({ message: 'QUESTION_DETACHING' });
  }, 30000);

  it.each(['progress', 'session'])(
    'a failed %s flush restores input and permits a retry',
    async (stage) => {
      const h = await blockedHost();
      if (stage === 'progress')
        h.server.taskProgress = {
          flush: vi
            .fn()
            .mockRejectedValueOnce(Error('flush-failed'))
            .mockResolvedValue(undefined),
        };
      else
        vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce(
          Error('flush-failed'),
        );
      await expect(
        h.server.handleRequest('session/detach', { sessionId: h.sessionId }),
      ).rejects.toThrow('flush-failed');
      expect(h.server.detaching).toBeUndefined();
      expect(
        (
          await h.server.handleRequest('session/user-questions', {
            sessionId: h.sessionId,
          })
        ).questions[0].state,
      ).toBe('open');
      expect(
        (
          await h.server.handleRequest('session/detach', {
            sessionId: h.sessionId,
          })
        ).detached,
      ).toBe(true);
    },
    30000,
  );

  it.each(['images', 'contentBlocks'])(
    'an admitted prompt waiting on %s cannot enqueue or ACK after the final flush',
    async (field) => {
      const h = await blockedHost();
      const entered = barrier(),
        gate = barrier();
      const saveImages = h.ctx.attachments.saveImages.bind(h.ctx.attachments);
      vi.spyOn(h.ctx.attachments, 'saveImages').mockImplementationOnce(
        async (images) => {
          entered.release();
          await gate.promise;
          return saveImages(images);
        },
      );
      const prompt = h.server
        .handleRequest('session/prompt', {
          sessionId: h.sessionId,
          [field]: [
            {
              type: 'image',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
              mimeType: 'image/png',
              mediaType: 'image/png',
            },
          ],
        })
        .catch((e) => e);
      await entered.promise;
      expect(
        (
          await h.server.handleRequest('session/detach', {
            sessionId: h.sessionId,
          })
        ).detached,
      ).toBe(true);
      const seq = h.agent.session.seq;
      gate.release();
      expect(await prompt).toMatchObject({ message: 'QUESTION_DETACHING' });
      expect(h.agent.session.seq).toBe(seq);
    },
    30000,
  );

  it.each(['commit', 'flush-failure'])(
    'an admitted answer survives detach %s and retries the same inputId as adopted',
    async (outcome) => {
      const h = await blockedHost();
      const entered = barrier(),
        gate = barrier();
      const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
      const sessionFlush = vi
        .spyOn(h.ctx.sessions, 'flush')
        .mockImplementationOnce(async (session) => {
          await flush(session);
          entered.release();
          await gate.promise;
        });
      const question = h.server.pendingUserQuestions.get(h.sessionId);
      const input = {
        sessionId: h.sessionId,
        inputId: randomUUID(),
        turnId: `${h.sessionId}:turn:1`,
        kind: 'ask_user',
        text: `allrice:user-question:v1:${JSON.stringify({ questionId: question.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
      };
      const reply = h.server.handleRequest('session/steer', input);
      await entered.promise;
      const progress = barrier(),
        progressEntered = barrier();
      h.server.taskProgress = {
        flush: vi.fn().mockImplementationOnce(async () => {
          progressEntered.release();
          await progress.promise;
          if (outcome === 'flush-failure') throw Error('detach-flush-failed');
        }),
      };
      const detach = h.server
        .handleRequest('session/detach', { sessionId: h.sessionId })
        .catch((error) => error);
      try {
        await progressEntered.promise;
        expect(
          (await h.journal(h.sessionId)).filter(
            (e) =>
              e.type === 'allrice/input/request' &&
              e.data.inputId === input.inputId,
          ),
        ).toHaveLength(1);
        for (const method of [
          'session/steer',
          'session/question-reply',
          'session/interrupt',
          'session/close',
        ])
          await expect(h.server.handleRequest(method, input)).rejects.toThrow(
            'QUESTION_DETACHING',
          );
        // Let detach reach its commit while the admitted answer is still held.
        // On the failure path, keep detaching set until the answer has finished,
        // reproducing the old request -> unknown -> failed detach -> unknown race.
        if (outcome === 'commit') {
          progress.release();
          await h.journal(h.sessionId);
          // Detach cannot start its final session flush until the admitted
          // answer has finished. The request flush remains held at this point.
          expect(sessionFlush).toHaveBeenCalledTimes(1);
        }
        gate.release();
        const adopted = await reply;
        expect(adopted).toMatchObject({
          status: 'adopted',
          inputId: input.inputId,
          checkpoint: 'question_resolved',
        });
        progress.release();
        if (outcome === 'flush-failure')
          expect(await detach).toMatchObject({
            message: 'detach-flush-failed',
          });
        else
          expect(await detach).toEqual({ detached: false, reason: 'ANSWERED' });
        expect(h.server.detaching).toBeUndefined();
        expect(await h.server.handleRequest('session/steer', input)).toEqual(
          adopted,
        );
        await h.agent.whenIdle();
        await flush(h.agent.session);
        const journal = await h.journal(h.sessionId);
        for (const type of ['allrice/input/request', 'allrice/input/answered'])
          expect(
            journal.filter(
              (e) => e.type === type && e.data.inputId === input.inputId,
            ),
          ).toHaveLength(1);
        const result = journal.find(
          (e) =>
            e.type === 'tool/result' &&
            e.data.message.toolCallId === h.askCall().data.callId,
        );
        expect(result).toBeDefined();
        expect(result.data.error).toBeUndefined();
        expect(JSON.stringify(result.data.message.content)).toContain('继续');
        expect(
          (
            await h.server.handleRequest('session/user-questions', {
              sessionId: h.sessionId,
            })
          ).questions,
        ).toEqual([]);
      } finally {
        gate.release();
        progress.release();
        await Promise.allSettled([reply, detach]);
      }
    },
    30000,
  );

  it.each(['answered', 'closing', 'running-child', 'extra-tool'])(
    'rechecks %s after flush and reopens admission when detach loses',
    async (change) => {
      const h = await blockedHost();
      h.server.taskProgress = {
        flush: async () => {
          if (change === 'answered')
            h.server.pendingUserQuestions.delete(h.sessionId);
          if (change === 'closing')
            vi.spyOn(h.server, 'isRootCurrent').mockReturnValue(false);
          if (change === 'running-child')
            vi.spyOn(h.ctx.agents, 'list').mockReturnValue([
              h.agent,
              { status: 'running', session: h.agent.session },
            ]);
          if (change === 'extra-tool') {
            const events = h.agent.session.snapshotEvents();
            const message = events.findLast(
              (e) => e.type === 'assistant/message',
            );
            vi.spyOn(h.agent.session, 'snapshotEvents').mockReturnValue(
              events.map((e) =>
                e !== message
                  ? e
                  : {
                      ...e,
                      data: {
                        ...e.data,
                        message: {
                          ...e.data.message,
                          content: [
                            ...e.data.message.content,
                            {
                              type: 'tool-call',
                              id: 'new-call',
                              name: 'other',
                              arguments: '{}',
                            },
                          ],
                        },
                      },
                    },
              ),
            );
          }
        },
      };
      expect(
        await h.server.handleRequest('session/detach', {
          sessionId: h.sessionId,
        }),
      ).toEqual({
        detached: false,
        reason: {
          answered: 'ANSWERED',
          closing: 'SESSION_CLOSING',
          'running-child': 'AGENTS_RUNNING',
          'extra-tool': 'TOOL_CALLS_OPEN',
        }[change],
      });
      expect(h.server.detaching).toBeUndefined();
    },
    30000,
  );
});
