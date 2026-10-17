import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { ModelCallTimingSchema } from '@allrice/contracts';
import { createModelTiming } from './allrice-model-timing.mjs';

function fixture(emit) {
  const events = [];
  const timing = createModelTiming({
    startedMono: performance.now(),
    startedAt: new Date().toISOString(),
    preparationMs: 2,
    ledgerPreparationMs: 1,
    emit: emit ?? ((event) => events.push(event)),
  });
  return { events, timing };
}
describe('bounded model timing metadata', () => {
  it('keeps prepared, framing, reasoning, answer and final times separate, without content', () => {
    const { events, timing } = fixture();
    timing.prepared();
    timing.dispatched(
      {
        timing: () => ({
          transport: 'websocket',
          requestCount: 0,
          websocketRequests: 1,
          requestsTruncated: false,
          httpRequests: [],
        }),
      },
      { serializationMs: 1, admissionMs: 2, inputBytes: 100, toolCount: 2 },
    );
    timing.chunk({ type: 'block-start', blockType: 'text' }, false);
    timing.chunk({ type: 'reasoning-delta', text: 'PRIVATE_THOUGHT' }, true);
    timing.chunk({ type: 'text-delta', text: 'PRIVATE_ANSWER' }, true);
    timing.finished({
      failed: false,
      stopKind: 'stop',
      settlementMs: 2,
      settlementConfirmed: true,
    });
    expect(events.map((x) => x.phase)).toEqual([
      'prepared',
      'first_content',
      'completed',
    ]);
    for (const event of events)
      expect(ModelCallTimingSchema.safeParse(event).success).toBe(true);
    expect(events[1]).toMatchObject({
      firstChunkMs: expect.any(Number),
      firstContentMs: expect.any(Number),
      firstReasoningMs: expect.any(Number),
      firstTextMs: null,
    });
    expect(events[2].firstTextMs).toEqual(expect.any(Number));
    expect(events[2]).toMatchObject({
      authorizationReadMs: null,
      transport: 'websocket',
      httpRequests: [],
    });
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|prompt|authorization:|Bearer/,
    );
  });
  it('does not log heartbeats/notices repeatedly or treat empty framing as content', () => {
    const { events, timing } = fixture();
    timing.prepared();
    for (let i = 0; i < 1000; i++) {
      timing.wait();
      timing.chunk({ type: 'block-start', blockType: 'text' }, false);
    }
    timing.finished({
      failed: true,
      stopKind: 'error',
      settlementMs: 1,
      settlementConfirmed: false,
    });
    expect(events.map((x) => x.phase)).toEqual([
      'prepared',
      'waiting',
      'failed',
    ]);
    expect(events.at(-1).firstContentMs).toBeNull();
  });
  it('cannot turn a throwing/rejected logger into a model failure or a retry', async () => {
    const emit = vi.fn(() => {
      throw Error('logger unavailable');
    });
    const { timing } = fixture(emit);
    expect(() => {
      timing.prepared();
      timing.wait();
      timing.chunk({ type: 'text-delta' }, true);
      timing.finished({
        failed: false,
        stopKind: 'stop',
        settlementMs: 0,
        settlementConfirmed: true,
      });
    }).not.toThrow();
    const rejected = fixture(() => Promise.reject(Error('logger unavailable')));
    rejected.timing.prepared();
    await Promise.resolve();
  });
  it('strict operator schema rejects payload/URL/headers and fabricated credential timing', () => {
    const { events, timing } = fixture();
    timing.prepared();
    const event = events[0];
    for (const extra of [
      { prompt: 'private' },
      { url: 'private' },
      { headers: {} },
      { authorizationReadMs: 0 },
    ])
      expect(
        ModelCallTimingSchema.safeParse({ ...event, ...extra }).success,
      ).toBe(false);
  });
});
