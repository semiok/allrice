import type { NativeExperienceItem } from './native-experience';

// Allrice tool names are not part of DSH's generic Search/Read/Write registry.
// Translate presentation only; keep the original events and outcomes intact.
const toolLabels: Record<string, string> = {
  'market.quote': '查询实时行情',
  'market.history': '分析历史走势',
  'web.search': '搜索资料',
  web_search: '搜索资料',
  'web.fetch': '阅读网页',
  web_fetch: '阅读网页',
  'local.fs.read': '读取文件',
  read: '读取文件',
  'workspace.file.read': '读取文件',
  'document.read': '阅读文档',
  'workspace.document.read': '阅读文档',
  'local.fs.list': '查找文件',
  'workspace.file.list': '查找文件',
  glob: '查找文件',
  'local.fs.search': '搜索文件内容',
  grep: '搜索文件内容',
  'workspace.export.create': '生成交付成果',
  'local.fs.changeset': '准备文件修改',
  edit: '修改文件',
  write: '写入文件',
  'local.fs.write': '写入文件',
  'local.process.execute': '运行本地任务',
  'cloud.process.execute': '运行云端任务',
  bash: '运行命令',
  run_code: '运行代码',
  skill: '加载技能',
  ask_user_question: '等待你的回答',
  'assistant.delegate': '安排助手',
  'assistant.report': '汇总助手结果',
  'assistant.development': '协作开发',
};

export function toolActivityLabel(name: string, search = false) {
  if (toolLabels[name]) return toolLabels[name];
  if (search) return '搜索资料';
  if (name.startsWith('market.')) return '查询市场数据';
  if (name.includes('browser')) return '浏览网页';
  if (name.includes('.mcp.')) return '使用已连接的服务';
  if (name.startsWith('workspace.memory.')) return '整理工作记忆';
  if (name.startsWith('local.process.')) return '管理本地任务';
  if (name.startsWith('local.service.')) return '管理本地服务';
  return '执行工具操作';
}

export interface WorkProcessGroup {
  key: string;
  label: string;
  count: number;
  completed: number;
  failed: number;
  pending: number;
  waiting: number;
  durationMs: number | null;
  lastSequence: number;
  errors: string[];
}

export function summarizeWorkProcess(items: NativeExperienceItem[]) {
  const groups = new Map<string, WorkProcessGroup>();
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'search') continue;
    const label = toolActivityLabel(
      item.toolName ?? item.title,
      item.kind === 'search',
    );
    const group = groups.get(label) ?? {
      key: label,
      label,
      count: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      waiting: 0,
      durationMs: 0,
      lastSequence: 0,
      errors: [],
    };
    group.count++;
    if (item.status === 'failed') {
      group.failed++;
      if (item.detail && !group.errors.includes(item.detail))
        group.errors.push(item.detail);
    } else if (item.status === 'completed') group.completed++;
    else if (item.status === 'info') group.waiting++;
    else group.pending++;
    const start = Date.parse(item.startedAt ?? '');
    const end = Date.parse(item.finishedAt ?? '');
    // The sum is cumulative tool time, not wall time: parallel calls overlap.
    // Incomplete event pairs remain unknown instead of inventing zero seconds.
    group.durationMs =
      group.durationMs !== null &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start
        ? group.durationMs + end - start
        : null;
    group.lastSequence = Math.max(
      group.lastSequence,
      item.lastSequence ?? item.sequence,
    );
    groups.set(label, group);
  }
  const list = [...groups.values()];
  return {
    groups: list,
    total: list.reduce((sum, group) => sum + group.count, 0),
    failed: list.reduce((sum, group) => sum + group.failed, 0),
    pending: list.reduce((sum, group) => sum + group.pending, 0),
    active: list
      .filter((group) => group.pending > 0)
      .sort((a, b) => b.lastSequence - a.lastSequence)[0]?.label,
    hasThinking: items.some((item) => item.kind === 'think'),
    hasCompaction: items.some((item) => item.kind === 'compaction'),
  };
}
