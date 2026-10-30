import { afterEach, expect, it, vi } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  AssistantStreamAccumulator,
  assembleAssistantStream,
} from '@deepseek-ai/dsh-llm';
import {
  NativeSubagentSnapshotSchema,
  nativeChildViewLimits as limits,
  toolActivityDetail,
} from '@allrice/contracts/native-runtime';
import { gate, hold, host, text } from '../test/native-subagent/fixture.mjs';
import {
  NativeChildDisplay,
  projectNativeChildCut,
} from './allrice-native-display.mjs';

afterEach(() => vi.restoreAllMocks());
const query = (h, childId, sessionId = h.root.id) =>
  h.server.handleRequest('session/subagent-snapshot', { sessionId, childId });
const block = (value) => ({
  type: 'block-end',
  index: 0,
  block: { type: 'text', text: value },
});

it('用户查看两个子任务各自在做什么：真实 Host 中途打开、fork own、工具错误和最终文字不串不重复', async () => {
  const streamed = gate(),
    release = gate(),
    stopped = gate(),
    finish = gate();
  const steps = new Map(),
    active = new Set(),
    closing = new Set();
  const h = await host({
    stream: async function* (request) {
      const id = request.sessionId;
      if (id === 'pr0-root') {
        yield block('PARENT_REPLY');
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const step = (steps.get(id) ?? 0) + 1;
      steps.set(id, step);
      if (step === 1) {
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `call-${id}`,
            name: 'pr3c_search',
            arguments: JSON.stringify({
              query: `公开查询 ${id}`,
              token: 'RAW_SECRET',
              command: 'RAW_COMMAND',
            }),
          },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING' };
      yield {
        type: 'text-delta',
        index: 1,
        text: `<think>HIDDEN_PREFIX</think>answer:${id}`,
      };
      active.add(id);
      if (active.size === 2) streamed.resolve();
      await hold(request.signal, release);
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'text',
          text: `<think>HIDDEN_PREFIX</think>answer:${id}`,
        },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  h.ctx.tools.register(
    defineTool({
      name: 'pr3c_search',
      description: 'offline search',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => text(value) },
      execute: async () => {
        throw Error('RAW_RESULT_SECRET');
      },
    }),
  );
  await h.prompt('PARENT_TASK');
  await h.wait();
  h.ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.id === h.root.id) return;
    closing.add(agent.id);
    if (closing.size === 2) stopped.resolve();
    await hold(signal, finish);
  });
  const a = await h.spawn(h.root, '任务 A', {
    provider: 'fork',
    request: {
      parent: h.root,
      prompt: [...text('任务 A'), ...text('INTERNAL_RETURN_GUIDANCE')],
    },
  });
  const b = await h.spawn(h.root, '任务 B');
  try {
    await streamed.promise;
    const agents = [a, b].map((x) => h.ctx.agents.get(x.childId));
    const events = agents.map((agent) => agent.session.snapshotEvents());
    const calls = h.calls.length,
      create = vi.spyOn(h.ctx.sessions, 'create'),
      ensure = vi.spyOn(h.server, 'ensureRoot'),
      open = vi.spyOn(h.ctx.sessionPersistence, 'open');
    const snapshots = await Promise.all([
      query(h, a.childId),
      query(h, b.childId),
    ]);
    for (const [i, s] of snapshots.entries()) {
      expect(NativeSubagentSnapshotSchema.parse(s)).toEqual(s);
      expect(s.task.text).toBe(i === 0 ? '任务 A' : '任务 B');
      expect(s.stream.active.text).toBe(`answer:${s.childId}`);
      expect(s.stream.complete).toBe(true);
      expect(s.rows).toEqual([
        expect.objectContaining({
          kind: 'tool',
          callId: `call-${s.childId}`,
          activityDetail: `搜索资料：公开查询 ${s.childId}`,
          result: expect.objectContaining({
            failed: true,
            summary: '工具执行失败',
          }),
        }),
      ]);
      expect(s.observation.cursor).toBe(agents[i].session.seq - 1);
      const frame = h.notices
        .filter(
          (n) =>
            n.method === 'session.assistant-stream' &&
            n.params.sessionId === s.childId,
        )
        .at(-1).params;
      expect(frame.instanceId).toBe(s.stream.instanceId);
      expect(frame.frame.revision).toBe(s.stream.revision);
      expect(await query(h, s.childId)).toEqual(s);
    }
    expect(snapshots[0].inheritedEventCount).toBeGreaterThan(0);
    expect(snapshots[0].stream.instanceId).not.toBe(
      snapshots[1].stream.instanceId,
    );
    expect(JSON.stringify(snapshots)).not.toMatch(
      /PARENT_|PRIVATE_|HIDDEN_|RAW_|INTERNAL_/,
    );
    expect(agents.map((agent) => agent.session.snapshotEvents())).toEqual(
      events,
    );
    expect(h.calls).toHaveLength(calls);
    expect(create).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    release.resolve();
    await stopped.promise;
    for (const activation of [a, b]) {
      const s = await query(h, activation.childId);
      expect(s.stream.active).toBeNull();
      expect(s.rows.filter((row) => row.kind === 'assistant')).toEqual([
        expect.objectContaining({ text: `answer:${activation.childId}` }),
      ]);
    }
  } finally {
    release.resolve();
    finish.resolve();
    await Promise.all([a.result, b.result]);
    await h.wait();
  }
}, 30_000);

