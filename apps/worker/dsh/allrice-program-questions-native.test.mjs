/* global process, AbortController */
import { setTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askProgramQuestion } from './allrice-program-questions.mjs';
import { createAllRiceRuntime } from './allrice-jsonrpc-implementation.mjs';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../src/harness/dsh-distribution.ts';

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture(release = 1000) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'program-question-')),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const oldListeners = new Map(
    ['uncaughtException', 'unhandledRejection'].map((e) => [
      e,
      process.listeners(e),
    ]),
  );
  cleanups.push(() => {
    for (const [event, previous] of oldListeners)
      for (const listener of process.listeners(event))
        if (!previous.includes(listener))
          process.removeListener(event, listener);
  });
  for (const [key, value] of Object.entries({
    DSH_HOME: root,
    DSH_CWD: root,
    DSH_RUNTIME_HOME: root,
    DSH_SESSION_ROOT: join(root, 'sessions'),
    DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
    DSH_CORDIS_CONFIG: resolve(
      import.meta.dirname,
      'allrice-restricted.cordis.yml',
    ),
    DSH_OPENAI_COMPATIBLE_MODEL: 'program-test',
    DSH_MODEL: 'program-test',
    OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
    OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1',
    ALLRICE_QUESTION_RELEASE_MS: String(release),
    ALLRICE_ASK_USER_TIMEOUT: '1',
    ALLRICE_ASSISTANTS_ENABLED: undefined,
    ALLRICE_MAINTENANCE_OUTPUT_TOKENS: undefined,
    ALLRICE_PROGRESS_GUARD_ENABLED: undefined,
  }))
    vi.stubEnv(key, value);
  const notices = [];
  const runtime = await createAllRiceRuntime(
    {
      notify: (method, params) =>
        notices.push({ method, params, at: Date.now() }),
      request: async () => {
        throw Error('No model or broker call expected');
      },
    },
    {
      runtimeName: 'program-question-test',
      installedDshRuntimeVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      assertInitializationOpen() {},
      ownContext() {},
      ownServer() {},
    },
  );
  cleanups.push(async () => {
    await runtime.server.shutdown();
    await runtime.ctx.fiber.dispose();
  });
  await runtime.server.handleRequest('initialize', {
    cwd: root,
    provider: 'openai-compatible',
    model: 'program-test',
    nativeTools: [],
    expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
  });
  const sessionId = randomUUID();
  const { agent } = await runtime.server.ensureRoot(sessionId);
  const request = (id, signal = new AbortController().signal) => ({
    agent,
    signal,
    questions: [
      { id, question: '等我确认后再继续', options: [{ label: '继续' }] },
    ],
  });
  return { ...runtime, agent, sessionId, notices, request };
}

