import { randomUUID } from 'node:crypto';
import { NativeQuestionCheckpointSchema } from '@allrice/contracts';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { askProgramQuestion } from '../../dsh/allrice-program-questions.mjs';
import { gate, hold, host, text } from './fixture.mjs';

const tool = (name, args, id = randomUUID()) => [
  {
    type: 'tool-call',
    id,
    name,
    arguments: JSON.stringify(args),
  },
];
const question = (id = 'continue') => ({
  questions: [{ id, question: '请确认继续', options: [{ label: '继续' }] }],
});
const answer = (h, card, selected, overrides = {}) =>
  h.server.steer({
    sessionId: h.root.id,
    runId: h.runId,
    turnId: `${h.root.id}:turn:1`,
    inputId: randomUUID(),
    kind: 'ask_user',
    text: `allrice:user-question:v1:${JSON.stringify({
      questionId: card.questionId,
      answers: [{ id: card.questions[0].id, selected }],
    })}`,
    ...overrides,
  });

it.each(['ordinary-choice', 'runtime-progress'])(
  'legacy model question %s retains ordinary authority across a checkpoint',
  async (id) => {
    const decisions = [];
    const h = await host({
      runId: randomUUID(),
      progress: true,
      questionMode: 'legacy',
      releaseMs: 0,
      bridge: async (method, p) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        if (p.action === 'decide') decisions.push(p);
        return { paused: false, canceled: false };
      },
      model: async (_r, n) =>
        n === 1
          ? tool('ask_user_question', question(id))
          : text('已按普通答案继续'),
    });
    await h.prompt('先问后继续。');
    const q = await card(h);
    const { checkpoint } = await h.server.handleRequest(
      'session/park-question',
      { sessionId: h.root.id, questionId: q.questionId },
    );
    expect(
      NativeQuestionCheckpointSchema.parse(checkpoint).progress,
    ).toBeUndefined();
    await h.server.handleRequest('session/continue-wait', {
      sessionId: h.root.id,
      questionId: q.questionId,
      turnId: checkpoint.turnId,
      inputId: randomUUID(),
      text: `allrice:user-question:v1:${JSON.stringify({ questionId: q.questionId, answers: [{ id, selected: ['继续'] }] })}`,
    });
    await h.wait();
    expect(decisions).toEqual([]);
    expect(h.calls).toHaveLength(2);
  },
);

it.each(['same', 'replacement', 'wrong-run', 'wrong-turn', 'answer-only'])(
  'legacy program question checks its original pause before adoption: %s',
  async (variant) => {
    const runId = randomUUID(),
      originalPause = randomUUID(),
      decisions = [];
    let pauseId = originalPause,
      paused = true;
    const h = await host({
      runId,
      progress: true,
      questionMode: 'legacy',
      releaseMs: 0,
      bridge: async (method, p) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        if (p.action === 'decide') {
          decisions.push(p);
          paused = false;
        }
        return { paused, pauseId, canceled: false, reason: 'repeated_failure' };
      },
    });
    await h.prompt('先确认进度。');
    const q = await card(h);
    const { checkpoint } = await h.server.handleRequest(
      'session/park-question',
      { sessionId: h.root.id, questionId: q.questionId },
    );
    expect(NativeQuestionCheckpointSchema.parse(checkpoint).progress).toEqual({
      runId,
      pauseId: originalPause,
    });
    if (variant === 'replacement' || variant === 'answer-only')
      pauseId = randomUUID();
    if (variant === 'wrong-run') {
      await h.server.handleRequest('run/end', { runId });
      await h.server.handleRequest('run/begin', {
        sessionId: h.root.id,
        runId: randomUUID(),
      });
    }
    const request = h.server.handleRequest(
      variant === 'answer-only'
        ? 'session/answer-wait'
        : 'session/continue-wait',
      {
        sessionId: h.root.id,
        questionId: q.questionId,
        turnId: variant === 'wrong-turn' ? 'wrong-turn' : checkpoint.turnId,
        inputId: randomUUID(),
        text: `allrice:user-question:v1:${JSON.stringify({ questionId: q.questionId, answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }] })}`,
      },
    );
    if (variant === 'same') {
      await request;
      await h.wait();
      expect(decisions).toMatchObject([
        { runId, pauseId: originalPause, decision: 'continue' },
      ]);
    } else {
      await expect(request).rejects.toThrow(
        variant === 'wrong-turn'
          ? 'NATIVE_WAIT_CHANGED'
          : 'task_progress_stale_pause',
      );
      expect(decisions).toEqual([]);
      expect(
        h.root.session
          .snapshotEvents()
          .filter((e) => e.type === 'allrice/input/answered'),
      ).toEqual([]);
    }
  },
);
async function card(h) {
  await expect
    .poll(() => h.server.pendingUserQuestions.get(h.root.id))
    .toBeTruthy();
  return h.server.pendingUserQuestions.get(h.root.id);
}

