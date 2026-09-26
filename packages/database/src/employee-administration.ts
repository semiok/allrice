import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  employeeToolCatalog,
  rapidEmployeeIterationEnabled,
  employeePublicationPolicy,
  resolveEmployeeToolDependencies,
  type EmployeeToolService,
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
  const services: Record<EmployeeToolService, () => boolean> = {
    assistants: assistantRuntimeEnabled,
    workbench: workbenchEnabled,
    changeset: changesetFeatureEnabled,
    local_command: localCommandFeatureEnabled,
    local_service: localServiceFeatureEnabled,
    cloud_execution: cloudExecutionEnabled,
    cloud_mcp: mcpExecutionEnabled,
    local_mcp: localMcpEnabled,
    cloud_browser: browserControlEnabled,
    local_browser: localBrowserEnabled,
    local_preview: localPreviewEnabled,
    cloud_runner: () => runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED'),
  };
  return employeeToolCatalog.map((tool) => ({
    ...tool,
    released: (tool.requirements.services ?? []).every((service) =>
      services[service](),
    ),
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
    const missing = resolveEmployeeToolDependencies(
      definition.capabilities.toolNames,
    ).filter((name) => !definition.capabilities.toolNames.includes(name));
    if (missing.length)
      warnings.push(`完整工作流程尚缺工具：${missing.join('、')}。`);
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
    for (const tool of tools)
      if (tool.requirements.setupHint)
        warnings.push(tool.requirements.setupHint);
    // Registry hints only: a registered target never proves a user's current
    // device grant, liveness, sandbox, connector or per-operation authorization.
    const requiredKinds = [
      ...new Set(
        tools.flatMap((tool) =>
          tool.environment === 'device'
            ? ['rice_bridge']
            : tool.environment === 'cloud'
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
            `${target.organizationName} / ${target.name}：${kind === 'rice_bridge' ? '使用本地能力时，请在设置 → 我的电脑连接 Bridge 并选择所需目录' : '云端执行环境尚未登记，请在能力与环境查看自动准备状态；实际就绪后即可使用'}。`,
          );
        else
          warnings.push(
            `${target.organizationName} / ${target.name}：${kind === 'rice_bridge' ? '电脑' : '云端环境'}已登记；实际连接与准备状态以成员工作台的能力与环境为准。`,
          );
      }
    for (const tool of tools)
      if (!tool.released)
        (rapidIteration ? errors : warnings).push(
          `${tool.label}：执行服务当前已暂停，恢复后即可发布使用。`,
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
            `${target.organizationName} / ${target.name}：${action.action} 当前${action.effect === 'deny' ? '策略禁止' : '策略不满足执行条件'}（${action.reason}），请检查该租户的执行设置${action.action === 'assistant.delegate' ? '；助手委派需要允许执行' : ''}。`,
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
