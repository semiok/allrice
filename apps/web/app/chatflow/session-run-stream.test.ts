import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { History } from './chatflow-types';
import { createSessionRunStream } from './session-run-stream';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
function history(
  sessionId: string,
  runId: string,
  status: 'pending' | 'completed',
): History {
  return {
    session: {
      id: sessionId,
      title: sessionId,
      employeeAssignmentId: 'employee',
      employeeVersionId: 'version',
      visibility: 'private',
      updatedAt: '',
      archivedAt: null,
    },
    messages: [
      {
        id: `message-${runId}`,
        role: 'assistant',
        content: { text: '' },
        status,
        runId,
        createdAt: '',
      },
    ],
    contextStatus: {
      percentage: 0,
      pressureTokens: 0,
      thresholdTokens: 40_000,
      compactionDue: false,
    },
    nativeContextStatus: null,
  };
}
function event(
  runId: string,
  sequence = 1,
  type: ChatFlowEventEnvelope['type'] = 'harness.native',
): ChatFlowEventEnvelope {
  return {
    schemaVersion: 3,
    eventId: `${runId}-${sequence}`,
    organizationId: 'organization',
    workspaceId: 'workspace',
    conversationId: null,
    runId,
    generation: 1,
    cursor: `${runId}:${sequence}`,
    sequence,
    harness: 'dsh',
    type,
    occurredAt: '2026-09-14T00:00:00.000Z',
    sourceEvent: null,
    payload: {},
  };
}