async function pausedChild(releaseMs = 5000) {
  const childEntered = gate(),
    releaseChild = gate();
  const runId = randomUUID(),
    pauseId = randomUUID(),
    decisions = [],
    receipts = [];
  let paused = false,
    canceled = false,
    roots = 0,
    children = 0,
    lease = true;
  const h = await host({
    runId,
    progress: true,
    accounting: true,
    questionMode: 'legacy',
    releaseMs,
    nativeTools: ['local.fs.list'],
    bridge: async (method, p) => {
      if (method === 'allrice/run-authorize') {
        if (!lease) throw Error('lease_lost');
        return { allowed: true };
      }
      if (method === 'allrice/model-receipt') {
        receipts.push(p);
        return {};
      }
      expect(method).toBe('allrice/progress');
      if (
        p.action === 'finish' &&
        p.kind === 'tool' &&
        p.nativeSessionId !== 'pr0-root'
      )
        paused = true;
      if (p.action === 'decide') {
        expect(p).toMatchObject({
          pauseId,
          nativeSessionId: 'pr0-root',
          runId,
        });
        decisions.push(p.decision);
        paused = false;
        canceled = p.decision === 'cancel';
      }
      if (canceled && p.action === 'check')
        throw Error('task_progress_canceled');
      return { paused, pauseId, canceled, reason: 'repeated_failure' };
    },
    model: async (r) => {
      if (r.sessionId === 'pr0-root')
        return ++roots === 1
          ? tool('subagent', {
              description: '读取目录',
              prompt: '读取子任务目录',
            })
          : text('等待子任务');
      if (++children === 1) {
        childEntered.resolve();
        await hold(r.signal, releaseChild);
        return tool('local_fs_list', { path: 42 });
      }
      return text('子任务完成');
    },
  });
  await h.prompt('派子任务读取目录，失败时先问我再继续。');
  await childEntered.promise;
  await h.root.whenIdle();
  const waiting = h.wait();
  releaseChild.resolve();
  return {
    ...h,
    runId,
    pauseId,
    waiting,
    decisions,
    receipts,
    loseLease: () => {
      lease = false;
    },
  };
}

it.each(['重新检查后继续', '取消任务'])(
  'root idle + child active accepts the actual Run program answer: %s',
  async (choice) => {
    const h = await pausedChild();
    const q = await card(h);
    expect(h.root.status).toBe('idle');
    expect(
      h.ctx.agents.list().some((a) => a !== h.root && a.status === 'running'),
    ).toBe(true);
    for (const overrides of [
      { runId: randomUUID() },
      { turnId: `${h.root.id}:turn:999` },
      { sessionId: 'foreign-root' },
      {
        text: `allrice:user-question:v1:${JSON.stringify({ questionId: 'old-question', answers: [{ id: 'runtime-progress', selected: [choice] }] })}`,
      },
    ])
      await expect(answer(h, q, [choice], overrides)).rejects.toThrow();
    const inputId = randomUUID();
    expect(await answer(h, q, [choice], { inputId })).toMatchObject({
      status: 'adopted',
      inputId,
      runId: h.runId,
      checkpoint: 'question_resolved',
    });
    await h.waiting;
    expect(await answer(h, q, [choice], { inputId })).toMatchObject({
      status: 'adopted',
      runId: h.runId,
    });
    expect(h.decisions).toEqual([
      choice === '取消任务' ? 'cancel' : 'continue',
    ]);
    expect(
      h.notices.filter((n) => n.method === 'session.user-question'),
    ).toHaveLength(1);
    expect(
      h.receipts.filter((p) => p.fact?.phase === 'finish').length,
    ).toBeGreaterThanOrEqual(3);
    await expect(answer(h, q, [choice])).rejects.toThrow();
  },
);

