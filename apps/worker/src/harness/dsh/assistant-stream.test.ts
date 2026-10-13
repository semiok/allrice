import { describe, expect, it } from 'vitest';
import { DshAssistantStream } from './assistant-stream.js';
import { sourceMetadata } from './event-projector.js';

const start = (revision = 1, attemptId = 'session:1') => ({
  type: 'start',
  attemptId,
  revision,
  turn: 2,
  step: 3,
});
const chunk = (revision = 2, index = 0, attemptId = 'session:1') => ({
  type: 'chunk',
  attemptId,
  revision,
  index,
  time: 1000,
  chunk: { type: 'text-delta', index: 0, text: 'first' },
});

describe('native DSH transient assistant frames', () => {
  it('rejects orphan, duplicate, stale and foreign-attempt chunks', () => {
    const stream = new DshAssistantStream();
    expect(stream.accept(chunk())).toBeNull();
    stream.accept(start());
    expect(stream.accept(chunk())).toMatchObject({
      type: 'assistant/live-chunk',
      data: { turn: 2, step: 3 },
    });
    expect(stream.accept(chunk())).toBeNull();
    expect(stream.accept(chunk(3, 1, 'other'))).toBeNull();
    expect(stream.accept(chunk(3, 2))).toBeNull();
    expect(stream.accept(chunk(3, 1))).not.toBeNull();
    expect(stream.accept(start(4))).toBeNull();
  });

  it('retires attempts on end and rejects late chunks after settlement', () => {
    const stream = new DshAssistantStream();
    stream.accept(start());
    stream.accept(chunk());
    expect(
      stream.accept({
        type: 'end',
        attemptId: 'session:1',
        revision: 3,
        index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 9 },
      }),
    ).toMatchObject({ type: 'assistant/live-end' });
    expect(stream.accept(chunk(4, 1))).toBeNull();
    expect(stream.accept(start(5, 'session:2'))).not.toBeNull();
    expect(stream.accept(chunk(6, 0, 'session:2'))).not.toBeNull();
    expect(stream.accept(chunk(7, 1, 'session:1'))).toBeNull();
  });

  it('retains live provenance without copying text, reasoning or tool arguments into source metadata', () => {
    const stream = new DshAssistantStream();
    stream.accept(start());
    const event = stream.accept({
      ...chunk(),
      chunk: {
        type: 'reasoning-delta',
        index: 0,
        text: 'private reasoning',
        argumentsDelta: 'secret',
      },
    })!;
    const metadata = sourceMetadata(event);
    expect(metadata.sourceEventId).toBe('dsh:live:session:1:2');
    expect(metadata.sourceOccurredAt).toBe('1970-01-01T00:00:01.000Z');
    expect(metadata.sourcePayload).toEqual({
      turn: 2,
      step: 3,
      chunk: { type: 'reasoning-delta', index: 0 },
    });
    expect(JSON.stringify(metadata)).not.toMatch(/private reasoning|secret/);
  });
});
