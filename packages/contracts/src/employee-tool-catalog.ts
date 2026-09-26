import { allRiceToolManifest, type AllRiceToolName } from './tool-manifest.ts';
import type { PlatformEmployeeDefinition } from './platform-employees.ts';
import {
  runtimeGovernedActions,
  RuntimePolicyControlsSchema,
} from './runtime-v2/policy.ts';

export type EmployeeToolService =
  | 'assistants'
  | 'workbench'
  | 'changeset'
  | 'local_mcp'
  | 'cloud_mcp'
  | 'local_command'
  | 'local_service'
  | 'cloud_execution'
  | 'cloud_browser'
  | 'local_browser'
  | 'local_preview'
  | 'cloud_runner';
type ToolRequirements = {
  requiredTools?: readonly AllRiceToolName[];
  // Existing proposal-only configurations remain readable. These additional
  // tools are assembled for the complete workflow, not new execution grants.
  workflowTools?: readonly AllRiceToolName[];
  capabilities?: readonly PlatformEmployeeDefinition['securityPolicy']['deniedCapabilities'][number][];
  serviceIdentity?: boolean;
  policyActions?: readonly string[];
  services?: readonly EmployeeToolService[];
  environment?: 'device' | 'cloud' | 'connection_on_demand';
  setupHint?: string;
};

/** Static composition over the existing Broker manifest. Runtime readiness
 * and authorization remain facts supplied by their existing owners. */
const requirements: Partial<Record<AllRiceToolName, ToolRequirements>> = {
  'assistant.development': {
    requiredTools: [
      'assistant.delegate',
      'assistant.report',
      'workspace.export.create',
    ],
    workflowTools: ['local.fs.list', 'local.fs.read', 'local.process.execute'],
    policyActions: [
      'assistant.delegate',
      'local.process.execute',
      'local.fs.changeset',
    ],
    services: ['assistants', 'workbench', 'changeset'],
    environment: 'device',
    setupHint:
      '开发协作使用已连接的电脑和已选项目目录，测试环境由 Bridge 自动准备；可在设置 → 我的电脑查看状态。',
  },
  'local.mcp.call': {
    requiredTools: ['local.mcp.discover'],
    capabilities: ['storage:write'],
    serviceIdentity: true,
    services: ['local_mcp'],
  },
  'local.mcp.discover': {
    requiredTools: ['local.mcp.call'],
    capabilities: ['storage:write'],
    serviceIdentity: true,
    services: ['local_mcp'],
  },
  'cloud.mcp.call': {
    capabilities: ['network:outbound'],
    serviceIdentity: true,
    services: ['cloud_mcp'],
    environment: 'connection_on_demand',
    setupHint:
      '员工可按需连接应用；需要登录时在任务中继续，已连接应用可在设置中管理。无需预先创建 MCP 连接。',
  },
  'local.process.execute': { services: ['local_command'] },
  'local.process.status': { services: ['local_command', 'local_service'] },
  'local.process.stop': { services: ['local_command', 'local_service'] },
  'cloud.process.execute': {
    services: ['cloud_execution'],
    environment: 'cloud',
  },
  'browser.workspace': {
    policyActions: ['cloud.browser.observe', 'cloud.browser.act'],
    services: ['cloud_browser'],
    environment: 'cloud',
  },
  'local.browser.workspace': {
    policyActions: ['local.browser.observe', 'local.browser.act'],
    services: ['local_browser'],
  },
  'local.preview.open': {
    policyActions: ['local.browser.observe', 'local.browser.act'],
    services: ['local_preview'],
  },
  'workspace.reconciliation.export': {
    services: ['cloud_runner', 'workbench'],
    environment: 'cloud',
  },
};

export function employeeToolRequirements(name: string): ToolRequirements {
  return (
    requirements[name as AllRiceToolName] ??
    (name.startsWith('assistant.') ? { services: ['assistants'] } : {})
  );
}

export function resolveEmployeeToolDependencies(names: readonly string[]) {
  const resolved = new Set(names);
  // Set iteration visits additions and terminates even for mutual dependencies.
  for (const name of resolved) {
    const rule = employeeToolRequirements(name);
    for (const dependency of [
      ...(rule.requiredTools ?? []),
      ...(rule.workflowTools ?? []),
    ])
      resolved.add(dependency);
  }
  return [...resolved];
}

/** Root workflow tools, not a grant or a child tool allowlist. */
export const developmentWorkflowToolNames = resolveEmployeeToolDependencies([
  'assistant.development',
]);

