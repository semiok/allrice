import { describe, expect, it } from 'vitest';
import type { NativeExperienceItem } from './native-experience';
import { summarizeWorkProcess } from './work-process';

function call(
  id: number,
  overrides: Partial<NativeExperienceItem> = {},
): NativeExperienceItem {
  return {
    id: String(id),
    sequence: id,
    kind: 'tool',
    status: 'completed',
    title: 'market.quote',
    toolName: 'market.quote',
    startedAt: '2026-09-24T00:00:00Z',
    finishedAt: '2026-09-24T00:00:02Z',
    ...overrides,
  };
}
describe('compact public work process', () => {
  it('counts calls, translates and groups same operations, labels overlapping time as a sum', () => {
    const state = summarizeWorkProcess([
      ...Array.from({ length: 9 }, (_, i) => call(i)),
      call(10, { toolName: 'workspace.export.create' }),
    ]);
    expect(state.total).toBe(10);
    expect(state.groups).toHaveLength(2);
    expect(state.groups[0]).toMatchObject({
      label: '查询实时行情',
      count: 9,
      completed: 9,
      durationMs: 18000,
    });
    expect(state.groups[1]?.label).toBe('生成交付成果');
  });
  it('keeps failure receipts, unknown durations and suspended questions distinct from success', () => {
    const state = summarizeWorkProcess([
      call(1, { status: 'failed', detail: '服务超时', startedAt: undefined }),
      call(2, { status: 'started', finishedAt: undefined }),
      call(3, {
        status: 'info',
        toolName: 'ask_user_question',
        finishedAt: undefined,
      }),
    ]);
    expect(state.groups[0]).toMatchObject({
      count: 2,
      failed: 1,
      pending: 1,
      completed: 0,
      errors: ['服务超时'],
      durationMs: null,
    });
    expect(state.groups[1]).toMatchObject({
      waiting: 1,
      failed: 0,
      completed: 0,
    });
    expect(state.active).toBe('查询实时行情');
  });
  it('does not mix reasoning or compaction events into tool invocation totals', () => {
    const state = summarizeWorkProcess([
      call(1, { kind: 'think' }),
      call(2, { kind: 'compaction' }),
    ]);
    expect(state.total).toBe(0);
    expect(state.hasThinking).toBe(true);
    expect(state.hasCompaction).toBe(true);
  });
});
