/* global AbortController */
import { describe, it, expect, vi } from 'vitest';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import {
  initialProgressState,
  observeProgress,
} from '../../../../packages/database/src/task-progress-policy.ts';
import {
  installTaskProgress,
  progressDigest,
  progressResult,
} from '../../dsh/allrice-task-progress.mjs';

function fixture() {
  const hooks = new Map();
  const root = { id: 'root', steer: vi.fn() },
    child = { id: 'child', session: { header: { parentSession: 'root' } } };
  const ctx = {
    on: (name, fn) => hooks.set(name, fn),
    agents: {
      get: (id) => (id === 'root' ? root : id === 'child' ? child : null),
      roots: () => [root],
    },
    userQuestions: {
      ask: vi.fn(async () => ({
        answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
      })),
    },
  };
  let paused = false;
  const bridge = vi.fn(async (p) => {
    if (p.action === 'start' && paused) throw Error('task_progress_paused');
    if (p.action === 'decide') paused = false;
    return {
      paused,
      pauseId: paused ? 'one' : null,
      reason: paused ? 'repeated_failure' : null,
      recent: [{ tool: 'web.fetch', outcome: 'error' }],
    };
  });
  const runtime = installTaskProgress(ctx, bridge);
  return {
    ctx,
    hooks,
    root,
    child,
    bridge,
    runtime,
    pause: () => {
      paused = true;
    },
  };
}
describe('native progress middleware', () => {
  it('flushes the third queued failure before compaction model admission without asking a question', async () => {
    const f = fixture();
    let state = initialProgressState();
    const starts = new Map();
    let releaseReceipt;
    const receipt = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    let receiptStarted;
    const writing = new Promise((resolve) => {
      receiptStarted = resolve;
    });
    f.bridge.mockImplementation(async (p) => {
      if (p.action === 'start') {
        if (state.reason) throw Error('task_progress_paused');
        starts.set(p.callId, p);
      }
      if (p.action === 'finish' && p.kind === 'tool') {
        if (p.callId === '3') {
          receiptStarted();
          await receipt;
        }
        state = observeProgress(state, {
          ...starts.get(p.callId),
          ...p,
        });
      }
      return { paused: !!state.reason, reason: state.reason };
    });
    const emit = f.hooks.get('session/event');
    for (const callId of ['1', '2', '3']) {
      emit(f.root, {
        type: 'tool/call',
        data: { callId, name: 'read', arguments: { path: 'missing' } },
      });
      emit(f.root, {
        type: 'tool/result',
        data: {
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: callId,
                isError: true,
                content: [{ type: 'text', text: 'missing file' }],
              },
            ],
          },
        },
      });
    }
    await writing;
    expect(state.history).toHaveLength(2);
    expect(state.reason).toBeNull();
    const next = vi.fn(async function* () {
      yield { type: 'text', text: 'must not run' };
    });
    const compacting = Array.fromAsync(
      f.hooks.get('llm/stream')(
        { sessionId: f.root.id, purpose: 'compaction' },
        next,
      ),
    );
    const rejected = expect(compacting).rejects.toThrow('task_progress_paused');
    releaseReceipt();
    await rejected;
    expect(state.reason).toBe('repeated_failure');
    expect(next).not.toHaveBeenCalled();
    expect(f.ctx.userQuestions.ask).not.toHaveBeenCalled();
    expect(f.bridge.mock.calls.some(([p]) => p.action === 'check')).toBe(false);
  });
  it('lets upstream automatic compaction fail admission without a card, then asks once and continues', async () => {
    const f = fixture();
    f.pause();
    const next = vi.fn(async function* () {
      yield { type: 'text', text: 'done' };
    });
    // The real upstream hook catches compaction errors before normal streaming.
    const hooks = new Map();
    BasicCompactionEngine.prototype._registerAutomaticCompaction.call({
      ctx: {
        on: (name, fn) => hooks.set(name, fn),
        logger: { warn: vi.fn(), info: vi.fn() },
      },
      warnedPressureConfigTargets: new Set(),
      compactIfNeeded: () =>
        Array.fromAsync(
          f.hooks.get('llm/stream')(
            { sessionId: f.root.id, purpose: 'compaction' },
            next,
          ),
        ),
    });
    const normal = () =>
      Array.fromAsync(
        f.hooks.get('llm/stream')({ sessionId: f.root.id }, next),
      );
    await hooks.get('agent/pre-step')(
      { agent: f.root, signal: new AbortController().signal },
      normal,
    );
    expect(f.ctx.userQuestions.ask).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(
      f.bridge.mock.calls.filter(([p]) => p.action === 'decide'),
    ).toHaveLength(1);
  });
  it.each(['current', 'historical'])(
    'does not settle a %s tool again when native pruning replaces its history',
    async (scope) => {
      const f = fixture(),
        emit = f.hooks.get('session/event');
      const result = {
        type: 'tool/result',
        surfaceOp: 'append',
        data: {
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: 'large-result',
                content: [{ type: 'text', text: 'original tool output' }],
              },
            ],
          },
        },
      };
      if (scope === 'current') {
        emit(f.root, {
          type: 'tool/call',
          data: {
            callId: 'large-result',
            name: 'web_fetch',
            arguments: '{}',
          },
        });
        emit(f.root, result);
        await f.runtime.flush();
      }
      const originalReceipts = f.bridge.mock.calls.length;
      emit(f.root, { type: 'compaction/prune', data: { shadowedSeqs: [12] } });
      emit(f.root, {
        ...result,
        surfaceOp: { op: 'replace', startSeq: 12, endSeq: 12 },
        sourceEventSeqs: [12],
        data: {
          message: {
            content: [
              {
                type: 'tool-result',
                toolCallId: 'large-result',
                content: [
                  { type: 'text', text: '[... tool result middle pruned ...]' },
                ],
              },
            ],
          },
        },
      });
      await f.runtime.flush();
      expect(f.bridge).toHaveBeenCalledTimes(originalReceipts);
      const next = vi.fn(async () => ({ maxTokens: 16_000 }));
      await f.hooks.get('agent/request')({ agent: f.root }, next);
      expect(next).toHaveBeenCalledOnce();
      expect(f.ctx.userQuestions.ask).not.toHaveBeenCalled();
    },
  );
  it('normalizes keys and transport noise, retaining business input', () => {
    expect(progressDigest({ b: 1, a: 'path', timestamp: '1' })).toBe(
      progressDigest({ a: 'path', timestamp: '2', b: 1 }),
    );
    expect(progressDigest({ query: 'date1' })).not.toBe(
      progressDigest({ query: 'date2' }),
    );
    expect(progressDigest('[2026-09-23T01:00:00Z] failed duration: 20ms')).toBe(
      progressDigest('[2026-09-23T01:02:00Z] failed duration: 43ms'),
    );
    expect(
      progressResult('fetch', {
        isError: true,
        content: [{ type: 'text', text: '{"code":"429"}' }],
      }).outcome,
    ).toBe('retry');
    expect(
      progressResult('read', { content: [{ type: 'text', text: '[]' }] })
        .outcome,
    ).toBe('empty');
  });
  it('records 100 actual native request lifecycles without a 16/64/80 cutoff', async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) {
      const output = [];
      for await (const c of f.hooks.get('llm/stream')(
        { sessionId: 'root' },
        async function* () {
          yield { type: 'text', text: 'ok' };
        },
      ))
        output.push(c);
      expect(output).toHaveLength(1);
    }
    expect(
      f.bridge.mock.calls.filter(
        ([p]) => p.action === 'start' && p.kind === 'model',
      ),
    ).toHaveLength(100);
    expect(
      f.bridge.mock.calls.filter(([p]) => p.action === 'finish'),
    ).toHaveLength(100);
    expect(f.ctx.userQuestions.ask).not.toHaveBeenCalled();
  });
  it('routes a child pause through its live root and resumes only after an actual answer', async () => {
    const f = fixture();
    f.pause();
    let answer;
    f.ctx.userQuestions.ask.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const next = vi.fn(async function* () {
      yield { type: 'text', text: 'ok' };
    });
    const pending = Array.fromAsync(
      f.hooks.get('llm/stream')({ sessionId: f.child.id }, next),
    );
    await vi.waitFor(() => expect(f.ctx.userQuestions.ask).toHaveBeenCalled());
    expect(next).not.toHaveBeenCalled();
    expect(f.ctx.userQuestions.ask.mock.calls[0][0].agent).toBe(f.root);
    answer({
      answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
    });
    await pending;
    expect(next).toHaveBeenCalledOnce();
    expect(f.bridge).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'decide', decision: 'continue' }),
      undefined,
    );
  });
  // MET-210: a skipped item ({ selected: [] }) does not agree to continue.
  it.each([[['取消任务']], [[]]])(
    'cancel (selected %j) never dispatches the next model and leaves a cancellation decision',
    async (selected) => {
      const f = fixture();
      f.pause();
      f.ctx.userQuestions.ask.mockResolvedValue({
        answers: [{ id: 'runtime-progress', selected }],
      });
      const next = vi.fn();
      await expect(
        Array.fromAsync(
          f.hooks.get('llm/stream')({ sessionId: f.root.id }, next),
        ),
      ).rejects.toThrow('task_progress_canceled');
      expect(next).not.toHaveBeenCalled();
      expect(f.bridge).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'cancel' }),
        undefined,
      );
    },
  );
  it('flushes hashed tool receipts before the next request without forwarding raw content', async () => {
    const f = fixture(),
      emit = f.hooks.get('session/event');
    emit(f.root, {
      type: 'tool/call',
      data: {
        callId: '1',
        name: 'web_fetch',
        arguments: '{"url":"secret-url"}',
      },
    });
    emit(f.root, {
      type: 'tool/result',
      data: {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: '1',
              isError: true,
              content: [{ type: 'text', text: 'private output' }],
            },
          ],
        },
      },
    });
    await f.runtime.flush();
    expect(f.bridge.mock.calls.map(([p]) => p.action)).toEqual([
      'start',
      'finish',
    ]);
    expect(JSON.stringify(f.bridge.mock.calls)).not.toContain('secret-url');
    expect(JSON.stringify(f.bridge.mock.calls)).not.toContain('private output');
  });
});