it('expiry fences calls and queued program cards before child settlement can reawaken root', async () => {
  const h = await pausedChild(250);
  const q = await card(h);
  const queued = expect(
    askProgramQuestion(
      h.ctx.userQuestions,
      { agent: h.root, ...question('runtime-progress') },
      `runtime-progress:${randomUUID()}:1`,
    ),
  ).rejects.toThrow('RUN_NOT_ACTIVE');
  await h.waiting;
  await queued;
  expect(h.decisions).toEqual([]);
  expect(
    h.notices.filter((n) => n.method === 'session.user-question-pending'),
  ).toHaveLength(1);
  expect(
    h.notices.filter((n) => n.method === 'session.user-question'),
  ).toHaveLength(1);
  await expect(answer(h, q, ['重新检查后继续'])).rejects.toThrow();
  await expect(h.prompt('到期后的迟到模型请求')).rejects.toThrow(
    'RUN_NOT_ACTIVE',
  );
});

it('an input that loses its actual Worker lease cannot resolve the program pause', async () => {
  const h = await pausedChild();
  const q = await card(h);
  h.loseLease();
  await expect(answer(h, q, ['重新检查后继续'])).rejects.toThrow('lease_lost');
  expect(h.decisions).toEqual([]);
  await h.server.closeRoot(h.root.id);
  await h.waiting;
});

it('a model-authored runtime-progress ID cannot impersonate a Run program question', async () => {
  const runId = randomUUID();
  const h = await host({
    runId,
    questionMode: 'legacy',
    bridge: async () => ({ allowed: true }),
    model: async (_r, n) =>
      n === 1
        ? tool('ask_user_question', question('runtime-progress'))
        : text('完成'),
  });
  await h.prompt('问我是否继续。');
  const q = await card(h);
  expect(q.programRunId).toBeUndefined();
  expect(
    h.notices.find((n) => n.method === 'session.user-question').params
      .progressPauseId,
  ).toBeUndefined();
  await expect(
    answer({ ...h, runId }, q, ['继续'], { turnId: `${h.root.id}:turn:99` }),
  ).rejects.toThrow('INPUT_TURN_CHANGED');
  await answer({ ...h, runId }, q, ['继续']);
  await h.wait();
});

it('JSON metadata cannot grant an ordinary public question the idle Run exception', async () => {
  const runId = randomUUID();
  const h = await host({ runId, bridge: async () => ({ allowed: true }) });
  await h.prompt('完成本轮。');
  await h.root.whenIdle();
  const request = h.ctx.userQuestions.ask({
    agent: h.root,
    ...question('runtime-progress'),
    programRunId: runId,
    progressPauseId: 'fake-pause',
    progress: { runId, pauseId: 'fake-pause' },
    metadata: { programQuestion: 'runtime-progress:fake-pause:1' },
    'Symbol(allrice-program-question)': 'runtime-progress:fake-pause:1',
  });
  const rejected = expect(request).rejects.toThrow();
  const q = await card(h);
  expect(q.programRunId).toBeUndefined();
  expect(q.progress).toBeUndefined();
  await expect(answer({ ...h, runId }, q, ['继续'])).rejects.toThrow();
  await h.server.closeRoot(h.root.id);
  await rejected;
});

async function blockedRoot() {
  const runId = randomUUID();
  const h = await host({
    runId,
    questionMode: 'legacy',
    bridge: async () => ({ allowed: true }),
    model: async (r, n) =>
      r.sessionId === 'pr0-root' && n === 1
        ? tool('ask_user_question', question())
        : text('子任务完成'),
  });
  await h.prompt('先等我确认再汇总。');
  return { ...h, runId, q: await card(h) };
}