describe('MET-210 actual answerer claims and display timers', () => {
  it('settles an accepted answer across expiry before releasing its durable receipt', async () => {
    const f = await fixture(100);
    vi.spyOn(f.agent, 'status', 'get').mockReturnValue('running');
    f.agent.session.append('turn/start', { turn: 1 });
    const waiting = f.ctx.userQuestions.askTimed(
      f.request('confirm'),
      'confirm',
      1000,
    );
    await vi.waitFor(() => expect(f.server.pendingUserQuestions.size).toBe(1));
    const card = f.server.pendingUserQuestions.get(f.sessionId);
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(
      async (session) => {
        await flush(session);
        await gate;
      },
    );
    const inputId = randomUUID();
    const reply = f.server.steer({
      sessionId: f.sessionId,
      turnId: `${f.sessionId}:turn:1`,
      inputId,
      kind: 'ask_user',
      text: `allrice:user-question:v1:${JSON.stringify({ questionId: card.questionId, answers: [{ id: 'confirm', selected: ['继续'] }] })}`,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(f.server.pendingUserQuestions.get(f.sessionId)).toBe(card);
      expect(f.notices.map((n) => n.method)).not.toContain(
        'session.user-question-pending',
      );
    } finally {
      release();
    }
    expect(await waiting).toEqual({
      answers: [{ id: 'confirm', selected: ['继续'] }],
    });
    expect(await reply).toMatchObject({ status: 'adopted', inputId });
    expect(
      f.agent.session
        .snapshotEvents()
        .filter(
          (e) =>
            e.type === 'allrice/input/answered' && e.data.inputId === inputId,
        ),
    ).toHaveLength(1);
    expect(f.notices.map((n) => n.method)).not.toContain(
      'session.user-question-pending',
    );
  });
  it('claims before queueing and gives the second card its full displayed duration', async () => {
    const f = await fixture();
    const first = f.ctx.userQuestions.askTimed(
      f.request('first'),
      'first-call',
      200,
    );
    const second = f.ctx.userQuestions.askTimed(
      f.request('second'),
      'second-call',
      200,
    );
    expect(await first).toEqual({ pending: true, callId: 'first-call' });
    expect(await second).toEqual({ pending: true, callId: 'second-call' });
    const displays = f.notices.filter(
      (n) => n.method === 'session.user-question',
    );
    const endings = f.notices.filter(
      (n) => n.method === 'session.user-question-pending',
    );
    expect(displays).toHaveLength(2);
    expect(endings).toHaveLength(2);
    expect(displays[1].at).toBeGreaterThanOrEqual(endings[0].at);
    for (let i = 0; i < 2; i++) {
      expect(endings[i].at - displays[i].at).toBeGreaterThanOrEqual(170);
      expect(
        Date.parse(displays[i].params.deadlineAt) - displays[i].at,
      ).toBeGreaterThanOrEqual(170);
    }
    expect(f.server.pendingUserQuestions.size).toBe(0);
  });

  it('connection expiry returns pending without granting connection confirmation', async () => {
    const f = await fixture(60);
    const connectionId = randomUUID();
    const reply = await f.server.waitForApplicationConnection(
      'cloud.mcp.call',
      {
        modelContent: JSON.stringify({
          needsLogin: true,
          requestId: randomUUID(),
          connection: { id: connectionId },
          loginPath: '/connect/test',
        }),
      },
      f.agent,
      new AbortController().signal,
    );
    expect(JSON.parse(reply.content)).toMatchObject({
      connectionId,
      answer: { pending: true },
      instruction:
        '用户还没确认连接，先做不依赖它的事；用户连好会在对话里告诉你，届时先查状态',
    });
    expect(
      f.notices.find((n) => n.method === 'session.user-question').params,
    ).toMatchObject({ releaseLimited: true, releaseMinutes: 0.001 });
    expect(f.server.pendingUserQuestions.size).toBe(0);
  });

  it('aborting a queued request never marks it pending or removes the active card', async () => {
    const f = await fixture();
    const first = f.ctx.userQuestions.askTimed(
      f.request('first'),
      'first',
      1000,
    );
    const controller = new AbortController();
    const second = f.ctx.userQuestions.askTimed(
      f.request('second', controller.signal),
      'second',
      1000,
    );
    const rejected = expect(second).rejects.toMatchObject({
      code: 'ASK_ABORTED',
    });
    await vi.waitFor(() => expect(f.server.pendingUserQuestions.size).toBe(1));
    controller.abort();
    await rejected;
    expect(
      f.notices.filter((n) => n.method === 'session.user-question'),
    ).toHaveLength(1);
    const card = f.server.pendingUserQuestions.get(f.sessionId);
    f.server.pendingUserQuestions.delete(f.sessionId);
    card.resolve({ answers: [{ id: 'first', selected: ['继续'] }] });
    expect(await first).toHaveProperty('answers');
    expect(
      f.notices.filter((n) => n.method === 'session.user-question-pending'),
    ).toHaveLength(0);
  });
  it.each(['disabled-release', 'maintenance'])(
    'keeps a program question blocking for %s, even past the release point',
    async (mode) => {
      const f = await fixture(mode === 'disabled-release' ? 0 : 30);
      if (mode === 'maintenance')
        vi.stubEnv('ALLRICE_MAINTENANCE_OUTPUT_TOKENS', '16000');
      const requestId = randomUUID();
      const waiting = f.server.waitForApplicationConnection(
        'cloud.mcp.call',
        {
          modelContent: JSON.stringify({
            needsLogin: true,
            requestId,
            connection: { id: randomUUID() },
            loginPath: '/connect/test',
          }),
        },
        f.agent,
        new AbortController().signal,
      );
      await vi.waitFor(() =>
        expect(f.server.pendingUserQuestions.size).toBe(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(f.notices.map((n) => n.method)).not.toContain(
        'session.user-question-pending',
      );
      expect(
        f.notices.find((n) => n.method === 'session.user-question').params
          .deadlineAt,
      ).toBeUndefined();
      const card = f.server.pendingUserQuestions.get(f.sessionId);
      f.server.pendingUserQuestions.delete(f.sessionId);
      card.resolve({
        answers: [{ id: `app-connect:${requestId}`, selected: [] }],
      });
      expect(JSON.parse((await waiting).content).answer).toHaveProperty(
        'answers',
      );
    },
  );

  it('uses the release point for a forever program question without a durable projection', async () => {
    const f = await fixture(50);
    vi.stubEnv('ALLRICE_ASK_USER_TIMEOUT', '-1');
    await expect(
      askProgramQuestion(
        f.ctx.userQuestions,
        f.request('forever'),
        'forever-call',
      ),
    ).resolves.toEqual({ pending: true, callId: 'forever-call' });
    expect(f.notices.map((n) => n.method)).toContain(
      'session.user-question-pending',
    );
  });
});