it.each([
  ['a', 'b', 'ab', 'b', 'ab'],
  ['ab', '', 'ab', 'b', 'abb'],
  ['<thi', 'nk>PRIVATE', '', 'nk>PRIVATE</think>safe', 'safe'],
])(
  'consumes safe Host replacements from a mid-attempt cut: %j / %j',
  async (left, right, before, ending, after) => {
    const entered = gate(),
      release = gate(),
      updated = gate(),
      finish = gate();
    let selected, consumer;
    const received = [];
    const h = await host({
      onNotification: ({ method, params }) => {
        if (
          method === 'session.assistant-stream' &&
          params.sessionId === selected
        ) {
          // This consumer never reads frame, records, hidden prefixes or block IDs.
          consumer = params.display;
          received.push(consumer);
        }
      },
      stream: async function* (request) {
        if (request.sessionId === 'pr0-root') {
          yield block('root');
        } else {
          yield { type: 'text-delta', index: 0, text: left };
          yield { type: 'text-delta', index: 1, text: right };
          entered.resolve();
          await hold(request.signal, release);
          yield {
            type: 'block-end',
            index: 1,
            block: { type: 'text', text: ending },
          };
          updated.resolve();
          await hold(request.signal, finish);
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    });
    const activation = await h.spawn();
    try {
      await entered.promise;
      const snapshot = await query(h, activation.childId);
      selected = activation.childId;
      consumer = snapshot.stream;
      expect(consumer).toMatchObject({
        mode: 'replace',
        cursor: snapshot.observation.cursor,
        complete: true,
        active: { text: before },
      });
      release.resolve();
      await updated.promise;
      expect(consumer.active.text).toBe(after);
      expect(consumer).toEqual((await query(h, activation.childId)).stream);
      expect(received).toHaveLength(1);
      expect(consumer).toMatchObject({
        mode: 'replace',
        instanceId: snapshot.stream.instanceId,
        complete: true,
        active: {
          attemptId: snapshot.stream.active.attemptId,
          nextIndex: snapshot.stream.active.nextIndex + 1,
          truncated: false,
        },
      });
      expect(consumer.revision).toBe(snapshot.stream.revision + 1);
      expect(JSON.stringify([snapshot.stream, ...received])).not.toMatch(
        /PRIVATE|<think>|reasoning|records/,
      );
      // The original native frame still reports the original unprojected block.
      expect(h.notices.at(-1).params.frame.chunk.block.text).toBe(ending);
    } finally {
      release.resolve();
      finish.resolve();
      await activation.result;
      await h.wait();
    }
    expect(consumer.active).toBeNull();
  },
  30_000,
);

it('captures the stream baseline before the public observation Promise yields to a new chunk', async () => {
  const first = gate(),
    next = gate(),
    second = gate(),
    finish = gate();
  const h = await host({
    stream: async function* (request) {
      yield { type: 'text-delta', index: 0, text: 'A' };
      if (request.sessionId !== 'pr0-root') {
        first.resolve();
        await hold(request.signal, next);
        yield { type: 'text-delta', index: 0, text: 'B' };
        second.resolve();
        await hold(request.signal, finish);
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const activation = await h.spawn();
  try {
    await first.promise;
    let childReads = 0;
    const original = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery);
    const spy = vi
      .spyOn(h.ctx.sessionQuery, 'observeSession')
      .mockImplementation((id, ...args) => {
        const cut = original(id, ...args);
        if (id === activation.childId && ++childReads === 2) next.resolve();
        return cut;
      });
    const before = await query(h, activation.childId);
    expect(before.stream.active.text).toBe('A');
    await second.promise;
    spy.mockRestore();
    const after = await query(h, activation.childId);
    expect(after.stream.active.text).toBe('AB');
    expect(after.stream.revision).toBeGreaterThan(before.stream.revision);
    expect(after.stream.instanceId).toBe(before.stream.instanceId);
  } finally {
    next.resolve();
    finish.resolve();
    await activation.result;
    await h.wait();
  }
}, 30_000);

it('refuses wrong root, unverified lineage and root epoch changes at the actual Host entry', async () => {
  const entered = gate(),
    finish = gate();
  const h = await host({
    model: async (request) => {
      if (request.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(request.signal, finish);
      }
      return text('answer');
    },
  });
  const activation = await h.spawn();
  const foreign = await h.ctx.agents.create({
    sessionId: 'foreign-root',
    agentOptions: { provider: 'pr0-synthetic', model: 'fixed' },
  });
  try {
    await entered.promise;
    await expect(query(h, activation.childId, 'wrong-root')).rejects.toThrow(
      'INPUT_SESSION_NOT_LIVE',
    );
    await expect(query(h, foreign.agent.id)).rejects.toThrow(
      'NATIVE_QUERY_CHILD_UNVERIFIED',
    );
    await expect(query(h, h.root.id)).rejects.toThrow(
      'NATIVE_QUERY_CHILD_UNVERIFIED',
    );
    const original = h.server.nativeSubagentSummary.bind(h.server);
    const spy = vi
      .spyOn(h.server, 'nativeSubagentSummary')
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        h.server.epoch++;
        return result;
      });
    await expect(query(h, activation.childId)).rejects.toThrow(
      'INPUT_SESSION_NOT_LIVE',
    );
    spy.mockRestore();
    h.server.epoch--;
    const child = h.ctx.agents.get(activation.childId),
      get = h.ctx.agents.get.bind(h.ctx.agents);
    const mismatched = vi
      .spyOn(h.ctx.agents, 'get')
      .mockImplementation((id) =>
        id === child.id ? { session: h.root.session } : get(id),
      );
    await expect(query(h, child.id)).rejects.toThrow(
      'NATIVE_QUERY_CHILD_NOT_LIVE',
    );
    mismatched.mockRestore();
  } finally {
    finish.resolve();
    await foreign.dispose();
    await activation.result;
    await h.wait();
  }
}, 30_000);

it('never observes or wakes a cold child and removes disposed instances from the display owner', async () => {
  const h = await host();
  let child;
  h.ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== h.root.id) child = agent;
  });
  const activation = await h.spawn();
  await activation.result;
  await h.wait();
  expect(h.server.childDisplay.agents.has(child)).toBe(false);
  const observe = vi.spyOn(h.ctx.sessionQuery, 'observeSession'),
    ensure = vi.spyOn(h.server, 'ensureRoot'),
    create = vi.spyOn(h.ctx.sessions, 'create'),
    calls = h.calls.length;
  await expect(query(h, activation.childId)).rejects.toThrow(
    'NATIVE_QUERY_CHILD_NOT_LIVE',
  );
  expect(observe).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(calls);
  const notices = h.notices.length;
  h.ctx.emit('agent/assistant-stream', {
    agent: child,
    frame: {
      type: 'start',
      attemptId: `${child.id}:1`,
      revision: 1,
      turn: 0,
      step: 0,
    },
  });
  expect(h.notices).toHaveLength(notices);
  expect(h.server.childDisplay.agents.has(child)).toBe(false);
  await h.server.closeRoot(h.root.id);
  expect(h.server.childDisplay.agents.has(h.root)).toBe(false);
}, 30_000);