it('child keeps DELEGATED_CALLER and needsLogin, then native send_message brings the unresolved need to the real parent', async () => {
  const runId = randomUUID(),
    connectionId = randomUUID(),
    requestId = randomUUID();
  const login = {
    needsLogin: true,
    requestId,
    connection: { id: connectionId },
    loginPath: '/connect/actual',
  };
  let roots = 0,
    children = 0,
    childId;
  const h = await host({
    runId,
    questionMode: 'legacy',
    nativeTools: ['cloud.mcp.call'],
    bridge: async (method, p) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      expect(method).toBe('allrice/tool-call');
      expect(p).toMatchObject({
        name: 'cloud.mcp.call',
        runId,
        parentSessionId: 'pr0-root',
      });
      childId = p.nativeSessionId;
      return { modelContent: JSON.stringify(login) };
    },
    model: async (r) => {
      if (r.sessionId === 'pr0-root') {
        if (++roots === 1)
          return tool('subagent', {
            description: '读取应用',
            prompt: '读取应用里的资料',
          });
        if (
          JSON.stringify(r.messages).includes('NEEDS_LOGIN_TO_PARENT') &&
          !JSON.stringify(r.messages).includes('root-confirm')
        )
          return tool('ask_user_question', question('root-confirm'));
        return text('等待或汇总');
      }
      if (++children === 1)
        return tool('ask_user_question', question('child-confirm'));
      if (children === 2) {
        await expect(
          h.ctx.userQuestions.ask({
            agent: h.ctx.agents.get(r.sessionId),
            ...question('native-code'),
          }),
        ).rejects.toMatchObject({ code: 'DELEGATED_CALLER' });
        return tool('cloud_mcp_call', {
          connectionId,
          tool: 'read',
          arguments: {},
        });
      }
      if (children === 3) {
        expect(JSON.stringify(r.messages)).toContain('needsLogin');
        expect(JSON.stringify(r.messages)).not.toContain(
          'connection_wait_session_missing',
        );
        return tool('send_message', {
          agent_id: 'pr0-root',
          message: `NEEDS_LOGIN_TO_PARENT ${JSON.stringify(login)}`,
        });
      }
      return text('连接未决，已交父级');
    },
  });
  await h.prompt('派子任务读取应用，缺登录时问我。');
  const q = await card(h);
  expect(q.questions[0].id).toBe('root-confirm');
  expect(q.programRunId).toBeUndefined();
  expect(
    h.notices.filter((n) => n.method === 'session.user-question'),
  ).toHaveLength(1);
  const received = h.root.session
    .snapshotEvents()
    .find(
      (e) =>
        e.type === 'user/message' && e.data.source?.senderSessionId === childId,
    );
  expect(received.data.source.kind).not.toBe('user');
  const turn = h.root.session
    .snapshotEvents()
    .findLast((e) => e.type === 'turn/start').data.turn;
  await answer({ ...h, runId }, q, ['继续'], {
    turnId: `${h.root.id}:turn:${turn}`,
  });
  await h.wait();
  expect(h.calls.filter((r) => r.sessionId === childId)).toHaveLength(4);
});

it.each(['settle', 'answer', 'stop'])(
  'legacy park joins public in-flight creation before %s and never waits on the blocked root',
  async (race) => {
    const h = await blockedRoot(),
      creating = gate(),
      release = gate();
    const create = h.ctx.agents.create.bind(h.ctx.agents);
    vi.spyOn(h.ctx.agents, 'create').mockImplementationOnce(async (input) => {
      creating.resolve();
      await hold(input.signal, release);
      return create(input);
    });
    const start = h.spawn();
    void start.catch(() => {});
    await creating.promise;
    expect(h.ctx.agents.list().map((a) => a.id)).toEqual([h.root.id]);
    let done = false;
    const parking = h.server
      .handleRequest('session/park-question', {
        sessionId: h.root.id,
        questionId: h.q.questionId,
      })
      .then((result) => {
        done = true;
        return result;
      });
    await setImmediate();
    expect(done).toBe(false);
    expect(h.root.status).toBe('running');
    let closing;
    if (race === 'answer') await answer(h, h.q, ['继续']);
    if (race === 'stop') closing = h.server.closeRoot(h.root.id);
    release.resolve();
    const activation = await start.catch(() => null);
    await activation?.result;
    const result = await parking.catch((error) => error);
    await closing;
    if (race === 'settle') {
      expect(result.checkpoint).toMatchObject({ questionId: h.q.questionId });
      expect(
        h.root.inbox.nextStep.some(
          (m) => m.source?.kind === 'subagent-settled',
        ),
      ).toBe(true);
    } else expect(result.checkpoint).toBeFalsy();
  },
);

it('legacy park rejects a live child without interrupting it, then rechecks an in-flight answer after the public barrier', async () => {
  const h = await blockedRoot(),
    entered = gate(),
    release = gate();
  h.ctx.on('agent/request', async ({ agent, signal }, next) => {
    if (agent !== h.root) {
      entered.resolve();
      await hold(signal, release);
    }
    return next();
  });
  const child = await h.spawn();
  await entered.promise;
  const park = () =>
    h.server.handleRequest('session/park-question', {
      sessionId: h.root.id,
      questionId: h.q.questionId,
    });
  expect(await park()).toEqual({ checkpoint: null });
  expect(h.ctx.agents.get(child.childId).status).toBe('running');
  release.resolve();
  await child.result;
  const flushing = gate(),
    finishFlush = gate();
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  vi.spyOn(h.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    await flush(session);
    flushing.resolve();
    await finishFlush.promise;
  });
  const replying = answer(h, h.q, ['继续']);
  await flushing.promise;
  expect(await park()).toEqual({ checkpoint: null });
  finishFlush.resolve();
  expect(await replying).toMatchObject({ status: 'adopted' });
  await h.wait();
});