describe('P26 selected Session transport lifetime (synthetic HTTP, no provider)', () => {
  let requests: Array<{
    url: string;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<Response>>;
  }>;
  let streams: Array<ReturnType<typeof createSessionRunStream>>;
  let bodies: Array<ReadableStreamDefaultController<Uint8Array>>;
  const loadHistory = vi.fn<(sessionId: string) => Promise<void>>(
    async () => {},
  );
  const loadWorkspace = vi.fn(async () => undefined);
  const setError = vi.fn();
  function select(sessionId: string | null) {
    const stream = createSessionRunStream({
      sessionId,
      workspaceId: 'workspace',
      tenantHeaders: {},
      loadHistory,
      loadWorkspace,
      setError,
    });
    streams.push(stream);
    stream.activate();
    return stream;
  }
  function open(index: number) {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
    bodies.push(body);
    requests[index]!.result.resolve(response);
    return {
      send(value: ChatFlowEventEnvelope) {
        body.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
        );
      },
      close() {
        body.close();
      },
    };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    requests = [];
    streams = [];
    bodies = [];
    // Deliberately ignores AbortSignal: stale fetch/read/json can still resolve.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        const result = deferred<Response>();
        requests.push({ url, signal: init.signal as AbortSignal, result });
        return result.promise;
      }),
    );
  });
  afterEach(async () => {
    for (const stream of streams) stream.deactivate();
    for (const body of bodies) {
      try {
        body.close();
      } catch {
        /* already closed */
      }
    }
    for (const request of requests)
      request.result.resolve(Response.json({ events: [] }));
    await flush();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('never rebuilds queued Codex from stale History while Gemini History is still loading', async () => {
    const codexHistory = history('codex', 'queued', 'pending');
    const codex = select('codex');
    codex.restoreHistory(codexHistory);
    const body = open(0);
    await flush();
    expect(codex.getSnapshot().runViews.queued?.status).toBe('running');
    codex.deactivate();
    const gemini = select('gemini');
    expect(gemini.getSnapshot().runViews).toEqual({});
    gemini.restoreHistory(codexHistory);
    await codex.streamRun('late-post', 'codex');
    await gemini.streamRun('queued', 'codex');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    body.send(event('queued', 1, 'run.succeeded'));
    body.close();
    await flush();
    expect(gemini.getSnapshot()).toEqual({ runViews: {}, runTraces: {} });
    expect(loadHistory).not.toHaveBeenCalled();
    expect(loadWorkspace).not.toHaveBeenCalled();
    gemini.restoreHistory(history('gemini', 'completed', 'completed'));
    expect(requests[1]!.url).toContain('completed/events');
    expect(requests[1]!.url).toContain('format=json');
    requests[1]!.result.resolve(
      Response.json({ events: [event('completed', 1, 'run.succeeded')] }),
    );
    await flush();
    expect(gemini.getSnapshot().runTraces.completed?.status).toBe('loaded');
    expect(gemini.getSnapshot().runViews).toEqual({}); // no stop-this-turn state
  });
  it('A→B→A resumes only the returned pending Run, never callbacks from the old lifetime', async () => {
    const first = select('codex');
    first.restoreHistory(history('codex', 'queued', 'pending'));
    first.deactivate();
    const middle = select('gemini');
    middle.restoreHistory(history('codex', 'queued', 'pending'));
    middle.deactivate();
    const returned = select('codex');
    returned.restoreHistory(history('gemini', 'done', 'completed'));
    expect(requests).toHaveLength(1);
    returned.restoreHistory(history('codex', 'queued', 'pending'));
    expect(requests).toHaveLength(2);
    requests[0]!.result.resolve(new Response(null, { status: 503 }));
    await flush();
    await first.recoverRun('queued');
    await first.streamRun('late-post');
    expect(requests).toHaveLength(2);
    const body = open(1);
    await flush();
    body.send(event('queued'));
    await flush();
    expect(returned.getSnapshot().runViews.queued?.events).toHaveLength(1);
    expect(requests[1]!.signal.aborted).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });
  it('keeps same-session live streaming and dedupes repeated History refreshes', async () => {
    const active = select('active');
    const pending = history('active', 'live', 'pending');
    active.restoreHistory(pending);
    const body = open(0);
    await flush();
    body.send(event('live'));
    await flush();
    active.restoreHistory({ ...pending, messages: [...pending.messages] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    body.send(event('live', 2, 'run.succeeded'));
    body.close();
    await flush();
    expect(active.getSnapshot().runViews.live?.status).toBe('completed');
    expect(active.getSnapshot().runTraces.live?.events).toHaveLength(2);
    expect(loadHistory).toHaveBeenCalledWith('active');
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    active.restoreHistory(pending);
    expect(requests).toHaveLength(1);
  });
  it('ignores a resolved fetch arriving in the same tick as reset', async () => {
    const active = select('active');
    const old = active.streamRun('run');
    open(0);
    active.resetRunState();
    await old;
    expect(active.getSnapshot()).toEqual({ runViews: {}, runTraces: {} });
    expect(loadHistory).not.toHaveBeenCalled();
  });
  it('old SSE reader/finally cannot delete the same Run newly started after reset', async () => {
    const active = select('active');
    const old = active.streamRun('same');
    const oldBody = open(0);
    await flush();
    active.resetRunState();
    const newer = active.streamRun('same');
    const newBody = open(1);
    await flush();
    oldBody.send(event('same', 99, 'run.succeeded'));
    oldBody.close();
    await old;
    await active.streamRun('same');
    expect(requests).toHaveLength(2);
    expect(active.getSnapshot().runViews.same?.events).toEqual([]);
    newBody.send(event('same', 1, 'run.succeeded'));
    newBody.close();
    await newer;
    expect(
      active.getSnapshot().runViews.same?.events.map((item) => item.sequence),
    ).toEqual([1]);
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
  it('old JSON trace/finally cannot overwrite or unlock the newer trace', async () => {
    const active = select('active');
    const old = active.loadRunTrace('same');
    const oldJson = deferred<{ events: ChatFlowEventEnvelope[] }>();
    requests[0]!.result.resolve({
      ok: true,
      status: 200,
      json: () => oldJson.promise,
    } as Response);
    await flush();
    active.resetRunState();
    const newer = active.loadRunTrace('same');
    oldJson.resolve({ events: [event('same', 99)] });
    await old;
    await active.loadRunTrace('same');
    expect(requests).toHaveLength(2);
    expect(active.getSnapshot().runTraces.same).toEqual({
      status: 'loading',
      events: [],
    });
    requests[1]!.result.resolve(Response.json({ events: [event('same', 1)] }));
    await newer;
    expect(
      active.getSnapshot().runTraces.same?.events.map((item) => item.sequence),
    ).toEqual([1]);
  });
  it('Strict Mode deactivate/reactivate invalidates old SSE and trace generations', async () => {
    const active = select('active');
    const pending = history('active', 'same', 'pending');
    active.restoreHistory(pending);
    const oldTrace = active.loadRunTrace('trace');
    active.deactivate();
    active.activate();
    active.restoreHistory(pending);
    const newTrace = active.loadRunTrace('trace');
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(true);
    requests[0]!.result.reject(new Error('old SSE'));
    requests[1]!.result.reject(new Error('old trace'));
    await oldTrace;
    await flush();
    active.restoreHistory(pending);
    await active.loadRunTrace('trace');
    expect(requests).toHaveLength(4);
    expect(active.getSnapshot().runViews.same?.status).toBe('connecting');
    requests[3]!.result.resolve(Response.json({ events: [] }));
    await newTrace;
    expect(active.getSnapshot().runTraces.trace?.status).toBe('loaded');
    expect(setError).not.toHaveBeenCalled();
  });
  it('does not reconnect after selection aborts a retry delay', async () => {
    const active = select('active');
    const running = active.streamRun('run');
    requests[0]!.result.reject(new Error('offline'));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    active.deactivate();
    await running;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves current-session reconnects and last-event-id', async () => {
    const active = select('active');
    const running = active.streamRun('run');
    const first = open(0);
    await flush();
    first.send(event('run'));
    first.close();
    await flush();
    await vi.advanceTimersByTimeAsync(600);
    expect(requests).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls[1]![1]?.headers).toEqual({
      'last-event-id': 'run:1',
    });
    const second = open(1);
    await flush();
    second.send(event('run', 2, 'run.succeeded'));
    second.close();
    await running;
    expect(active.getSnapshot().runViews.run?.events).toHaveLength(2);
  });
  it('skips Workspace refresh when selection changes during terminal History loading', async () => {
    const deferredHistory = deferred<void>();
    loadHistory.mockImplementationOnce(() => deferredHistory.promise);
    const active = select('active');
    const running = active.streamRun('run');
    const body = open(0);
    await flush();
    body.send(event('run', 1, 'run.succeeded'));
    body.close();
    await flush();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    active.deactivate();
    deferredHistory.resolve();
    await running;
    expect(loadWorkspace).not.toHaveBeenCalled();
  });
  it('New Session inherits no old History transport', async () => {
    const blank = select(null);
    blank.restoreHistory(history('old', 'pending', 'pending'));
    await blank.streamRun('pending');
    await blank.loadRunTrace('trace');
    await blank.recoverRun('pending');
    expect(requests).toHaveLength(0);
    expect(blank.getSnapshot()).toEqual({ runViews: {}, runTraces: {} });
  });
});