function streamFixture() {
  const display = new NativeChildDisplay(),
    agent = { session: { seq: 9 } };
  let revision = 0,
    index = 0;
  const start = () => {
    revision = 0;
    index = 0;
    display.accept(agent, {
      type: 'start',
      attemptId: 'child:1',
      revision: ++revision,
      turn: 1,
      step: 0,
    });
  };
  const push = (chunk) =>
    display.accept(agent, {
      type: 'chunk',
      attemptId: 'child:1',
      revision: ++revision,
      index: index++,
      time: 123,
      chunk,
    });
  const end = (kind) =>
    display.accept(agent, {
      type: 'end',
      attemptId: 'child:1',
      revision: ++revision,
      index,
      outcome: {
        kind,
        ...(kind === 'committed'
          ? { seq: 9, eventType: 'assistant/message' }
          : {}),
      },
    });
  start();
  return {
    display,
    agent,
    start,
    push,
    end,
    view: () => display.snapshot(agent),
  };
}

it.each(['committed', 'abandoned'])(
  'clears %s attempts and does not retain private chunks',
  (outcome) => {
    const s = streamFixture();
    s.push({ type: 'reasoning-delta', index: 0, text: 'SECRET' });
    s.push({
      type: 'tool-call-delta',
      index: 1,
      id: 'tool',
      name: 'bash',
      argumentsDelta: 'SECRET_COMMAND',
    });
    s.push({ type: 'text-delta', index: 2, text: '<thi' });
    expect(s.view().active.text).toBe('');
    s.push({
      type: 'text-delta',
      index: 2,
      text: 'nk>PRIVATE</think>公开文字',
    });
    expect(s.view().active.text).toBe('公开文字');
    expect(
      JSON.stringify(s.display.state(s.agent).active.stream.snapshot()),
    ).not.toContain('SECRET');
    s.end(outcome);
    expect(s.view().active).toBeNull();
  },
);

