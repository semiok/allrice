import { describe, expect, it } from 'vitest';

import {
  runtimeTraceSummary,
  summarizeRuntimeEvents,
} from './runtime-events.ts';

describe('runtime event presentation', () => {
  it('keeps only the latest state for a tool and workflow step', () => {
    const summary = summarizeRuntimeEvents([
      {
        eventId: '1',
        sequence: 1,
        type: 'tool.started',
        payload: { toolCallId: 'tool-1' },
      },
      {
        eventId: '2',
        sequence: 2,
        type: 'step.started',
        payload: { stepKey: 'research' },
      },
      {
        eventId: '3',
        sequence: 3,
        type: 'tool.completed',
        payload: { toolCallId: 'tool-1' },
      },
      {
        eventId: '4',
        sequence: 4,
        type: 'step.completed',
        payload: { stepKey: 'research' },
      },
    ]);
    expect(summary).toMatchObject({ steps: 1, tools: 1, retries: 0 });
    expect(summary.events.map((event) => event.eventId)).toEqual(['3', '4']);
    expect(runtimeTraceSummary(summary)).toBe(
      '执行记录 · 1 个步骤 · 1 个工具调用',
    );
  });
});
