import { describe, it, expect, vi } from 'vitest';
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
    const next = vi.fn(async () => ({ maxTokens: 10 }));
    const pending = f.hooks.get('agent/request')({ agent: f.child }, next);
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
  it('cancel never dispatches the next model and leaves a cancellation decision', async () => {
    const f = fixture();
    f.pause();
    f.ctx.userQuestions.ask.mockResolvedValue({
      answers: [{ id: 'runtime-progress', selected: ['取消任务'] }],
    });
    const next = vi.fn();
    await expect(
      f.hooks.get('agent/request')({ agent: f.root }, next),
    ).rejects.toThrow('task_progress_canceled');
    expect(next).not.toHaveBeenCalled();
    expect(f.bridge).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'cancel' }),
      undefined,
    );
  });
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
