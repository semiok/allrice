import { describe, expect, it } from 'vitest';

import type { HarnessEvent } from '@allrice/contracts';

import { HarnessEventBatcher } from './delta-batcher.js';

const messageId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';

function delta(
  order: number,
  text: string,
): Extract<HarnessEvent, { type: 'assistant.delta' }> {
  return {
    schemaVersion: 1,
    harness: 'codex',
    generation: 1,
    attempt: 1,
    order,
    threadId: 'thread-1',
    turnId: 'turn-1',
    sessionId,
    messageId,
    type: 'assistant.delta',
    text,
  };
}

describe('HarnessEventBatcher', () => {
  it('combines token-sized deltas and preserves their order range', async () => {
    const written: HarnessEvent[] = [];
    const batcher = new HarnessEventBatcher(
      async (event) => {
        written.push(event);
      },
      1_000,
      2,
    );
    await batcher.accept(delta(1, '你'));
    await batcher.accept(delta(2, '好'));
    await batcher.close();
    expect(written).toEqual([
      expect.objectContaining({
        type: 'assistant.delta',
        text: '你好',
        orderStart: 1,
        order: 2,
      }),
    ]);
  });

  it('never joins different replies, snapshots, or attempts', async () => {
    const written: HarnessEvent[] = [];
    const batcher = new HarnessEventBatcher(async (event) => {
      written.push(event);
    });
    await batcher.accept({
      ...delta(1, 'first'),
      type: 'assistant.delta',
      replyId: 'a',
    });
    await batcher.accept({
      ...delta(2, 'second'),
      type: 'assistant.delta',
      replyId: 'b',
    });
    await batcher.accept({
      ...delta(3, 'settled'),
      type: 'assistant.delta',
      replyId: 'b',
      textMode: 'replace',
    });
    await batcher.accept({
      ...delta(4, 'retry'),
      type: 'assistant.delta',
      replyId: 'b',
      attempt: 2,
    });
    await batcher.close();
    expect(written.map((e) => ('text' in e ? e.text : ''))).toEqual([
      'first',
      'second',
      'settled',
      'retry',
    ]);
    expect(written[2]).toMatchObject({ textMode: 'replace', replyId: 'b' });
  });

  it('flushes text before a following tool event', async () => {
    const written: HarnessEvent[] = [];
    const batcher = new HarnessEventBatcher(async (event) => {
      written.push(event);
    });
    await batcher.accept(delta(1, '先'));
    await batcher.accept({
      ...delta(2, ''),
      type: 'tool.started',
      toolCallId: 'tool-1',
      name: 'web.search',
      label: '联网搜索',
      source: 'harness',
    });
    await batcher.close();
    expect(written.map((event) => event.type)).toEqual([
      'assistant.delta',
      'tool.started',
    ]);
  });
});
