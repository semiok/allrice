import { describe, expect, it } from 'vitest';

import {
  assistantStreamText,
  type AssistantStreamEvent,
} from './assistant-stream';

function event(
  eventId: string,
  sequence: number,
  type: string,
  text: string,
  generation = 1,
  attempt = 1,
): AssistantStreamEvent {
  return {
    eventId,
    sequence,
    type,
    payload: { text, generation, attempt },
  };
}

describe('assistantStreamText', () => {
  it('orders and deduplicates replayed deltas', () => {
    const first = event('a', 2, 'assistant.text.delta', '你');
    expect(
      assistantStreamText(
        [event('b', 3, 'assistant.text.delta', '好'), first, first],
        '等待中',
      ),
    ).toBe('你好');
  });

  it('isolates stale attempts and lets completed text calibrate the result', () => {
    expect(
      assistantStreamText(
        [
          event('old', 2, 'assistant.text.delta', '旧', 1, 1),
          event('new', 4, 'assistant.text.delta', '新', 1, 2),
          event('done', 5, 'assistant.text.completed', '最终答案', 1, 2),
        ],
        '等待中',
      ),
    ).toBe('最终答案');
  });
});
