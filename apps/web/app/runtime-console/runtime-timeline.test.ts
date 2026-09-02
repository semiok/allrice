import { describe, expect, it } from 'vitest';

import {
  aggregateRuntimeTimelineEvents,
  projectRuntimeTimelineEvents,
  type RuntimeTimelineEvent,
} from './runtime-timeline';

function event(
  sequence: number,
  title: string,
  detail: string | null,
  overrides: Partial<RuntimeTimelineEvent> = {},
): RuntimeTimelineEvent {
  return {
    id: `run-1:${sequence}`,
    key: `run-1:${sequence}`,
    runId: 'run-1',
    sequence,
    kind: 'lifecycle',
    status: 'completed',
    title,
    detail,
    occurredAt: `2026-09-02T08:00:0${sequence}.000Z`,
    ...overrides,
  };
}

describe('runtime timeline projection', () => {
  it('keeps the original tool title while merging start and completion', () => {
    const projected = projectRuntimeTimelineEvents([
      event(1, 'workspace.read', null, { key: 'tool:1', kind: 'tool' }),
      event(2, '工具调用完成', '读取完成', {
        key: 'tool:1',
        kind: 'tool',
      }),
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        key: 'tool:1',
        sequence: 1,
        title: 'workspace.read',
        detail: '读取完成',
      }),
    ]);
  });

  it('collapses consecutive skill loads but preserves expandable entries', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'Skill 已加载', 'browser-research'),
      event(2, 'Skill 已加载', 'document-analysis'),
      event(3, 'Rice 正在思考', null, { kind: 'think' }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(
      expect.objectContaining({
        type: 'group',
        title: 'Skill 已加载 · 2 个',
        events: expect.arrayContaining([
          expect.objectContaining({ detail: 'browser-research' }),
          expect.objectContaining({ detail: 'document-analysis' }),
        ]),
      }),
    );
  });

  it('does not merge skill loads across a different event', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'Skill 已加载', 'browser-research'),
      event(2, '工具失败', 'timeout', { kind: 'tool', status: 'failed' }),
      event(3, 'Skill 已加载', 'document-analysis'),
    ]);

    expect(items.map((item) => item.type)).toEqual(['event', 'event', 'event']);
  });

  it('collapses adjacent context preparation variants', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, '上下文注入', '准备租户上下文', { kind: 'context' }),
      event(2, '上下文已注入', '上下文已就绪', { kind: 'context' }),
    ]);

    expect(items[0]).toEqual(
      expect.objectContaining({
        type: 'group',
        title: '上下文准备 · 2 项',
      }),
    );
  });

  it('collapses consecutive calls to the same tool', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'local.fs.list', '第一次完成', { kind: 'tool' }),
      event(2, 'local.fs.list', '第二次完成', { kind: 'tool' }),
      event(3, 'local.fs.list', '第三次完成', { kind: 'tool' }),
      event(4, '思考完成', null, { kind: 'think' }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(
      expect.objectContaining({
        type: 'group',
        title: 'local.fs.list · 连续调用 3 次',
        events: expect.arrayContaining([
          expect.objectContaining({ detail: '第一次完成' }),
          expect.objectContaining({ detail: '第三次完成' }),
        ]),
      }),
    );
  });

  it('keeps different tools in separate timeline positions', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'local.fs.list', '第一次完成', { kind: 'tool' }),
      event(2, 'local.fs.read', '读取完成', { kind: 'tool' }),
      event(3, 'local.fs.list', '第二次完成', { kind: 'tool' }),
    ]);

    expect(items.map((item) => item.type)).toEqual(['event', 'event', 'event']);
  });
});
