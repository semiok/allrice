import { describe, expect, it } from 'vitest';
import { MemorySourceViewProjectionSchema } from '@allrice/contracts';
import { memorySourceCopy } from './employee-memory-source-copy';

const source = {
  sourceType: 'message' as const,
  sourceLabel: '模型提取候选',
  capturedAt: '2026-11-20T17:34:00.000Z',
};
describe('approved memory source display copy', () => {
  it.each([
    ['user', '手动添加'],
    ['message', '来自对话'],
    ['checkpoint', '来自会话快照'],
    ['file', '来自文件'],
    ['tool', '来自工具'],
    ['connector', '来自已连接的服务'],
  ] as const)(
    'retains the structured %s source category as %s',
    (sourceType, type) => {
      expect(
        memorySourceCopy({ ...source, sourceType, sourceLabel: '用户更正' }),
      ).toEqual({ type, label: '手动修改过' });
    },
  );
  it.each([
    ['模型提取候选', '对话中自动记下'],
    ['用户保存的记忆', '手动添加'],
    ['用户更正', '手动修改过'],
    ['legacy memory', '历史记忆'],
    ['模型提取候选 · 用户确认', '对话中自动记下 · 已确认'],
    ['legacy memory · 用户确认', '历史记忆 · 已确认'],
    ['自定义周报记录 · 用户确认', '自定义周报记录 · 已确认'],
    ['', '来源说明未记录'],
    [' \n\t', '来源说明未记录'],
    ['  自定义来源\n完整说明  ', '  自定义来源\n完整说明  '],
    ['模型提取候选（自定义）', '模型提取候选（自定义）'],
  ])('formats only the approved exact label %j', (sourceLabel, label) => {
    expect(memorySourceCopy({ ...source, sourceLabel }).label).toBe(label);
  });
  it.each(['user', 'checkpoint', 'file', 'tool', 'connector'] as const)(
    'never calls an identically named %s label an automatic conversation record',
    (sourceType) => {
      expect(memorySourceCopy({ ...source, sourceType }).label).toBe(
        '模型提取候选',
      );
      expect(
        memorySourceCopy({
          ...source,
          sourceType,
          sourceLabel: '模型提取候选 · 用户确认',
        }).label,
      ).toBe('模型提取候选 · 已确认');
    },
  );
  it('rejects unknown source types in the transport contract rather than guessing conversation semantics', () => {
    expect(
      MemorySourceViewProjectionSchema.safeParse({
        ...source,
        sourceType: 'unknown',
      }).success,
    ).toBe(false);
  });
});
