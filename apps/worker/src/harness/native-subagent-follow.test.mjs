/* global AbortController, structuredClone */
import { afterEach, expect, it, vi } from 'vitest';
import { followNativeSubagent } from './native-subagent-follow.ts';

const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const cleanups = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.useRealTimers();
});

function fixture(detail = true) {
  const listeners = new Set(),
    failures = new Set(),
    events = [],
    waiting = [];
  const abort = new AbortController();
  const summary = {
    rootId: 'root',
    root: { source: 'live', cursor: 2 },
    descendants: [
      {
        kind: 'child',
        id: 'child',
        parentId: 'root',
        depth: 1,
        mode: 'continuable',
        running: true,
        activity: 'running',
        observation: { source: 'live', cursor: 4 },
        timing: { settledMs: 0 },
        usage: {
          uncachedInputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        },
        lastReply: null,
      },
    ],
  };
  const snapshot = {
    rootId: 'root',
    childId: 'child',
    hostEpoch: 1,
    observation: { source: 'live', cursor: 4 },
    inheritedEventCount: 0,
    window: { fromSeq: 0, omittedEvents: 0, omittedRows: 0 },
    task: null,
    rows: [],
    stream: {
      mode: 'replace',
      cursor: 4,
      instanceId: 'agent-a',
      revision: 3,
      complete: true,
      active: {
        attemptId: 'attempt-a',
        turn: 1,
        step: 0,
        startedAfterSeq: 4,
        nextIndex: 2,
        text: 'AB',
        truncated: false,
      },
    },
  };
  const client = {
    subscribe: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    onFailure: (f) => {
      failures.add(f);
      return () => failures.delete(f);
    },
    nativeSubagentSummary: vi.fn(async () => structuredClone(summary)),
    nativeSubagentSnapshot: vi.fn(async () => structuredClone(snapshot)),
  };
  const input = {
    childId: detail ? 'child' : undefined,
    signal: abort.signal,
    check: vi.fn(async () => {}),
    terminal: vi.fn(async () => summary),
    send: vi.fn(async (event) => {
      events.push(event);
      for (const resolve of waiting.splice(0)) resolve();
    }),
  };
  let result, done;
  const stop = async () => {
    abort.abort();
    await done;
    expect(listeners.size).toBe(0);
    expect(failures.size).toBe(0);
  };
  cleanups.push(stop);
  return {
    client,
    input,
    snapshot,
    summary,
    events,
    listeners,
    failures,
    abort,
    stop,
    start() {
      done = followNativeSubagent(client, 'root', input).catch((error) => {
        result = error;
      });
      return done;
    },
    done: () => done,
    error: () => result,
    async until(predicate) {
      while (!events.some(predicate)) {
        if (result) throw result;
        await new Promise((resolve) => waiting.push(resolve));
      }
      return events.find(predicate);
    },
    notify(method, params) {
      for (const listener of listeners) listener({ method, params });
    },
    frame(revision, text, overrides = {}) {
      this.notify('session.assistant-stream', {
        sessionId: 'child',
        hostEpoch: 1,
        display: {
          ...snapshot.stream,
          revision,
          active: { ...snapshot.stream.active, text, nextIndex: revision - 1 },
          ...overrides,
        },
        frame: {
          chunk: {
            arguments: 'PRIVATE_COMMAND',
            text: '<think>PRIVATE_THINK</think>',
          },
        },
      });
    },
  };
}

it('subscribes before cut, keeps post-cut/pre-return updates, and ignores older duplicates without concatenation', async () => {
  const f = fixture(),
    release = gate(),
    captured = gate();
  f.client.nativeSubagentSnapshot.mockImplementation(async () => {
    expect(f.listeners.size).toBe(1);
    expect(f.failures.size).toBe(1);
    const cut = structuredClone(f.snapshot);
    captured.resolve();
    await release.promise;
    return cut;
  });
  f.start();
  await captured.promise;
  f.frame(3, 'old');
  f.frame(4, 'ABC');
  f.frame(5, 'ABCD');
  f.frame(4, 'ABC');
  release.resolve();
  const update = await f.until((e) => e?.type === 'display');
  expect(update.display.active.text).toBe('ABCD');
  expect(
    f.events.filter((e) => e.type === 'snapshot')[0].snapshot.stream.active
      .text,
  ).toBe('AB');
  expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE|chunk|frame|arguments/);
  expect(f.client.nativeSubagentSnapshot).toHaveBeenCalledOnce();
});

it.each(['revision', 'cursor', 'instance', 'epoch'])(
  'clears and obtains a fresh source cut for a %s discontinuity',
  async (kind) => {
    const f = fixture();
    f.start();
    await f.until((e) => e?.type === 'snapshot');
    f.snapshot.stream.complete = false;
    f.snapshot.stream.active.truncated = true;
    f.snapshot.stream.revision = 8;
    if (kind === 'instance') f.snapshot.stream.instanceId = 'agent-b';
    if (kind === 'epoch') f.snapshot.hostEpoch = 2;
    const params = {
      sessionId: 'child',
      hostEpoch: kind === 'epoch' ? 2 : 1,
      display: {
        ...f.snapshot.stream,
        revision: kind === 'revision' ? 7 : 4,
        cursor: kind === 'cursor' ? 7 : 4,
      },
    };
    f.notify('session.assistant-stream', params);
    await f.until(
      (e) => e?.type === 'snapshot' && e.snapshot.stream.revision === 8,
    );
    expect(f.events.filter((e) => e.type === 'clear')).toEqual([
      { type: 'clear', reason: 'resync' },
    ]);
    expect(f.events.at(-1).snapshot.stream).toMatchObject({
      complete: false,
      active: { truncated: true },
    });
    expect(f.events.filter((e) => e.type === 'display')).toHaveLength(0);
  },
);

