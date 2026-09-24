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

export type WorkProcessCategory =
  | 'think'
  | 'search'
  | 'market'
  | 'analyze'
  | 'read'
  | 'find'
  | 'write'
  | 'edit'
  | 'execute'
  | 'browse'
  | 'skill'
  | 'collaborate'
  | 'question'
  | 'organize'
  | 'plan'
  | 'tool';

export interface WorkProcessStep {
  id: string;
  category: WorkProcessCategory;
  label: string;
  description: string;
  status: NativeExperienceItem['status'];
  error?: string;
}

/** Only tenant-facing summaries, never raw reasoning, argument JSON or output. */
function readableSummary(value?: string) {
  if (
    !value ||
    !/[\u3400-\u9fff]/u.test(value) ||
    /```|[\r\n]|^\s*[[{]/u.test(value)
  )
    return undefined;
  const summary = value.trim();
  if (/^(工具执行|搜索(?:完成|失败)|Skill (?:已|加载))/.test(summary))
    return undefined;
  return summary.length > 120 ? `${summary.slice(0, 119)}…` : summary;
}

function classification(
  item: NativeExperienceItem,
): [WorkProcessCategory, string] {
  if (item.kind === 'think') return ['think', '思考'];
  if (item.kind === 'compaction') return ['organize', '整理'];
  if (item.kind === 'todo') return ['plan', '计划'];
  const name = item.toolName ?? item.title;
  if (item.kind === 'search' || /search|grep|glob/.test(name))
    return ['search', '搜索'];
  if (name === 'market.history') return ['analyze', '分析'];
  if (name.startsWith('market.')) return ['market', '行情'];
  if (/browser/.test(name)) return ['browse', '浏览'];
  if (/read|fetch/.test(name)) return ['read', '阅读'];
  if (/list/.test(name)) return ['find', '查找'];
  if (/export|write/.test(name)) return ['write', '生成'];
  if (/edit|changeset/.test(name)) return ['edit', '修改'];
  if (/memory/.test(name)) return ['organize', '记忆'];
  if (name === 'skill') return ['skill', '技能'];
  if (name === 'ask_user_question') return ['question', '确认'];
  if (/assistant\.|subagent/.test(name)) return ['collaborate', '协作'];
  if (/process|service|bash|run_code/.test(name)) return ['execute', '执行'];
  return ['tool', '工具'];
}

export function summarizeWorkProcess(items: NativeExperienceItem[]) {
  const steps: WorkProcessStep[] = [...items]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((item) =>
      ['tool', 'search', 'think', 'compaction', 'todo'].includes(item.kind),
    )
    .map((item) => {
      const [category, label] = classification(item);
      const fallback =
        item.kind === 'think'
          ? '分析任务与处理步骤'
          : item.kind === 'compaction'
            ? '整理会话记录'
            : item.kind === 'todo'
              ? '更新工作计划'
              : toolActivityLabel(
                  item.toolName ?? item.title,
                  item.kind === 'search',
                );
      return {
        id: item.id,
        category,
        label,
        status: item.status,
        // Reasoning events expose lifecycle only. Do not infer or quote private thoughts.
        description:
          item.kind === 'think'
            ? fallback
            : (readableSummary(item.activityDetail) ??
              (item.status !== 'failed'
                ? readableSummary(item.detail)
                : undefined) ??
              fallback),
        ...(item.status === 'failed'
          ? { error: readableSummary(item.detail) }
          : {}),
      };
    });
  const active = [...items]
    .filter(
      (item) =>
        ['tool', 'search'].includes(item.kind) &&
        ['started', 'updated'].includes(item.status),
    )
    .sort(
      (a, b) => (b.lastSequence ?? b.sequence) - (a.lastSequence ?? a.sequence),
    )[0];
  return {
    steps,
    failed: steps.filter((step) => step.status === 'failed').length,
    active: active
      ? toolActivityLabel(
          active.toolName ?? active.title,
          active.kind === 'search',
        )
      : undefined,
  };
}