// Presentation only. Registration, capability and risk come from the Broker manifest.
const labels: Partial<Record<AllRiceToolName, string>> = {
  'assistant.delegate': '委派受控助手',
  'assistant.message': '助手消息',
  'assistant.report': '助手结果汇报',
  'assistant.development': '受控开发提案、测试与独立审查',
  'assistant.stop': '停止助手',
  'local.process.execute': '本地隔离命令',
  'local.process.status': '本地服务状态',
  'local.process.stop': '停止本地服务',
  'cloud.process.execute': '云端隔离脚本',
  'browser.workspace': '云端浏览器工作区',
  'local.browser.workspace': '本地独立浏览器',
  'local.preview.open': '本地项目预览',
  'browser.run': '传统云端网页读取',
  'cloud.mcp.call': '云端 MCP 调用',
  'local.mcp.call': '本地 MCP 调用',
  'local.mcp.discover': '本地 MCP 工具发现',
  'workspace.export.create': '文件 / 报告 / Changeset 提案',
  'workspace.skill.read': '读取已冻结 Skill',
  'workspace.reconciliation.export': '对账工件交付',
  'workspace.file.list': '工作区文件列表',
  'workspace.file.read': '读取工作区文件',
  'workspace.document.read': '解析工作区文档',
  'workspace.memory.search': '检索记忆',
  'workspace.memory.remember': '写入获准记忆',
  'workspace.session.search': '检索会话',
  'web.search': '联网搜索',
  'web.fetch': '读取网页',
  'wechat.article.search': '搜索公众号文章',
  'wechat.article.read': '读取公众号文章',
  'market.quote': '查询公开行情',
  'market.history': '查询历史行情',
  'local.fs.list': '本地目录列表',
  'local.fs.search': '本地文件搜索',
  'local.fs.read': '读取本地文件',
  'local.fs.write': '写入本地文本文件',
  'local.fs.mkdir': '新建本地目录',
  'local.git.status': '本地 Git 状态',
  'local.git.diff': '本地 Git 差异',
  'automation.create': '创建自动化',
};
export const employeeToolCatalog = allRiceToolManifest.map((tool) => ({
  ...tool,
  label: labels[tool.canonicalName] ?? tool.canonicalName,
  target: tool.canonicalName.startsWith('local.')
    ? ('bridge' as const)
    : tool.canonicalName.startsWith('cloud.') ||
        tool.canonicalName.startsWith('browser.')
      ? ('cloud' as const)
      : ('saas' as const),
  requirements: employeeToolRequirements(tool.canonicalName),
  environment:
    employeeToolRequirements(tool.canonicalName).environment ??
    (tool.canonicalName.startsWith('local.') ? ('device' as const) : undefined),
  policyActions:
    employeeToolRequirements(tool.canonicalName).policyActions ??
    ((runtimeGovernedActions as readonly string[]).includes(tool.canonicalName)
      ? [tool.canonicalName]
      : []),
}));
export const configurableEmployeeToolNames = new Set<string>(
  employeeToolCatalog.map((tool) => tool.canonicalName),
);

export function employeeToolConfigurationErrors(
  definition: PlatformEmployeeDefinition,
) {
  const names = definition.capabilities.toolNames,
    errors: string[] = [];
  for (const name of names) {
    const tool = employeeToolCatalog.find(
      (tool) => tool.canonicalName === name,
    );
    if (!tool) {
      errors.push(`未注册工具：${name}`);
      continue;
    }
    for (const capability of [
      tool.capability,
      ...(tool.requirements.capabilities ?? []),
    ])
      if (definition.securityPolicy.deniedCapabilities.includes(capability))
        errors.push(`工具 ${name} 所需能力 ${capability} 已被员工策略禁止`);
    if (tool.target === 'bridge') {
      if (definition.securityPolicy.bridgeAccess === 'none')
        errors.push(`Bridge 已禁用，但员工仍配置了 ${name}`);
      else if (
        definition.securityPolicy.bridgeAccess === 'read_only' &&
        tool.capability !== 'storage:read'
      )
        errors.push(`Bridge 为只读，不能配置 ${name}`);
    }
  }
  if (new Set(names).size !== names.length) errors.push('工具清单包含重复项');
  for (const name of names) {
    for (const required of employeeToolRequirements(name).requiredTools ?? []) {
      if (!names.includes(required))
        errors.push(`工具 ${name} 缺少必需工具：${required}`);
    }
  }
  return errors;
}

/** Selecting a Skill/tool is the administrator's capability configuration.
 * Resolve its implementation dependencies in the same edit, without granting
 * a device directory, connector credential or individual external operation. */
export type EmployeeSkillChoice = {
  id: string;
  name?: string;
  requiredToolRefs: readonly string[];
  replaces?: readonly string[];
};

