import { allRiceToolManifest, type AllRiceToolName } from './tool-manifest.ts';
import type { PlatformEmployeeDefinition } from './platform-employees.ts';
import {
  runtimeGovernedActions,
  RuntimePolicyControlsSchema,
} from './runtime-v2/policy.ts';

/** Root workflow tools, not a grant or a child tool allowlist. */
export const developmentWorkflowToolNames = [
  'assistant.development',
  'assistant.delegate',
  'assistant.report',
  'workspace.export.create',
  'local.fs.list',
  'local.fs.read',
  'local.process.execute',
] as const satisfies readonly AllRiceToolName[];

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
  policyActions:
    tool.canonicalName === 'assistant.development'
      ? ['assistant.delegate', 'local.process.execute', 'local.fs.changeset']
      : tool.canonicalName === 'browser.workspace'
        ? ['cloud.browser.observe', 'cloud.browser.act']
        : tool.canonicalName === 'local.browser.workspace' ||
            tool.canonicalName === 'local.preview.open'
          ? ['local.browser.observe', 'local.browser.act']
          : (runtimeGovernedActions as readonly string[]).includes(
                tool.canonicalName,
              )
            ? [tool.canonicalName]
            : [],
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
    if (definition.securityPolicy.deniedCapabilities.includes(tool.capability))
      errors.push(`工具 ${name} 所需能力 ${tool.capability} 已被员工策略禁止`);
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
  if (names.includes('assistant.development')) {
    for (const required of [
      'assistant.delegate',
      'assistant.report',
      'workspace.export.create',
    ]) {
      if (!names.includes(required))
        errors.push(`受控开发协作缺少必需工具：${required}`);
    }
  }
  if (definition.securityPolicy.approvalPolicy === 'autonomous')
    errors.push('平台当前不允许 AI 员工使用 autonomous 审批策略');
  return errors;
}

/** Selecting a Skill/tool is the administrator's capability configuration.
 * Resolve its implementation dependencies in the same edit, without granting
 * a device directory, connector credential or individual external operation. */
export type EmployeeSkillChoice = {
  id: string;
  requiredToolRefs: readonly string[];
  replaces?: readonly string[];
};

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
  const names = new Set([
    ...definition.capabilities.toolNames,
    ...skills
      .filter((skill) => selectedSkills.has(skill.id))
      .flatMap((skill) => [...skill.requiredToolRefs]),
  ]);
  if (names.has('assistant.development')) {
    for (const name of developmentWorkflowToolNames) names.add(name);
  }
  const localMcp =
    names.has('local.mcp.call') || names.has('local.mcp.discover');
  if (localMcp) {
    names.add('local.mcp.call');
    names.add('local.mcp.discover');
  }
  const tools = employeeToolCatalog.filter((tool) =>
    names.has(tool.canonicalName),
  );
  const capabilities = new Set<string>(tools.map((tool) => tool.capability));
  if (localMcp) capabilities.add('storage:write');
  if (names.has('cloud.mcp.call')) capabilities.add('network:outbound');
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
    },
    securityPolicy: {
      ...definition.securityPolicy,
      bridgeAccess,
      connectorIdentityModes:
        localMcp || names.has('cloud.mcp.call')
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
