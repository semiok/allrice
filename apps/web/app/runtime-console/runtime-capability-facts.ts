import {
  PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS,
  developmentWorkflowToolNames,
  type RuntimeCapabilityInventory,
} from '@allrice/contracts';

export interface PlatformNativeSkillSummary {
  id: string;
  name: string;
  description: string;
  checksum: string;
  requiredToolRefs: string[];
  enabled: boolean;
  version: string;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
}

export interface RuntimeCapabilityResponse extends RuntimeCapabilityInventory {
  webUi?: {
    components: { id: string; version: string }[];
    workbenchEnabled: boolean;
  };
  skills: PlatformNativeSkillSummary[];
  webTools: { name: string; enabled: boolean }[];
}

export const enhancementPackages = new Set<string>(
  PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS,
);

export function runtimeCapabilityFacts(data: RuntimeCapabilityResponse | null) {
  const workers = data?.workers.filter((worker) => worker.online) ?? [];
  const measured =
    workers.length > 0 &&
    workers.every((worker) => worker.profileStatus === 'read');
  const components = workers.map((worker) =>
    worker.components.filter(
      (component) =>
        component.state === 'configured' && component.version !== null,
    ),
  );
  const range = (counts: number[]) => {
    if (!measured) return '—';
    const min = Math.min(...counts),
      max = Math.max(...counts);
    return min === max ? String(min) : `${min}–${max}`;
  };
  const availableSkills =
    data?.skills.filter(
      (skill) => skill.enabled && skill.reviewStatus === 'reviewed',
    ) ?? [];
  const publishedSkillIds = new Set(
    data?.publications.flatMap((item) => item.skillIds) ?? [],
  );
  return {
    workers,
    measured,
    availableSkills,
    publishedSkillIds,
    componentCount: range(components.map((items) => items.length)),
    enhancementCount: range(
      components.map(
        (items) =>
          items.filter((item) => enhancementPackages.has(item.packageName))
            .length,
      ),
    ),
    versions: [
      ...new Set(
        workers.flatMap((worker) => (worker.version ? [worker.version] : [])),
      ),
    ],
  };
}

export function integratedCapabilityStatus(
  id: string,
  data: RuntimeCapabilityResponse | null,
): string {
  if (id.startsWith('ui-')) {
    const component = data?.webUi?.components.find(
      (item) => item.id === id.slice(3),
    );
    if (!component) return 'Web 界面接入状态未知';
    if (
      !['ui-employee-workspace', 'ui-native-settings'].includes(id) &&
      !data!.webUi!.workbenchEnabled
    )
      return `UI ${component.version} 已安装 · 工作台已显式关闭`;
    return `UI ${component.version} · 当前 Web 已接入`;
  }
  const facts = runtimeCapabilityFacts(data);
  if (!facts.measured) return '运行状态未知';
  const office = facts.availableSkills.find((skill) => skill.name === 'office');
  if (id === 'office' && !office) return 'Office Skill 尚未同步或已停用';
  if (id === 'assistants' || id === 'development' || id === 'office') {
    const required: readonly string[] =
      id === 'office'
        ? office!.requiredToolRefs
        : id === 'development'
          ? developmentWorkflowToolNames
          : ['assistant.delegate', 'assistant.report'];
    const enabled = (tools: { name: string; enabled: boolean }[]) =>
      required.every((name) =>
        tools.some((tool) => tool.name === name && tool.enabled),
      );
    const enabledWorkers = facts.workers.filter((worker) =>
      enabled(worker.tools),
    ).length;
    if (enabledWorkers === 0) return 'Worker 功能开关未开启';
    if (enabledWorkers !== facts.workers.length) return 'Worker 配置不一致';
    if (!enabled(data!.webTools)) return 'Web 功能开关未开启';
    const publications = data!.publications.filter(
      (item) =>
        required.every((name) => item.toolNames.includes(name)) &&
        (id !== 'office' || item.skillIds.includes(office!.id)),
    );
    if (!publications.length) return '尚未发布到租户员工';
    // Office uses managed storage tools, not the assistant/command execution policy.
    const policyEnabled =
      id === 'office'
        ? publications
        : publications.filter(
            (item) => item.policyEnabled && item.policyMode === 'execute',
          );
    if (!policyEnabled.length) return '已发布 · 租户执行策略未开启';
    return `已发布到 ${new Set(policyEnabled.map((item) => item.workspaceId)).size} 个工作区 · 任务内校验授权`;
  }
  const packages: Record<string, string[]> = {
    'native-images': ['@deepseek-ai/dsh-attachment-local'],
    'durable-wait': [
      '@deepseek-ai/dsh-user-questions',
      '@deepseek-ai/dsh-tool-ask-user',
    ],
    'session-recovery': [
      '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-compaction-basic',
    ],
  };
  const required = packages[id];
  if (!required) return '接入状态待核对';
  const configured = facts.workers.filter((worker) =>
    required.every((name) =>
      worker.components.some(
        (component) =>
          component.packageName === name &&
          component.state === 'configured' &&
          component.version,
      ),
    ),
  );
  return configured.length === facts.workers.length
    ? '运行组件已配置'
    : configured.length
      ? 'Worker 配置不一致'
      : '运行组件未配置';
}
