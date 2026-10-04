import { describe, expect, it } from 'vitest';

import {
  aggregateRuntimeTimelineEvents,
  projectRuntimeTimelineEvents,
  runtimeTimelineCategory,
  runtimeTimelineStatus,
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

  it('groups the full context maintenance sequence without losing its records', () => {
    const events = [
      event(1, '上下文占用', '48%', { kind: 'context', status: 'info' }),
      event(2, '工具结果已精简', '结果摘要', { kind: 'compaction' }),
      event(3, '上下文占用', '51%', { kind: 'context', status: 'info' }),
      event(4, '正在整理上下文', null, {
        kind: 'compaction',
        status: 'started',
      }),
      event(5, '上下文占用', '51%', { kind: 'context', status: 'info' }),
      event(6, '上下文摘要已生成', null, {
        kind: 'compaction',
        status: 'updated',
      }),
      event(7, '上下文已整理', null, { kind: 'compaction' }),
    ];
    const items = aggregateRuntimeTimelineEvents(events);

    expect(items).toEqual([
      expect.objectContaining({
        type: 'group',
        kind: 'compaction',
        title: '上下文整理 · 7 条记录',
        status: 'completed',
        occurredAt: events[6]!.occurredAt,
        events,
      }),
    ]);
  });

  it('keeps preparation, maintenance and tools in chronological stages', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, '上下文注入', '准备租户上下文', { kind: 'context' }),
      event(2, '上下文已注入', '上下文已就绪', { kind: 'context' }),
      event(3, '上下文占用', null, { kind: 'context', status: 'info' }),
      event(4, '正在整理上下文', null, {
        kind: 'compaction',
        status: 'started',
      }),
      event(5, 'cloud.mcp.call', null, { kind: 'tool' }),
      event(6, '上下文占用', null, { kind: 'context', status: 'info' }),
      event(7, '上下文已整理', null, { kind: 'compaction' }),
    ]);

    expect(
      items.map((item) =>
        item.type === 'group' ? item.title : item.event.title,
      ),
    ).toEqual([
      '上下文准备 · 2 项',
      '上下文整理 · 2 条记录',
      'cloud.mcp.call',
      '上下文整理 · 2 条记录',
    ]);
  });

  it('does not imply compaction when only occupancy snapshots were recorded', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, '上下文占用', '48%', { kind: 'context', status: 'info' }),
      event(2, '上下文占用', '51%', { kind: 'context', status: 'info' }),
    ]);
    expect(items[0]).toMatchObject({
      type: 'group',
      title: '上下文占用 · 2 条记录',
      status: 'info',
    });
  });

  it('keeps an unfinished compaction active after an updated summary', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, '正在整理上下文', null, {
        kind: 'compaction',
        status: 'started',
      }),
      event(2, '上下文摘要已生成', null, {
        kind: 'compaction',
        status: 'updated',
      }),
      event(3, '上下文占用', null, { kind: 'context', status: 'info' }),
    ]);
    expect(items[0]).toMatchObject({ type: 'group', status: 'running' });
  });

  it('does not treat a completed prune as the end of a newer compaction', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, '上下文已整理', null, { kind: 'compaction' }),
      event(2, '正在整理上下文', null, {
        kind: 'compaction',
        status: 'started',
      }),
      event(3, '工具结果已精简', null, { kind: 'compaction' }),
    ]);
    expect(items[0]).toMatchObject({ type: 'group', status: 'running' });
  });

  it('retains failure and cancellation in phase summaries', () => {
    for (const status of ['failed', 'cancelled']) {
      const items = aggregateRuntimeTimelineEvents([
        event(1, '正在整理上下文', null, {
          kind: 'compaction',
          status: 'started',
        }),
        event(2, '上下文整理未完成', '整理中断', {
          kind: 'compaction',
          status,
        }),
      ]);
      expect(items[0]).toMatchObject({ type: 'group', status });
    }
  });

  it('does not report an active repeated tool as completed', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'cloud.mcp.call', null, { kind: 'tool' }),
      event(2, 'cloud.mcp.call', null, { kind: 'tool', status: 'started' }),
    ]);
    expect(items[0]).toMatchObject({ type: 'group', status: 'running' });
  });

  it('never groups events from separate runs', () => {
    const items = aggregateRuntimeTimelineEvents([
      event(1, 'Skill 已加载', 'browser-research'),
      event(2, 'Skill 已加载', 'document-analysis', { runId: 'run-2' }),
    ]);
    expect(items.map((item) => item.type)).toEqual(['event', 'event']);
  });

  it('distinguishes preparation from maintenance and preserves unknown statuses', () => {
    expect(
      runtimeTimelineCategory(
        event(1, '上下文注入', null, { kind: 'context' }),
      ),
    ).toBe('prepare');
    expect(
      runtimeTimelineCategory(
        event(2, '上下文占用', null, { kind: 'context' }),
      ),
    ).toBe('context');
    expect(runtimeTimelineStatus('started').label).toBe('已开始');
    expect(runtimeTimelineStatus('running').label).toBe('执行中');
    expect(runtimeTimelineStatus('rate_limited')).toMatchObject({
      label: 'rate_limited',
      tone: 'muted',
    });
  });
});
