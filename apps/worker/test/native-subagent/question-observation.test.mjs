import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { askProgramQuestion } from '../../dsh/allrice-program-questions.mjs';
import { gate, hold, host, text } from './fixture.mjs';

const questions = [
  { id: 'go', question: '请确认继续', options: [{ label: '继续' }] },
];
const observations = (h) =>
  h.notices
    .filter((n) => n.method === 'allrice.user-question-foreground')
    .map((n) => n.params);
const ask = (h, signal, callId = randomUUID()) =>
  askProgramQuestion(
    h.ctx.userQuestions,
    { agent: h.root, signal, questions },
    callId,
  );
const card = async (h) => {
  await expect
    .poll(() => observations(h).filter((n) => n.phase === 'opened').length)
    .toBe(1);
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

it('observes only the published question; a canceled queued request never opens', async () => {
  const h = await setup();
  const firstSignal = new AbortController(),
    queuedSignal = new AbortController();
  const first = ask(h, firstSignal.signal).catch((e) => e);
  const q = await card(h);
  const queued = ask(h, queuedSignal.signal).catch((e) => e);
  queuedSignal.abort();
  expect(await queued).toMatchObject({ code: 'ASK_ABORTED' });
  expect(observations(h)).toHaveLength(1);
  expect(h.server.pendingUserQuestions.get(h.root.id)).toBe(q);
  firstSignal.abort();
  expect(await first).toMatchObject({ code: 'ASK_ABORTED' });
  expect(observations(h).map((n) => n.phase)).toEqual(['opened', 'ended']);
  expect(
    h.notices.some((n) => n.method === 'session.user-question-answered'),
  ).toBe(false);
});

it('an unrelated native child cancellation leaves the root card open; root cancellation ends it', async () => {
  const entered = gate(),
    release = gate();
  const h = await setup({
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(r.signal, release);
        return text('子任务完成');
      }
      return [
        {
          type: 'tool-call',
          id: randomUUID(),
          name: 'ask_user_question',
          arguments: JSON.stringify({ questions }),
        },
      ];
    },
  });
  await h.prompt('先问我，同时保留子任务。');
  await card(h);
  const child = await h.spawn();
  await entered.promise;
  h.ctx.agents.get(child.childId).cancel({ kind: 'user' });
  await child.result;
  expect(observations(h).map((n) => n.phase)).toEqual(['opened']);
  expect(h.server.pendingUserQuestions.has(h.root.id)).toBe(true);
  h.root.cancel({ kind: 'user' });
  await h.root.whenIdle();
  await expect.poll(() => observations(h).length).toBe(2);
  expect(observations(h)[1].phase).toBe('ended');
});

it.each(['clear', 'close', 'progress-signal', 'new-run'])(
  'preserves the published identity when the request ends via %s',
  async (mode) => {
    const runId = randomUUID(),
      h = await setup({
        runId,
        ...(mode === 'progress-signal'
          ? {
              model: async (r) => {
                await hold(r.signal, gate());
                return text('完成');
              },
            }
          : {}),
      });
    if (mode === 'progress-signal') {
      await h.prompt('保持工作，等待进度确认。');
      await expect.poll(() => h.root.status).toBe('running');
    }
    const signal = new AbortController();
    const pending = ask(
      h,
      signal.signal,
      mode === 'progress-signal'
        ? `runtime-progress:${randomUUID()}:1`
        : randomUUID(),
    ).catch((e) => e);
    await card(h);
    const opened = observations(h)[0];
    if (mode === 'new-run') {
      await h.server.handleRequest('run/end', { runId });
      await h.server.handleRequest('run/begin', {
        sessionId: h.root.id,
        runId: randomUUID(),
      });
    }
    if (mode === 'progress-signal') signal.abort();
    else if (mode === 'close') await h.server.closeRoot(h.root.id);
    else await h.server.clearRootQuestion(h.root.id, 'fixture cleanup');
    await pending;
    expect(observations(h)).toHaveLength(2);
    expect(observations(h)[1]).toEqual({
      ...opened,
      phase: 'ended',
      observedAt: expect.any(String),
    });
    expect(opened).toMatchObject({
      runId,
      nativeSessionId: h.root.id,
      rootSessionId: h.root.id,
      timed: false,
    });
    expect(
      h.notices.some((n) => n.method === 'session.user-question-answered'),
    ).toBe(false);
  },
);

it('observation transport failure does not replace the question abort', async () => {
  const h = await setup();
  h.server.userQuestionObservationNotify = () => {
    throw Error('observer disconnected');
  };
  const signal = new AbortController();
  const pending = ask(h, signal.signal).catch((e) => e);
  await expect
    .poll(() => h.server.pendingUserQuestions.has(h.root.id))
    .toBe(true);
  signal.abort();
  expect(await pending).toMatchObject({ code: 'ASK_ABORTED' });
});

it('a native timed question remains ended when continued and later settled', async () => {
  const h = await setup({
    questionMode: 'timed',
    releaseMs: 50,
    model: async (_r, n) =>
      n === 1
        ? [
            {
              type: 'tool-call',
              id: 'timed-call',
              name: 'ask_user_question',
              arguments: JSON.stringify({ questions }),
            },
          ]
        : text('继续独立工作'),
  });
  await h.prompt('先问我，有其他工作就继续。');
  await h.wait();
  expect(observations(h).map((n) => n.phase)).toEqual(['opened', 'ended']);
  const { questions: pending } = await h.server.handleRequest(
    'session/user-questions',
    { sessionId: h.root.id },
  );
  expect(pending).toEqual([
    expect.objectContaining({ callId: 'timed-call', state: 'continued' }),
  ]);
  await h.server.handleRequest('session/question-reply', {
    sessionId: h.root.id,
    callId: 'timed-call',
    answers: [{ id: 'go', selected: ['继续'] }],
  });
  await expect
    .poll(
      () =>
        h.notices.filter((n) => n.method === 'session.user-questions').at(-1)
          ?.params.questions.settled,
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: 'timed-call' }),
      ]),
    );
  expect(observations(h).map((n) => n.phase)).toEqual(['opened', 'ended']);
});
