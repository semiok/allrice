import { describe, expect, it } from 'vitest';
import type { NativeExperienceItem } from './native-experience';
import { summarizeWorkProcess, workProcessTitle } from './work-process';

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
  it.each([
    ['mapped', { toolName: 'web.search' }, '搜索资料', '搜索', '搜索资料'],
    [
      'prefix',
      { toolName: 'workspace.memory.remember' },
      '整理工作记忆',
      '记忆',
      '整理工作记忆',
    ],
    [
      'search',
      { kind: 'search', toolName: 'partner.lookup' },
      '搜索资料',
      '搜索',
      '搜索资料',
    ],
    [
      'unknown',
      { toolName: 'cloud_mcp_call' },
      'cloud_mcp_call',
      '工具',
      '执行工具操作',
    ],
    [
      'missing',
      { toolName: undefined, title: 'Tool' },
      '执行工具操作',
      '工具',
      '执行工具操作',
    ],
    [
      'title identity',
      { toolName: undefined, title: 'web.search' },
      '搜索资料',
      '搜索',
      '搜索资料',
    ],
  ] as const)(
    'shows the concrete %s tool without changing its activity label',
    (_case, identity, title, label, description) => {
      const state = summarizeWorkProcess([
        call(1, { status: 'started', ...identity }),
      ]);
      expect(state.steps[0]).toMatchObject({ title, label, description });
      expect(state.active).toBe(description);
    },
  );
  it.each([
    [
      'model wait',
      { modelWait: true, title: '等待模型响应' },
      '等待模型响应',
      '等待',
      '等待模型响应',
    ],
    [
      'compaction',
      { kind: 'compaction', title: '正在整理会话上下文' },
      '正在整理会话上下文',
      '整理',
      '正在整理上下文',
    ],
  ] as const)(
    'keeps the %s phase independent of a carried tool identity',
    (_case, phase, title, label, active) => {
      const state = summarizeWorkProcess([
        call(1, { toolName: 'web.search', status: 'started', ...phase }),
      ]);
      expect(state.steps[0]).toMatchObject({
        title,
        label,
        description: title,
      });
      expect(state.active).toBe(active);
    },
  );
  it('only carries existing safe summaries and ordered recorded timing into inline details', () => {
    const result = summarizeWorkProcess([
      call(1, {
        activityDetail: '查询 NVDA 的实时行情',
        detail: '找到一条行情',
        startedAt: '2026-11-10T00:00:00Z',
        finishedAt: '2026-11-10T00:00:00.121Z',
      }),
      call(2, {
        detail: '```secret\n原始结果\n```',
        startedAt: 'not-a-date',
        finishedAt: '2026-11-10T00:00:00Z',
      }),
      call(3, {
        startedAt: '2026-11-10T00:00:01Z',
        finishedAt: '2026-11-10T00:00:00Z',
      }),
      call(4, {
        kind: 'think',
        activityDetail: '私有推理',
        detail: '私有推理结果',
      }),
    ]).steps;
    expect(result[0]).toMatchObject({
      title: '查询 NVDA 的实时行情',
      input: '查询 NVDA 的实时行情',
      result: '找到一条行情',
      elapsedMs: 121,
    });
    expect(result[1]?.result).toBeUndefined();
    expect(result[1]?.elapsedMs).toBeUndefined();
    expect(result[2]?.elapsedMs).toBeUndefined();
    expect(result[3]?.input).toBeUndefined();
    expect(result[3]?.result).toBeUndefined();
  });
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

it('uses native action titles for live, settled, failed and mixed work', () => {
  const memory = call(1, { toolName: 'workspace.memory.remember' });
  expect(workProcessTitle([memory], false)).toBe('已调用工具');
  expect(workProcessTitle([{ ...memory, status: 'started' }], true)).toBe(
    '正在调用工具',
  );
  expect(workProcessTitle([{ ...memory, status: 'failed' }], false)).toBe(
    '已调用工具',
  );
  expect(
    workProcessTitle(
      [call(1, { kind: 'think' }), call(2, { toolName: 'read' }), memory],
      false,
    ),
  ).toBe('已调用工具并读取文件');
  expect(
    workProcessTitle(
      [call(1, { toolName: 'ask_user_question', status: 'info' })],
      false,
    ),
  ).toBe('向用户提出了问题');
  expect(
    workProcessTitle(
      [
        call(1, {
          kind: 'compaction',
          title: '上下文整理未完成',
          status: 'failed',
        }),
      ],
      false,
    ),
  ).toBe('上下文整理未完成');
});

it.each([
  ['todo_write', '更新了计划'],
  ['read_image', '已读取图片'],
  ['workspace.memory.search', '已调用工具'],
  ['workspace.memory.read', '已调用工具'],
  ['cloud_mcp_call', '已调用工具'],
  ['web_search', '已搜索网页'],
  ['web.search', '已搜索网页'],
  ['web_fetch', '已访问网页'],
  ['web.fetch', '已访问网页'],
  ['apply_patch', '修改了文件'],
])('keeps %s in the native activity category', (toolName, expected) => {
  expect(workProcessTitle([call(1, { toolName })], false)).toBe(expected);
});

it('joins fixed locale actions without interpreting title text', () => {
  expect(
    workProcessTitle(
      [call(1, { toolName: 'read' }), call(2, { toolName: 'web_search' })],
      false,
    ),
  ).toBe('已读取文件并搜索网页');
  expect(
    workProcessTitle(
      [call(1, { toolName: 'edit' }), call(2, { toolName: 'read' })],
      false,
    ),
  ).toBe('修改了文件并已读取文件');
  expect(
    workProcessTitle(
      [call(1, { toolName: 'read' }), call(2, { toolName: 'todo_write' })],
      false,
    ),
  ).toBe('已读取文件并更新了计划');
  expect(
    workProcessTitle(
      [
        call(1, { kind: 'compaction', title: '已整理上下文' }),
        call(2, { toolName: 'read' }),
      ],
      false,
    ),
  ).toBe('已整理上下文并已读取文件');
});