it('rebuilds revision 1, separates true Agent objects, marks gaps and drops commit-before-end text', () => {
  const s = streamFixture();
  s.push({ type: 'text-delta', index: 0, text: 'old' });
  const first = s.view().instanceId;
  s.start();
  expect(s.view().instanceId).not.toBe(first);
  expect(s.view().active.text).toBe('');
  const replacement = { session: s.agent.session };
  s.display.accept(replacement, {
    type: 'start',
    attemptId: 'child:1',
    revision: 1,
    turn: 1,
    step: 0,
  });
  expect(s.display.snapshot(replacement).instanceId).not.toBe(
    s.view().instanceId,
  );
  s.push(block('block-only text'));
  expect(s.view().active.text).toBe('block-only text');
  s.display.commit(s.agent, {
    type: 'assistant/message',
    seq: 9,
    data: { turn: 1, step: 0 },
  });
  expect(s.view().active).toBeNull();
  s.start();
  s.display.accept(s.agent, {
    type: 'chunk',
    attemptId: 'child:1',
    revision: 3,
    index: 0,
    time: 123,
    chunk: { type: 'text-delta', index: 0, text: 'missed' },
  });
  expect(s.view()).toMatchObject({ complete: false, active: null });
  s.display.dispose(s.agent);
  expect(s.display.agents.has(s.agent)).toBe(false);
  s.display.clear();
  expect(s.display.agents.has(replacement)).toBe(false);
});

it('bounds retained stream memory and projected history, reports every omitted boundary, and hides internal envelopes', () => {
  const s = streamFixture();
  for (let i = 0; i <= limits.chunks; i++)
    s.push({ type: 'text-delta', index: 0, text: 'x' });
  expect(s.view().active).toMatchObject({
    text: 'x'.repeat(limits.chunks),
    truncated: true,
    nextIndex: limits.chunks + 1,
  });
  expect(s.view().complete).toBe(false);
  s.start();
  s.push({
    type: 'text-delta',
    index: 0,
    text: 'x'.repeat(limits.streamCharacters + 1),
  });
  expect(s.view().active.truncated).toBe(true);
  expect(s.view().complete).toBe(false);
  expect(s.display.state(s.agent).active.stream.snapshot()).toEqual([]);
  s.start();
  s.push(block('<allrice_tool_call>{"command":"PRIVATE"}</allrice_tool_call>'));
  expect(s.view().active.text).toBe('');
  const events = [
    {
      seq: 0,
      type: 'assistant/message',
      data: { turn: 0, step: 0, message: { content: text('INHERITED') } },
    },
    {
      seq: 1,
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [...text('T'.repeat(limits.text + 1)), ...text('INTERNAL')],
      },
    },
    ...Array.from({ length: limits.events + 1 }, (_, i) => ({
      seq: i + 2,
      type: 'assistant/message',
      data: {
        turn: i,
        step: 0,
        message: {
          content: text(
            i === limits.events ? 'A'.repeat(limits.text + 1) : 'visible',
          ),
        },
      },
    })),
  ];
  const view = projectNativeChildCut({ inheritedEventCount: 1, events });
  expect(view.window).toEqual({ fromSeq: 3, omittedEvents: 2, omittedRows: 0 });
  expect(view.rows).toHaveLength(limits.events);
  expect(view.task).toMatchObject({
    text: 'T'.repeat(limits.text),
    truncated: true,
  });
  expect(view.rows.at(-1)).toMatchObject({
    text: 'A'.repeat(limits.text),
    truncated: true,
  });
  expect(JSON.stringify(view)).not.toMatch(/INHERITED|INTERNAL/);
  const partial = projectNativeChildCut({
    inheritedEventCount: 0,
    events: [
      {
        seq: 0,
        type: 'tool/call',
        data: { callId: 'x'.repeat(513), name: 'bash', arguments: '{}' },
      },
      {
        seq: 1,
        type: 'tool/result',
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call',
            isError: false,
            content: text('error is ordinary output'),
          },
        },
      },
    ],
  });
  expect(partial.window.omittedRows).toBe(1);
  expect(partial.rows[0]).toMatchObject({
    callId: 'call',
    result: { failed: false },
  });
  const reusedId = projectNativeChildCut({
    inheritedEventCount: 0,
    events: [
      {
        seq: 0,
        type: 'tool/call',
        data: {
          turn: 0,
          step: 0,
          callId: 'reused',
          name: 'bash',
          arguments: '{}',
        },
      },
      {
        seq: 1,
        type: 'tool/result',
        data: {
          turn: 0,
          step: 0,
          message: {
            role: 'tool',
            toolCallId: 'reused',
            isError: true,
            content: [],
          },
        },
      },
      {
        seq: 2,
        type: 'tool/call',
        data: {
          turn: 0,
          step: 1,
          callId: 'reused',
          name: 'bash',
          arguments: '{}',
        },
      },
    ],
  });
  expect(reusedId.rows).toHaveLength(2);
  expect(reusedId.rows[0].result.failed).toBe(true);
  expect(reusedId.rows[1].result).toBeUndefined();
});

