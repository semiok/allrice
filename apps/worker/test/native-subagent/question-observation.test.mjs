/* global AbortController */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { askProgramQuestion } from '../../dsh/allrice-program-questions.mjs';
import { gate, hold, host, text } from './fixture.mjs';

const questions = [
  { id: 'go', question: '请确认继续', options: [{ label: '继续' }] },
];
const snapshot = async (h, sessionId = h.root.id) =>
  (await h.server.handleRequest('session/projection', { sessionId }))
    .foreground;
const ask = (h, signal) =>
  askProgramQuestion(
    h.ctx.userQuestions,
    { agent: h.root, signal, questions },
    randomUUID(),
  );
const card = async (h) => {
  await expect
    .poll(() => h.server.pendingUserQuestions.get(h.root.id)?.foreground)
    .toBeTruthy();
  return h.server.pendingUserQuestions.get(h.root.id);
};
const setup = (extra = {}) =>
  host({
    runId: randomUUID(),
    questionMode: 'legacy',
    releaseMs: 0,
    bridge: async () => ({ allowed: true }),
    ...extra,
  });
const tool = (timeout) => [
  {
    type: 'tool-call',
    id: 'timed-call',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions, ...(timeout ? { timeout } : {}) }),
  },
];
const answer = (h, q) =>
  h.server.handleRequest('session/steer', {
    sessionId: h.root.id,
    turnId: `${h.root.id}:turn:${h.root.session.snapshotEvents().findLast((e) => e.type === 'turn/start').data.turn}`,
    inputId: randomUUID(),
    kind: 'ask_user',
    text: `allrice:user-question:v1:${JSON.stringify({ questionId: q.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
  });

it('reads complete empty and missing-root unknown without acquiring or touching a root', async () => {
  const runId = randomUUID(),
    h = await setup({ runId });
  const ensure = vi.spyOn(h.server, 'ensureRoot');
  expect(await snapshot(h)).toEqual({
    version: 1,
    sampledAt: expect.any(String),
    rootSessionId: h.root.id,
    runId,
    complete: true,
    questions: [],
  });
  expect(await snapshot(h, 'absent-root')).toMatchObject({
    runId: null,
    complete: false,
    questions: [],
  });
  expect(ensure).not.toHaveBeenCalled();
});

it('samples only the published foreground; canceled queue and abort follow the original map', async () => {
  const runId = randomUUID(),
    h = await setup({ runId });
  const firstSignal = new AbortController(),
    queuedSignal = new AbortController();
  const first = ask(h, firstSignal.signal).catch((e) => e);
  const q = await card(h);
  const queued = ask(h, queuedSignal.signal).catch((e) => e);
  queuedSignal.abort();
  expect(await queued).toMatchObject({ code: 'ASK_ABORTED' });
  expect(await snapshot(h)).toMatchObject({
    complete: true,
    questions: [
      {
        questionId: q.questionId,
        runId,
        rootSessionId: h.root.id,
        nativeSessionId: h.root.id,
      },
    ],
  });
  expect(Object.keys((await snapshot(h)).questions[0]).sort()).toEqual([
    'nativeSessionId',
    'questionId',
    'rootSessionId',
    'runId',
  ]);
  firstSignal.abort();
  expect(await first).toMatchObject({ code: 'ASK_ABORTED' });
  expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
  expect(
    h.notices.some((n) => n.method === 'session.user-question-answered'),
  ).toBe(false);
  expect(
    h.notices.some((n) => n.method === 'allrice.user-question-foreground'),
  ).toBe(false);
});

it('an unrelated child cancellation leaves the root card; root cancellation clears it', async () => {
  const entered = gate(),
    release = gate();
  const h = await setup({
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(r.signal, release);
        return text('完成');
      }
      return tool();
    },
  });
  await h.prompt('先问我，同时保留子任务。');
  const q = await card(h),
    child = await h.spawn();
  await entered.promise;
  h.ctx.agents.get(child.childId).cancel({ kind: 'user' });
  await child.result;
  expect((await snapshot(h)).questions[0].questionId).toBe(q.questionId);
  h.root.cancel({ kind: 'user' });
  await h.root.whenIdle();
  expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
});

it.each(['clear', 'close', 'new-run'])(
  'preserves original published identity through %s',
  async (mode) => {
    const runId = randomUUID(),
      h = await setup({ runId }),
      signal = new AbortController();
    const pending = ask(h, signal.signal).catch((e) => e);
    await card(h);
    if (mode === 'new-run') {
      await h.server.handleRequest('run/end', { runId });
      await h.server.handleRequest('run/begin', {
        sessionId: h.root.id,
        runId: randomUUID(),
      });
      expect(await snapshot(h)).toMatchObject({
        complete: false,
        questions: [{ runId }],
      });
    }
    if (mode === 'close')
      await h.server.handleRequest('session/close', { sessionId: h.root.id });
    else await h.server.clearRootQuestion(h.root.id, 'fixture cleanup');
    await pending;
    expect(await snapshot(h)).toMatchObject({
      complete: mode !== 'close',
      questions: [],
    });
  },
);

it.each(['publish', 'attribution'])(
  'incomplete %s is unknown and never changes question authority',
  async (mode) => {
    const h = await setup(),
      signal = new AbortController();
    const target = mode === 'publish' ? h.server : h.server.runAdmission;
    const method = mode === 'publish' ? 'userQuestionNotify' : 'attribute';
    const failed = vi.spyOn(target, method).mockImplementation(() => {
      throw Error('fixture unavailable');
    });
    const pending = ask(h, signal.signal).catch((e) => e);
    await expect
      .poll(() => h.server.pendingUserQuestions.has(h.root.id))
      .toBe(true);
    failed.mockRestore();
    expect(await snapshot(h)).toMatchObject({ complete: false, questions: [] });
    signal.abort();
    await pending;
    await h.server.clearRootQuestion(h.root.id, 'fixture cleanup');
    expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
  },
);

it('real program timeout clears foreground even though no answer was submitted', async () => {
  const h = await setup({ releaseMs: 100 });
  const pending = ask(h, new AbortController().signal);
  await card(h);
  expect((await snapshot(h)).questions).toHaveLength(1);
  expect(await pending).toMatchObject({ pending: true });
  expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
  expect(
    h.notices.some((n) => n.method === 'session.user-question-answered'),
  ).toBe(false);
});

it('slow accepted input remains foreground after deadline, then clears only after native adoption', async () => {
  const h = await setup({
    questionMode: 'timed',
    model: async (_r, n) => (n === 1 ? tool(1) : text('继续工作')),
  });
  await h.prompt('先问我是否继续。');
  const q = await card(h),
    entered = gate(),
    release = gate();
  const original = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const flush = vi
    .spyOn(h.ctx.sessions, 'flush')
    .mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
  const input = answer(h, q);
  try {
    await entered.promise;
    await delay(1200);
    expect(
      Date.parse(
        h.notices.find((n) => n.method === 'session.user-question').params
          .deadlineAt,
      ),
    ).toBeLessThan(Date.now());
    expect(await snapshot(h)).toMatchObject({
      complete: true,
      questions: [{ questionId: q.questionId }],
    });
    release.resolve();
    expect(await input).toMatchObject({ status: 'adopted' });
    await h.wait();
    expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
  } finally {
    release.resolve();
    flush.mockRestore();
    await input.catch(() => {});
  }
});

it('continued timed pending and late answers do not reopen foreground', async () => {
  const h = await setup({
    questionMode: 'timed',
    releaseMs: 50,
    model: async (_r, n) => (n === 1 ? tool() : text('继续工作')),
  });
  await h.prompt('先问我，有其他工作就继续。');
  await h.wait();
  expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
  expect(
    (
      await h.server.handleRequest('session/user-questions', {
        sessionId: h.root.id,
      })
    ).questions,
  ).toEqual([
    expect.objectContaining({ callId: 'timed-call', state: 'continued' }),
  ]);
  await h.server.handleRequest('session/question-reply', {
    sessionId: h.root.id,
    callId: 'timed-call',
    answers: [{ id: 'go', selected: ['继续'] }],
  });
  expect(await snapshot(h)).toMatchObject({ complete: true, questions: [] });
});
