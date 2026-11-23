import type { MemorySourceViewProjection } from '@allrice/contracts';

const typeLabels: Record<MemorySourceViewProjection['sourceType'], string> = {
  user: '手动添加',
  message: '来自对话',
  checkpoint: '来自会话快照',
  file: '来自文件',
  tool: '来自工具',
  connector: '来自已连接的服务',
};

/** Approved MET-284 display copy only. Neither a label nor its suffix decides
 * confirmation, identity, trust, authorization or access to an original source. */
export function memorySourceCopy(source: MemorySourceViewProjection) {
  const suffix = ' · 用户确认';
  const hasSuffix = source.sourceLabel.endsWith(suffix);
  const original = hasSuffix
    ? source.sourceLabel.slice(0, -suffix.length)
    : source.sourceLabel;
  let label = original;
  if (!original.trim()) label = '来源说明未记录';
  else if (source.sourceType === 'message' && original === '模型提取候选')
    label = '对话中自动记下';
  else if (original === '用户保存的记忆') label = '手动添加';
  else if (original === '用户更正') label = '手动修改过';
  else if (original === 'legacy memory') label = '历史记忆';
  return {
    type: typeLabels[source.sourceType],
    label: hasSuffix ? `${label} · 已确认` : label,
  };
}