it('keeps native text block appearance order and counts zero-character starts against the display budget', () => {
  const s = streamFixture(),
    native = new AssistantStreamAccumulator();
  for (const chunk of [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'B' },
    { type: 'text-delta', index: 0, text: 'A' },
  ]) {
    s.push(chunk);
    native.push({ time: 123, chunk });
  }
  const expected = assembleAssistantStream(native.snapshot())
    .blocks()
    .map((block) => block.text)
    .join('');
  expect(expected).toBe('AB');
  expect(s.view().active.text).toBe(expected);
  s.start();
  for (let i = 0; i <= limits.chunks; i++)
    s.push({ type: 'block-start', index: i, blockType: 'text' });
  expect(s.view()).toMatchObject({
    complete: false,
    active: { text: '', truncated: true },
  });
  expect(s.display.state(s.agent).active.stream.snapshot()).toHaveLength(
    limits.chunks,
  );
});

it.each([
  ['search', 'query', 100, (n) => 'q'.repeat(n), (s) => `搜索资料：${s}`],
  ['search', 'queries', 100, (n) => ['q'.repeat(n)], (s) => `搜索资料：${s}`],
  [
    'market.quote',
    'symbol',
    32,
    (n) => 'A'.repeat(n),
    (s) => `查询 ${s} 的实时行情`,
  ],
  ['read_file', 'path', 500, (n) => 'p'.repeat(n), (s) => `阅读文件：${s}`],
  ['bash', 'description', 120, (n) => '测'.repeat(n), (s) => s],
])(
  'reports safe field cuts without changing legacy strings: %s.%s',
  (name, field, maximum, make, describe) => {
    for (const length of [maximum - 1, maximum, maximum + 1]) {
      const args = { [field]: make(length) },
        shortened = vi.fn(),
        detail = toolActivityDetail(name, args, shortened),
        original = Array.isArray(args[field]) ? args[field][0] : args[field];
      expect(detail).toBe(describe(original.slice(0, maximum)));
      expect(detail).toBe(toolActivityDetail(name, args));
      expect(shortened).toHaveBeenCalledTimes(length > maximum ? 1 : 0);
      const view = projectNativeChildCut({
        inheritedEventCount: 0,
        events: [
          {
            seq: 0,
            type: 'tool/call',
            data: { name, callId: 'call', arguments: JSON.stringify(args) },
          },
        ],
      });
      expect(view.rows[0]).toMatchObject({
        activityDetail: detail,
        truncated: length > maximum,
      });
    }
  },
);

it('preserves query-array whitespace and ignores cuts of unused or rejected description fields', () => {
  const shortened = vi.fn(),
    args = { queries: ['  ' + 'q'.repeat(100)], symbol: 'x'.repeat(100) };
  expect(toolActivityDetail('search', args, shortened)).toBe(
    '搜索资料：  ' + 'q'.repeat(98),
  );
  expect(shortened).toHaveBeenCalledTimes(1);
  shortened.mockClear();
  expect(
    toolActivityDetail('search', { ...args, query: 'ok' }, shortened),
  ).toBe('搜索资料：ok');
  expect(shortened).not.toHaveBeenCalled();
  expect(
    toolActivityDetail('bash', { description: 'x'.repeat(121) }, shortened),
  ).toBeUndefined();
  expect(shortened).not.toHaveBeenCalled();
});