export function employeeToolDependencySources(
  definition: PlatformEmployeeDefinition,
  skills: readonly EmployeeSkillChoice[],
) {
  const sources: Record<string, string[]> = {};
  const add = (names: string[], label: string) => {
    for (const name of names) sources[name] = [...(sources[name] ?? []), label];
  };
  const selected = new Set(
    resolveEmployeeSkillIds(definition.capabilities.nativeSkillIds, skills),
  );
  for (const skill of skills.filter((skill) => selected.has(skill.id)))
    add(
      resolveEmployeeToolDependencies(skill.requiredToolRefs),
      skill.name ?? skill.id,
    );
  for (const name of definition.capabilities.explicitToolNames ??
    definition.capabilities.toolNames)
    add(
      resolveEmployeeToolDependencies([name]).filter(
        (dependency) => dependency !== name,
      ),
      employeeToolCatalog.find((tool) => tool.canonicalName === name)?.label ??
        name,
    );
  return sources;
}

/** Only new drafts are upgraded. Published packages retain their frozen IDs. */
export function resolveEmployeeSkillIds(
  selected: readonly string[],
  skills: readonly EmployeeSkillChoice[],
) {
  const replacements = new Map(
    skills.flatMap((skill) =>
      (skill.replaces ?? []).map((id) => [id, skill.id] as const),
    ),
  );
  return [...new Set(selected.map((id) => replacements.get(id) ?? id))];
}

export function upgradeEmployeeSkillBindings(
  definition: PlatformEmployeeDefinition,
  skills: readonly EmployeeSkillChoice[],
): PlatformEmployeeDefinition {
  const ids = resolveEmployeeSkillIds(
    definition.capabilities.nativeSkillIds,
    skills,
  );
  if (
    JSON.stringify(ids) ===
    JSON.stringify(definition.capabilities.nativeSkillIds)
  )
    return definition;
  return assembleEmployeeCapabilities(definition, skills);
}

export function assembleEmployeeCapabilities(
  definition: PlatformEmployeeDefinition,
  skills: readonly EmployeeSkillChoice[],
): PlatformEmployeeDefinition {
  const nativeSkillIds = resolveEmployeeSkillIds(
    definition.capabilities.nativeSkillIds,
    skills,
  );
  const selectedSkills = new Set(nativeSkillIds);
  // With no provenance, preserve every historical tool as an explicit choice.
  const explicitToolNames = [
    ...new Set(
      definition.capabilities.explicitToolNames ??
        definition.capabilities.toolNames,
    ),
  ];
  const names = new Set(
    resolveEmployeeToolDependencies([
      ...explicitToolNames,
      ...skills
        .filter((skill) => selectedSkills.has(skill.id))
        .flatMap((skill) => [...skill.requiredToolRefs]),
    ]),
  );
  const tools = employeeToolCatalog.filter((tool) =>
    names.has(tool.canonicalName),
  );
  const capabilities = new Set<string>(
    tools.flatMap((tool) => [
      tool.capability,
      ...(tool.requirements.capabilities ?? []),
    ]),
  );
  const bridgeTools = tools.filter((tool) => tool.target === 'bridge');
  const bridgeAccess = bridgeTools.some(
    (tool) => tool.capability !== 'storage:read',
  )
    ? 'read_write'
    : bridgeTools.length && definition.securityPolicy.bridgeAccess === 'none'
      ? 'read_only'
      : definition.securityPolicy.bridgeAccess;
  return {
    ...definition,
    capabilities: {
      ...definition.capabilities,
      nativeSkillIds,
      toolNames: [...names],
      explicitToolNames,
    },
    securityPolicy: {
      ...definition.securityPolicy,
      bridgeAccess,
      connectorIdentityModes: tools.some(
        (tool) => tool.requirements.serviceIdentity,
      )
        ? [
            ...new Set([
              ...definition.securityPolicy.connectorIdentityModes,
              'service' as const,
            ]),
          ]
        : definition.securityPolicy.connectorIdentityModes,
      deniedCapabilities: definition.securityPolicy.deniedCapabilities.filter(
        (capability) => !capabilities.has(capability),
      ),
    },
  };
}

/** Workspace execution settings resulting from an explicit employee publication.
 * Unselected actions retain their rules; exact-operation approvals stay intact. */
export function employeePublicationPolicy(
  current: unknown,
  toolNames: readonly string[],
  version: number,
) {
  const previous = RuntimePolicyControlsSchema.safeParse(current);
  const selected = new Set(toolNames);
  const actions = new Set(
    employeeToolCatalog
      .filter((tool) => selected.has(tool.canonicalName))
      .flatMap((tool) => tool.policyActions),
  );
  return RuntimePolicyControlsSchema.parse({
    version,
    enabled: true,
    mode: 'execute',
    rules: [
      ...(previous.success
        ? previous.data.rules.filter((rule) => !actions.has(rule.action))
        : []),
      ...[...actions].sort().map((action) => ({ action, effect: 'allow' })),
    ],
  });
}