it('counts non-visible native events, refreshes durable rows, and never appends the committed final twice', async () => {
  const f = fixture();
  f.start();
  await f.until((e) => e?.type === 'snapshot');
  f.snapshot.observation.cursor = f.snapshot.stream.cursor = 6;
  f.snapshot.stream.active = null;
  f.snapshot.rows = [
    {
      kind: 'assistant',
      seq: 6,
      turn: 1,
      step: 0,
      text: 'final',
      truncated: false,
    },
  ];
  f.summary.descendants[0].observation.cursor = 6;
  f.notify('session.event', {
    sessionId: 'child',
    event: { seq: 5, type: 'hidden', data: 'PRIVATE' },
  });
  f.notify('session.event', {
    sessionId: 'child',
    event: { seq: 6, type: 'assistant/message', data: 'PRIVATE' },
  });
  const update = await f.until(
    (e) => e?.type === 'snapshot' && e.snapshot.observation.cursor === 6,
  );
  expect(update.snapshot.stream.active).toBeNull();
  expect(update.snapshot.rows).toHaveLength(1);
  expect(f.events.some((e) => e.type === 'clear')).toBe(false);
  expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
});

it('ignores other roots/children and never turns a directory-only finished edge into a cold read', async () => {
  const f = fixture(false);
  f.start();
  await f.until((e) => e?.type === 'directory');
  f.notify('session.event', { sessionId: 'foreign', event: { seq: 99 } });
  f.notify('subagent.finished', {
    parentSessionId: 'foreign',
    childSessionId: 'child',
  });
  f.notify('subagent.finished', {
    parentSessionId: 'root',
    childSessionId: 'child',
  });
  await f.stop();
  expect(f.input.terminal).not.toHaveBeenCalled();
  expect(f.client.nativeSubagentSnapshot).not.toHaveBeenCalled();
  expect(
    f.client.nativeSubagentSummary.mock.calls.every((args) => args[1] === true),
  ).toBe(true);
});

it('performs one terminal read for a verified selected child, preserves source facts, and ends', async () => {
  const f = fixture();
  f.start();
  await f.until((e) => e?.type === 'snapshot');
  f.summary.descendants[0].observation.source = 'prepared';
  f.summary.descendants[0].running = null;
  f.summary.descendants[0].activity = 'unknown';
  f.summary.descendants[0].lastReply = 'safe final';
  f.notify('subagent.finished', {
    parentSessionId: 'root',
    childSessionId: 'child',
    lastAssistantMessage: 'PRIVATE',
  });
  f.notify('subagent.finished', {
    parentSessionId: 'root',
    childSessionId: 'child',
    lastAssistantMessage: 'PRIVATE',
  });
  await f.done();
  expect(f.error()).toBeUndefined();
  expect(f.input.terminal).toHaveBeenCalledOnce();
  expect(f.events.at(-1)).toMatchObject({
    type: 'terminal',
    summary: {
      descendants: [
        { observation: { source: 'prepared' }, lastReply: 'safe final' },
      ],
    },
  });
  expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
  expect(f.listeners.size).toBe(0);
});

it.each(['abort', 'failure', 'overflow'])(
  'releases observers promptly on %s while the source read is pending',
  async (cause) => {
    const f = fixture(),
      entered = gate(),
      blocked = gate();
    f.client.nativeSubagentSummary.mockImplementation(async () => {
      entered.resolve();
      return blocked.promise;
    });
    f.start();
    await entered.promise;
    if (cause === 'abort') f.abort.abort();
    if (cause === 'failure')
      for (const fail of f.failures) fail(Error('transport failed'));
    if (cause === 'overflow')
      for (let i = 0; i < 129; i++)
        f.notify('session.status', { sessionId: 'root' });
    await f.done();
    expect(f.error()).toBeDefined();
    expect(f.events).toHaveLength(0);
    expect(f.listeners.size).toBe(0);
    expect(f.failures.size).toBe(0);
    blocked.resolve(f.summary);
  },
);

it('rechecks idle authority at 15s without polling the directory and cancels a blocked writer', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.start();
  await f.until((e) => e?.type === 'snapshot');
  const blocked = gate();
  f.input.send.mockImplementation(async (event, signal) => {
    if (event?.type === 'display') {
      blocked.resolve();
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    }
  });
  f.frame(4, 'ABC');
  await blocked.promise;
  f.input.check.mockRejectedValue(Error('revoked'));
  await vi.advanceTimersByTimeAsync(15_000);
  await f.done();
  expect(f.error()?.message).toBe('revoked');
  expect(f.client.nativeSubagentSummary).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('fails a blocked idle authority check at the read deadline and never publishes its late completion', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    blocked = gate();
  f.start();
  await f.until((e) => e?.type === 'snapshot');
  let authoritySignal;
  f.input.check.mockImplementation(async (signal) => {
    authoritySignal = signal;
    await blocked.promise;
  });
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.listeners.size).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await f.done();
  expect(authoritySignal.aborted).toBe(true);
  expect(f.error()?.message).toBe('NATIVE_FOLLOW_AUTH_TIMEOUT');
  expect(f.listeners.size).toBe(0);
  expect(f.failures.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const sent = f.input.send.mock.calls.length;
  blocked.resolve();
  await Promise.resolve();
  expect(f.input.send).toHaveBeenCalledTimes(sent);
  expect(f.client.nativeSubagentSummary).toHaveBeenCalledOnce();
});
