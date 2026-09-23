import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  employeeToolCatalog,
  rapidEmployeeIterationEnabled,
  employeePublicationPolicy,
  developmentWorkflowToolNames,
  employeeToolConfigurationErrors,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  UuidSchema,
  runtimePolicyActionDecision,
  RuntimePolicyControlsSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requireTenantAdministrationAuthority } from './tenant-administration.ts';
import { localCommandFeatureEnabled } from './local-command-service.ts';
import { localServiceFeatureEnabled } from './local-service-runtime.ts';
import { localPreviewEnabled } from './local-preview-authority.ts';
import { cloudExecutionEnabled } from './cloud-authority.ts';
import { browserControlEnabled } from './browser-control-authority.ts';
import { localBrowserEnabled } from './local-browser-grants.ts';
import { mcpExecutionEnabled } from './mcp-authority.ts';
import { localMcpEnabled } from './local-mcp-connections.ts';
import { assistantRuntimeEnabled } from './assistant-runtime.ts';
import { changesetFeatureEnabled } from './changeset-service.ts';
import { workbenchEnabled } from './artifact-review.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

export function listEmployeeToolAvailability() {
  const gated: Record<string, boolean> = {
    'local.process.execute': localCommandFeatureEnabled(),
    'local.process.status':
      localCommandFeatureEnabled() && localServiceFeatureEnabled(),
    'local.process.stop':
      localCommandFeatureEnabled() && localServiceFeatureEnabled(),
    'cloud.process.execute': cloudExecutionEnabled(),
    'cloud.mcp.call': mcpExecutionEnabled(),
    'local.mcp.discover': localMcpEnabled(),
    'local.mcp.call': localMcpEnabled(),
    'browser.workspace': browserControlEnabled(),
    'local.browser.workspace': localBrowserEnabled(),
    'local.preview.open': localPreviewEnabled(),
    'workspace.reconciliation.export':
      runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED') &&
      workbenchEnabled(),
  };
  return employeeToolCatalog.map((tool) => ({
    ...tool,
    released:
      tool.canonicalName === 'assistant.development'
        ? assistantRuntimeEnabled() &&
          workbenchEnabled() &&
          changesetFeatureEnabled()
        : tool.canonicalName.startsWith('assistant.')
          ? assistantRuntimeEnabled()
          : (gated[tool.canonicalName] ?? true),
  }));
}

export async function readPlatformSkillForAdministration(
  context: RequestContext,
  skillInput: string,
  db = getDatabase(),
) {
  await requireTenantAdministrationAuthority(context, db);
  const [skill] =
    await db`select id,name,description,content,checksum,source,source_ref as "sourceRef",version,license,
    review_status as "reviewStatus",required_tool_refs as "requiredToolRefs",
    bundle->'dependencies' as dependencies from allrice_platform_dsh_skills where id=${UuidSchema.parse(skillInput)}`;
  if (!skill) throw new DataAccessError('not_found');
  return skill;
}

