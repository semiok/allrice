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
    ...overrides,
  };
}
describe('chronological public work process', () => {
  it('preserves distinct operations and their actual target in execution order', () => {
    const state = summarizeWorkProcess([
      call(3, {
        toolName: 'workspace.export.create',
        activityDetail: '生成文件：财报摘要.docx',
      }),
      call(1, { detail: '已查询 NVDA 公开行情' }),
      call(2, {
        activityDetail: '查询 AAPL 的实时行情',
        detail: '工具执行完成',
      }),
      call(4, {
        toolName: 'web.search',
        activityDetail: '搜索资料：英伟达最新财报',
        detail: '搜索完成',
      }),
    ]);
    expect(
      state.steps.map(({ label, description }) => ({ label, description })),
    ).toEqual([
      { label: '行情', description: '已查询 NVDA 公开行情' },
      { label: '行情', description: '查询 AAPL 的实时行情' },
      { label: '生成', description: '生成文件：财报摘要.docx' },
      { label: '搜索', description: '搜索资料：英伟达最新财报' },
    ]);
  });
  it('retains failed and suspended work without reporting either as completed', () => {
    const state = summarizeWorkProcess([
      call(1, {
        status: 'failed',
        detail: '服务超时',
        activityDetail: '查询 NVDA 的实时行情',
      }),
      call(2, { status: 'started' }),
      call(3, { status: 'info', toolName: 'ask_user_question' }),
    ]);
    expect(state.steps[0]).toMatchObject({
      status: 'failed',
      error: '服务超时',
      description: '查询 NVDA 的实时行情',
    });
    expect(state.steps[2]).toMatchObject({ status: 'info', label: '确认' });
    expect(state.failed).toBe(1);
    expect(state.active).toBe('查询实时行情');
  });
  it('uses lifecycle-only thinking and honest Chinese fallbacks without raw code', () => {
    const state = summarizeWorkProcess([
      call(1, {
        kind: 'think',
        detail: '私有推理内容',
        activityDetail: '不应展示',
      }),
      call(2, { kind: 'compaction' }),
      call(3, {
        toolName: 'bash',
        detail: '```python\nprint("原始代码")\n```',
      }),
      call(4, { toolName: 'skill', detail: 'Skill 已加载' }),
    ]);
    expect(state.steps.map((x) => x.description)).toEqual([
      '分析任务与处理步骤',
      '整理会话记录',
      '运行命令',
      '加载技能',
    ]);
  });
});
