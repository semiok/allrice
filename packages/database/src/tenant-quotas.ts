import { randomUUID } from 'node:crypto';
import {
  TenantQuotaChangeSchema,
  type AdminTenantQuota,
  type AdminTenantQuotas,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  defaultResourceLimits,
  getOrganizationModelQuota,
  resourceStatus,
} from './providers/model-governance.ts';
import {
  requireTenantManagementScope,
  type TenantManagementTarget,
  type ManagementSql,
} from './tenant-management-scope.ts';

export class TenantQuotaConflict extends Error {}
async function snapshot(
  target: TenantManagementTarget,
  sql: ManagementSql,
): Promise<AdminTenantQuotas> {
  const { organizationId, workspaceId, subjectId } = target;
  const [period] = await sql<
    { start: Date; end: Date }[]
  >`select date_trunc('month',now()) as start,date_trunc('month',now())+interval '1 month' as end`;
  const quotas: AdminTenantQuota[] = [];
  for (const scope of ['organization', 'tenant', 'user'] as const) {
    const scopeId = scope === 'user' ? subjectId : organizationId;
    const [row] =
      scope === 'organization'
        ? await sql`select *,md5(to_jsonb(q)::text) as version from allrice_organization_model_quotas q where organization_id=${organizationId}`
        : await sql`select *,md5(to_jsonb(q)::text) as version from allrice_model_resource_limits q
          where scope_type=${scope} and scope_id=${scopeId} and (organization_id=${organizationId} or organization_id is null)
          order by organization_id nulls last limit 1`;
    const override = row && row.organization_id === organizationId;
    const actual =
      scope === 'organization'
        ? await getOrganizationModelQuota(organizationId, sql)
        : await resourceStatus(
            { organizationId, workspaceId, scope, scopeId },
            sql,
          );
    const [usage] = await sql<
      { cached: string | null; unknown: number; reserved: string }[]
    >`
      select case when coalesce(bool_and(l.cache_usage_known),true) then coalesce(sum(l.cached_input_tokens),0)::text else null end as cached,
        count(*) filter(where not l.usage_complete)::int as unknown,coalesce(sum(b.reserved_tokens),0)::text as reserved
      from allrice_model_usage_ledger l join allrice_route_decisions d on d.id=l.route_decision_id
      left join allrice_subscription_usage_budget_reviews b on b.route_decision_id=l.route_decision_id
      where l.organization_id=${organizationId} and l.occurred_at>=date_trunc('month',now())
        and (${scope}='organization' or l.workspace_id=${workspaceId}) and (${scope}<>'user' or d.actor_id=${subjectId})`;
    const defaults =
      defaultResourceLimits[scope === 'organization' ? 'tenant' : scope];
    quotas.push({
      scope,
      scopeId,
      version: override ? (row.version as string) : null,
      source: override
        ? 'tenant_override'
        : row
          ? 'platform_override'
          : 'platform_default',
      effective: {
        monthlyRunLimit: actual.monthlyRunLimit,
        monthlyTokenLimit: actual.monthlyTokenLimit,
        concurrentRunLimit:
          'concurrentRunLimit' in actual
            ? actual.concurrentRunLimit
            : defaults.concurrentRunLimit,
        maxRuntimeMs:
          'maxRuntimeMs' in actual
            ? actual.maxRuntimeMs
            : defaults.maxRuntimeMs,
      },
      usedRuns: actual.usedRuns,
      usedTokens: actual.usedTokens,
      cachedInputTokens: usage!.cached === null ? null : Number(usage!.cached),
      reservedTokens: Number(usage!.reserved),
      unknownUsageRuns: usage!.unknown,
      activeRuns: 'activeRuns' in actual ? actual.activeRuns : null,
      usageScope: scope === 'organization' ? 'organization' : 'workspace',
    });
  }
  return {
    ...target,
    periodStart: period!.start.toISOString(),
    resetsAt: period!.end.toISOString(),
    quotas,
    subscription: {
      status: 'not_queried',
      message:
        '此页是 AllRice 内部月额度；Codex 官方窗口需按实际订阅账号查询，不能由 Token 推算。',
    },
  };
}
export async function getAdminTenantQuotas(
  context: RequestContext,
  target: TenantManagementTarget,
  db = getDatabase(),
) {
  return db.begin('isolation level repeatable read read only', async (sql) => {
    const scope = await requireTenantManagementScope(context, target, sql);
    return snapshot(
      {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        subjectId: scope.subjectId,
      },
      sql,
    );
  });
}
export async function updateAdminTenantQuota(
  context: RequestContext,
  organizationId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const change = TenantQuotaChangeSchema.parse(raw),
    target = {
      organizationId,
      workspaceId: change.workspaceId,
      subjectId: change.subjectId,
    };
  return db.begin(async (sql) => {
    await requireTenantManagementScope(context, target, sql);
    // One organization lock serializes absent-row overrides as well as resets.
    await sql`select id from allrice_organizations where id=${organizationId} for update`;
    const scopeId = change.scope === 'user' ? change.subjectId : organizationId;
    if (change.scope === 'organization')
      await sql`select organization_id from allrice_organization_model_quotas where organization_id=${organizationId} for update`;
    else
      await sql`select id from allrice_model_resource_limits where organization_id=${organizationId} and scope_type=${change.scope} and scope_id=${scopeId} for update`;
    const before = (await snapshot(target, sql)).quotas.find(
      (q) => q.scope === change.scope,
    )!;
    if (before.version !== change.expectedVersion)
      throw new TenantQuotaConflict('quota_conflict');
    if (change.scope === 'organization') {
      if (!change.limits) throw new DataAccessError('grant_invalid');
      await sql`insert into allrice_organization_model_quotas(organization_id,monthly_run_limit,monthly_token_limit,updated_by)
        values(${organizationId},${change.limits.monthlyRunLimit},${change.limits.monthlyTokenLimit},${context.actor.id})
        on conflict(organization_id) do update set monthly_run_limit=excluded.monthly_run_limit,monthly_token_limit=excluded.monthly_token_limit,updated_by=excluded.updated_by,updated_at=clock_timestamp()`;
    } else if (!change.limits) {
      await sql`delete from allrice_model_resource_limits where organization_id=${organizationId} and scope_type=${change.scope} and scope_id=${scopeId}`;
    } else {
      const l = change.limits;
      await sql`insert into allrice_model_resource_limits(id,organization_id,scope_type,scope_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms,updated_by)
        values(${randomUUID()},${organizationId},${change.scope},${scopeId},${l.monthlyRunLimit},${l.monthlyTokenLimit},${l.concurrentRunLimit},${l.maxRuntimeMs},${context.actor.id})
        on conflict(organization_id,scope_type,scope_id) where organization_id is not null do update set
          monthly_run_limit=excluded.monthly_run_limit,monthly_token_limit=excluded.monthly_token_limit,concurrent_run_limit=excluded.concurrent_run_limit,max_runtime_ms=excluded.max_runtime_ms,updated_by=excluded.updated_by,updated_at=clock_timestamp()`;
    }
    const after = await snapshot(target, sql);
    await sql`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${change.workspaceId},${context.actor.id},'tenant.quota.updated','model_quota',${scopeId},'recorded',${change.reason},
      ${sql.json({ targetUserId: change.subjectId, scope: change.scope, before: { ...before }, after: { ...after.quotas.find((q) => q.scope === change.scope)! }, ledgerChanged: false, officialQuotaChanged: false })})`;
    return after;
  });
}