/** Read-only publication review, never a model call, policy install or device grant. */
export async function reviewEmployeePublication(
  context: RequestContext,
  employeeInput: string,
  workspaceInputs: string[],
  db = getDatabase(),
) {
  const rapidIteration = rapidEmployeeIterationEnabled();
  const employeeId = UuidSchema.parse(employeeInput);
  if (!workspaceInputs.length || workspaceInputs.length > 500)
    throw new DataAccessError('not_found');
  const workspaceIds = [
    ...new Set(workspaceInputs.map((id) => UuidSchema.parse(id))),
  ].sort();
  return db.begin('isolation level repeatable read read only', async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    const [employee] =
      await tx`select e.id,e.current_published_revision_id,r.id as revision_id,r.definition,r.runtime_profile,
      r.status,r.checksum,r.validation_report,p.definition as published_definition from allrice_platform_employees e
      join allrice_platform_employee_revisions r on r.id=e.current_draft_revision_id and r.employee_id=e.id
      left join allrice_platform_employee_revisions p on p.id=e.current_published_revision_id
      where e.id=${employeeId} and e.status<>'archived'`;
    if (!employee) throw new DataAccessError('not_found');
    const targets = await tx<
      {
        id: string;
        organizationId: string;
        organizationName: string;
        name: string;
        version: number | null;
        controls: unknown;
      }[]
    >`
      select w.id,w.organization_id as "organizationId",o.name as "organizationName",w.name,c.version,c.controls
      from allrice_workspaces w join allrice_organizations o on o.id=w.organization_id
      left join allrice_runtime_policy_controls c on c.workspace_id=w.id and c.organization_id=o.id
      where w.id in ${tx(workspaceIds)} and w.archived_at is null and o.archived_at is null and o.slug<>'allrice-platform' order by w.id`;
    if (targets.length !== workspaceIds.length)
      throw new DataAccessError('not_found');
    const definition = PlatformEmployeeDefinitionSchema.parse(
      employee.definition,
    );
    const profile = PlatformEmployeeRuntimeProfileSchema.safeParse(
      employee.runtime_profile,
    );
    const checksum = profile.success
      ? (profile.data.runtimePackage?.checksum ?? null)
      : null;
    const report = employee.validation_report as { errors?: unknown };
    const errors: string[] = Array.isArray(report?.errors)
        ? report.errors.filter(
            (error): error is string => typeof error === 'string',
          )
        : [],
      warnings: string[] = [];
    errors.push(...employeeToolConfigurationErrors(definition));
    if (definition.capabilities.toolNames.includes('assistant.development')) {
      const missing = developmentWorkflowToolNames.filter(
        (name) => !definition.capabilities.toolNames.includes(name),
      );
      if (missing.length)
        warnings.push(
          `开发协作完整链路尚缺工具：${missing.join('、')}；不能将仅提案配置视为测试与交付已就绪。`,
        );
      warnings.push(
        '开发协作需要连接 Rice Bridge、选择项目目录并准备测试沙箱；可在租户工作台连接设备。',
      );
    }
    if (employee.status !== 'testing' || !checksum)
      errors.push(
        '请先保存并编译当前草稿；已发布版本需另存新草稿后才能再次发布。',
      );
    const [test] =
      await tx`select id from allrice_platform_employee_test_runs where employee_id=${employeeId}
      and revision_id=${employee.revision_id} and frozen_package_checksum=${checksum} and status='succeeded'
      and completed_at >= clock_timestamp()-interval '24 hours' limit 1`;
    if (!test && !rapidIteration)
      errors.push(
        '当前确切运行包缺少 24 小时内的成功试用，请到调试页完成试用。',
      );
    const [provider] =
      await tx`select status from allrice_provider_status where provider='codex' and status='connected'
      and checked_at >= clock_timestamp()-interval '120 seconds'`;
    if (
      !rapidIteration &&
      (definition.modelPolicy.provider !== 'openai-codex' || !provider)
    )
      errors.push('Codex 订阅 Provider 不可用或健康状态已过期。');
    const tools = listEmployeeToolAvailability().filter((tool) =>
      definition.capabilities.toolNames.includes(tool.canonicalName),
    );
    // Registry hints only: a registered target never proves a user's current
    // device grant, liveness, sandbox, connector or per-operation authorization.
    const requiredKinds = [
      ...new Set(
        tools.flatMap((tool) =>
          tool.target === 'bridge'
            ? ['rice_bridge']
            : tool.canonicalName === 'cloud.mcp.call'
              ? ['cloud_mcp']
              : [
                    'cloud.process.execute',
                    'browser.workspace',
                    'workspace.reconciliation.export',
                  ].includes(tool.canonicalName)
                ? ['cloud_sandbox']
                : [],
        ),
      ),
    ];
    const registered = requiredKinds.length
      ? await tx<
          {
            workspace_id: string;
            organization_id: string;
            kind: string;
            state: string;
          }[]
        >`
      select workspace_id,organization_id,kind,state from allrice_execution_targets
      where workspace_id in ${tx(workspaceIds)} and kind in ${tx(requiredKinds)}`
      : [];
    for (const target of targets)
      for (const kind of requiredKinds) {
        const matches = registered.filter(
          (row) =>
            row.workspace_id === target.id &&
            row.organization_id === target.organizationId &&
            row.kind === kind,
        );
        if (!matches.length)
          warnings.push(
            `${target.organizationName} / ${target.name}：尚未连接 ${kind === 'rice_bridge' ? 'Rice Bridge，请在租户工作台连接设备并选择目录' : kind === 'cloud_mcp' ? 'MCP 服务，请在租户管理中添加连接' : '云端执行环境，请在租户管理中配置环境'}。`,
          );
        else
          warnings.push(
            `${target.organizationName} / ${target.name}：${kind} 目标登记状态 ${[...new Set(matches.map((row) => row.state))].join('、')}；实际使用者的权限、设备在线与沙箱条件仍在运行时核对。`,
          );
      }
    for (const tool of tools)
      if (!tool.released)
        (rapidIteration ? errors : warnings).push(
          `${tool.label}：执行服务当前已暂停，恢复后即可发布使用。`,
        );
    if (definition.capabilities.toolNames.includes('workspace.export.create'))
      warnings.push(
        `Changeset 是工件提案，不是直接写盘工具；精确审批与 local.fs.changeset 动作${changesetFeatureEnabled() ? '仍需设备授权' : '尚未开放'}。`,
      );
    const policies = targets.map((target) => {
      const parsed = RuntimePolicyControlsSchema.safeParse(target.controls);
      const controls = rapidIteration
        ? employeePublicationPolicy(
            target.controls,
            definition.capabilities.toolNames,
            target.version ?? 1,
          )
        : parsed.success && parsed.data.version === target.version
          ? parsed.data
          : null;
      const actions = [
        ...new Set(tools.flatMap((tool) => tool.policyActions)),
      ].map((action) => ({
        action,
        ...runtimePolicyActionDecision(controls, action),
      }));
      for (const action of actions)
        if (
          action.effect === 'deny' ||
          (action.action === 'assistant.delegate' && action.effect !== 'allow')
        )
          warnings.push(
            `${target.organizationName} / ${target.name}：${action.action} 当前${action.effect === 'deny' ? '策略禁止' : '策略不满足执行条件'}（${action.reason}），可在租户管理中配置${action.action === 'assistant.delegate' ? '为允许；助手委派不支持审批态' : ''}。`,
          );
      return {
        id: target.id,
        organizationId: target.organizationId,
        organizationName: target.organizationName,
        name: target.name,
        version: target.version,
        actions,
      };
    });
    if (tools.some((tool) => tool.target !== 'saas'))
      warnings.push(
        '发布后可进入租户工作台试用。首次使用本地工具时，连接设备并选择允许访问的目录；需要确认的操作会在任务中提示。',
      );
    const before = employee.published_definition
      ? PlatformEmployeeDefinitionSchema.parse(employee.published_definition)
      : null;
    const diff = Object.keys(definition)
      .filter(
        (key) =>
          runtimePolicyDigest(
            before?.[key as keyof typeof definition] ?? null,
          ) !== runtimePolicyDigest(definition[key as keyof typeof definition]),
      )
      .map((key) => ({
        field: key,
        before: before?.[key as keyof typeof definition] ?? null,
        after: definition[key as keyof typeof definition],
      }));
    return {
      employeeId,
      revisionId: employee.revision_id as string,
      publishedRevisionId: employee.current_published_revision_id as
        string | null,
      packageChecksum: checksum,
      targets: policies,
      tools,
      diff,
      errors,
      warnings,
      valid: errors.length === 0,
      policyVersions: Object.fromEntries(targets.map((t) => [t.id, t.version])),
    };
  });
}
