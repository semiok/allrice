import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import {
  OrganizationModelQuotaSchema,
  ModelResourceStatusSchema,
  ProviderReleaseControlSchema,
  ProviderGovernanceSchema,
  UpdateOrganizationModelQuotaInputSchema,
  UpdateProviderGovernanceInputSchema,
  UuidSchema,
  UserMonthlyQuotaSchema,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { codexTokenPolicy, observeCodexTokens } from '../codex-token-policy.ts';
import { isPlatformAdmin } from './model-pool.ts';
import {
  usageBudgetReviewMatches,
  listUnknownSubscriptionUsage,
} from './usage-budget-review.ts';

type GovernanceSql = ReturnType<typeof getDatabase> | postgres.TransactionSql;

const defaultMonthlyRunLimit = 10_000;
const defaultMonthlyTokenLimit = 10_000_000;
const defaultMonthlyCostLimitCents = 1_000_000;

interface ProviderGovernanceRow {
  kill_switch: boolean | null;
  circuit_state: 'closed' | 'open' | 'half_open' | null;
  consecutive_failures: number | null;
  opened_until: Date | null;
  last_error_code: string | null;
  updated_at: Date | null;
  release_stage: 'experimental' | 'canary' | 'production' | 'disabled' | null;
  production_approved: boolean | null;
  allowlisted_organization_ids: string[] | null;
}

export class ModelGovernanceError extends Error {
  constructor(
    public readonly code:
      | 'MODEL_RUN_QUOTA_EXCEEDED'
      | 'MODEL_TOKEN_QUOTA_EXCEEDED'
      | 'MODEL_COST_QUOTA_EXCEEDED'
      | 'MODEL_COST_USAGE_UNKNOWN'
      | 'MODEL_TOKEN_USAGE_UNKNOWN'
      | 'PROVIDER_KILL_SWITCH'
      | 'PROVIDER_CIRCUIT_OPEN'
      | 'MODEL_REQUEST_QUOTA_EXCEEDED'
      | 'MODEL_RESOURCE_CONCURRENCY_EXCEEDED'
      | 'MODEL_RUNTIME_LIMIT_EXCEEDED'
      | 'PROVIDER_NOT_RELEASED',
    public readonly scope?: 'tenant' | 'user' | 'employee' | 'provider',
  ) {
    super(code);
  }
}

export const defaultResourceLimits = {
  tenant: {
    monthlyRunLimit: 10_000,
    monthlyTokenLimit: 10_000_000,
    concurrentRunLimit: 20,
    maxRuntimeMs: 3_600_000,
  },
  user: {
    monthlyRunLimit: 2_000,
    monthlyTokenLimit: 2_000_000,
    concurrentRunLimit: 3,
    maxRuntimeMs: 3_600_000,
  },
  employee: {
    monthlyRunLimit: 5_000,
    monthlyTokenLimit: 5_000_000,
    concurrentRunLimit: 10,
    maxRuntimeMs: 3_600_000,
  },
  provider: {
    monthlyRunLimit: 50_000,
    monthlyTokenLimit: 50_000_000,
    concurrentRunLimit: 25,
    maxRuntimeMs: 3_600_000,
  },
} as const;

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

async function requirePlatformAdmin(context: RequestContext) {
  if (!(await isPlatformAdmin(context))) {
    throw new DataAccessError('authorization_denied');
  }
  return actorId(context);
}

export async function getOrganizationModelQuota(
  organizationId: string,
  sql: GovernanceSql = getDatabase(),
) {
  const id = UuidSchema.parse(organizationId);
  const rows = await sql<
    {
      monthly_run_limit: number | null;
      monthly_token_limit: number | string | null;
      monthly_cost_limit_cents: number | string | null;
      used_runs: number | string;
      used_tokens: number | string;
      used_cost_cents: number | string | null;
      unknown_cost_runs: number;
      subscription_runs: number;
      usage_complete: boolean;
      reserved_token_budget: number | string;
      unknown_usage_runs: number;
      subscription_budget_admission_complete: boolean;
      cache_usage_known: boolean;
      period_start: Date;
    }[]
  >`
    select q.monthly_run_limit, q.monthly_token_limit,
      q.monthly_cost_limit_cents,
      count(l.id)::bigint as used_runs,
      coalesce(sum(l.input_tokens + l.output_tokens), 0)::bigint as used_tokens,
      case when count(l.id) filter (where l.cost_cents is null and s.route_decision_id is null) > 0
        then null else coalesce(sum(l.cost_cents), 0) end as used_cost_cents,
      count(l.id) filter (where l.cost_cents is null and s.route_decision_id is null)::integer as unknown_cost_runs,
      count(l.id) filter (where s.route_decision_id is not null)::integer as subscription_runs,
      coalesce(bool_and(l.usage_complete), true) as usage_complete,
      coalesce(sum(b.reserved_tokens), 0)::bigint as reserved_token_budget,
      count(l.id) filter (where not l.usage_complete)::integer as unknown_usage_runs,
      coalesce(bool_and(l.usage_complete or (${usageBudgetReviewMatches(sql)})), true)
        as subscription_budget_admission_complete,
      coalesce(bool_and(l.cache_usage_known), true) as cache_usage_known,
      date_trunc('month', now()) as period_start
    from (select ${id}::uuid as organization_id) scope
    left join allrice_organization_model_quotas q
      on q.organization_id = scope.organization_id
    left join allrice_model_usage_ledger l
      on l.organization_id = scope.organization_id
      and l.occurred_at >= date_trunc('month', now())
    left join allrice_route_subscription_snapshots s on s.route_decision_id=l.route_decision_id
    left join allrice_subscription_usage_budget_reviews b on b.route_decision_id=l.route_decision_id
    group by q.monthly_run_limit, q.monthly_token_limit,
      q.monthly_cost_limit_cents
  `;
  const row = rows[0]!;
  return OrganizationModelQuotaSchema.parse({
    organizationId: id,
    monthlyRunLimit: row.monthly_run_limit ?? defaultMonthlyRunLimit,
    monthlyTokenLimit: Number(
      row.monthly_token_limit ?? defaultMonthlyTokenLimit,
    ),
    monthlyCostLimitCents: Number(
      row.monthly_cost_limit_cents ?? defaultMonthlyCostLimitCents,
    ),
    usedRuns: Number(row.used_runs),
    usedTokens: Number(row.used_tokens),
    usedCostCents:
      row.used_cost_cents === null ? null : Number(row.used_cost_cents),
    unknownCostRuns: row.unknown_cost_runs,
    subscriptionRuns: row.subscription_runs,
    usageComplete: row.usage_complete,
    reservedTokenBudget: Number(row.reserved_token_budget),
    unknownUsageRuns: row.unknown_usage_runs,
    subscriptionBudgetAdmissionComplete:
      row.subscription_budget_admission_complete,
    cacheUsageKnown: row.cache_usage_known,
    periodStart: row.period_start.toISOString(),
  });
}

export async function getProviderGovernance(connectionId: string) {
  const id = UuidSchema.parse(connectionId);
  const sql = getDatabase();
  const rows = await sql<ProviderGovernanceRow[]>`
    select b.kill_switch,
      case
        when b.circuit_state = 'open' and b.opened_until <= now() then 'half_open'
        else b.circuit_state
      end as circuit_state,
      b.consecutive_failures, b.opened_until, b.last_error_code, b.updated_at,
      r.release_stage, r.production_approved, r.allowlisted_organization_ids
    from allrice_model_connections c
    left join allrice_provider_circuit_breakers b on b.connection_id = c.id
    left join allrice_provider_release_controls r on r.connection_id = c.id
    where c.id = ${id}
  `;
  return mapProviderGovernanceRow(id, rows[0]);
}

export function mapProviderGovernanceRow(
  connectionId: string,
  row?: ProviderGovernanceRow,
) {
  return ProviderGovernanceSchema.parse({
    connectionId,
    killSwitch: row?.kill_switch ?? false,
    circuitState: row?.circuit_state ?? 'closed',
    consecutiveFailures: row?.consecutive_failures ?? 0,
    openedUntil: row?.opened_until?.toISOString() ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    // Both governance tables are left joins. A connection is valid before its
    // first circuit/release row exists, so the timestamp is nullable too.
    updatedAt: row?.updated_at?.toISOString() ?? null,
    releaseStage: row?.release_stage ?? 'experimental',
    productionApproved: row?.production_approved ?? false,
    allowlistedOrganizationIds: row?.allowlisted_organization_ids ?? [],
  });
}

export async function getModelGovernanceSnapshot(input: {
  organizationId: string;
  connectionIds: string[];
}) {
  const quota = await getOrganizationModelQuota(input.organizationId);
  const providers = await Promise.all(
    [...new Set(input.connectionIds)].map(getProviderGovernance),
  );
  return { quota, providers };
}

export function assertQuotaAvailable(
  quota: Omit<
    Awaited<ReturnType<typeof getOrganizationModelQuota>>,
    | 'subscriptionRuns'
    | 'reservedTokenBudget'
    | 'unknownUsageRuns'
    | 'subscriptionBudgetAdmissionComplete'
  > & {
    reservedTokenBudget?: number;
    subscriptionBudgetAdmissionComplete?: boolean;
  },
  billingMode: 'token_metered' | 'subscription' = 'token_metered',
  requestedTokens = 0,
) {
  if (
    billingMode !== 'subscription' &&
    quota.usedRuns >= quota.monthlyRunLimit
  ) {
    throw new ModelGovernanceError('MODEL_RUN_QUOTA_EXCEEDED');
  }
  // Missing receipts remain unknown in the ledger, not an account-wide lock.
  if (observeCodexTokens(billingMode === 'subscription')) return;
  if (
    quota.usedTokens + (quota.reservedTokenBudget ?? 0) >=
      quota.monthlyTokenLimit ||
    quota.usedTokens + (quota.reservedTokenBudget ?? 0) + requestedTokens >
      quota.monthlyTokenLimit
  ) {
    throw new ModelGovernanceError('MODEL_TOKEN_QUOTA_EXCEEDED');
  }
  if (
    !quota.usageComplete &&
    !(
      billingMode === 'subscription' &&
      quota.subscriptionBudgetAdmissionComplete === true
    )
  )
    throw new ModelGovernanceError('MODEL_TOKEN_USAGE_UNKNOWN');
  // Only the caller's verified subscription route can omit cash admission.
  // Only separately approved terminal subscription exceptions allow unknown
  // usage. Their organization budget holds are additional to known tokens;
  // actual usage stays incomplete. Orphan/lease/resource checks still apply.
  if (billingMode === 'subscription') return;
  if (quota.usedCostCents === null || quota.unknownCostRuns > 0)
    throw new ModelGovernanceError('MODEL_COST_USAGE_UNKNOWN');
  if (quota.usedCostCents >= quota.monthlyCostLimitCents) {
    throw new ModelGovernanceError('MODEL_COST_QUOTA_EXCEEDED');
  }
}

export function assertProviderAvailable(
  provider: Awaited<ReturnType<typeof getProviderGovernance>>,
) {
  if (provider.killSwitch) {
    throw new ModelGovernanceError('PROVIDER_KILL_SWITCH');
  }
  if (provider.circuitState === 'open') {
    throw new ModelGovernanceError('PROVIDER_CIRCUIT_OPEN');
  }
}

export async function updateProviderGovernance(input: {
  context: RequestContext;
  connectionId: string;
  update: unknown;
}) {
  const updatedBy = await requirePlatformAdmin(input.context);
  const connectionId = UuidSchema.parse(input.connectionId);
  const update = UpdateProviderGovernanceInputSchema.parse(input.update);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const connections = await transaction<{ id: string }[]>`
      select id from allrice_model_connections
      where id = ${connectionId} and scope = 'platform'
    `;
    if (!connections[0]) throw new DataAccessError('not_found');
    await transaction`
      insert into allrice_provider_circuit_breakers (
        connection_id, kill_switch, circuit_state, consecutive_failures,
        opened_until, last_error_code, updated_by
      ) values (
        ${connectionId}, ${update.killSwitch ?? false}, 'closed', 0,
        null, null, ${updatedBy}
      ) on conflict (connection_id) do update set
        kill_switch = coalesce(
          ${update.killSwitch ?? null},
          allrice_provider_circuit_breakers.kill_switch
        ),
        circuit_state = case
          when ${update.resetCircuit === true} then 'closed'
          else allrice_provider_circuit_breakers.circuit_state
        end,
        consecutive_failures = case
          when ${update.resetCircuit === true} then 0
          else allrice_provider_circuit_breakers.consecutive_failures
        end,
        opened_until = case
          when ${update.resetCircuit === true} then null
          else allrice_provider_circuit_breakers.opened_until
        end,
        last_error_code = case
          when ${update.resetCircuit === true} then null
          else allrice_provider_circuit_breakers.last_error_code
        end,
        updated_by = ${updatedBy}, updated_at = now()
    `;
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${input.context.organizationId}, ${input.context.workspaceId},
        ${updatedBy}, 'provider_governance.update', 'model_connection',
        ${connectionId}, 'recorded', 'platform_admin',
        ${input.context.requestId}, ${transaction.json(update)}
      )
    `;
    if (update.killSwitch !== undefined) {
      await transaction`
        insert into allrice_operational_incidents (
          id, connection_id, kind, severity, detail_code, metadata
        ) values (
          ${randomUUID()}, ${connectionId}, 'kill_switch',
          ${update.killSwitch ? 'critical' : 'info'},
          ${update.killSwitch ? 'platform_kill_switch_enabled' : 'platform_kill_switch_disabled'},
          ${transaction.json({ updatedBy })}
        )
      `;
    }
    if (
      update.releaseStage !== undefined ||
      update.productionApproved !== undefined ||
      update.allowlistedOrganizationIds !== undefined
    ) {
      await transaction`
        insert into allrice_provider_release_controls (
          connection_id, release_stage, allowlisted_organization_ids,
          production_approved, approved_by, approved_at
        ) values (
          ${connectionId}, ${update.releaseStage ?? 'experimental'},
          ${update.allowlistedOrganizationIds ?? []},
          ${update.productionApproved ?? false}, ${updatedBy},
          ${update.productionApproved ? new Date() : null}
        ) on conflict (connection_id) do update set
          release_stage = coalesce(
            ${update.releaseStage ?? null},
            allrice_provider_release_controls.release_stage
          ),
          allowlisted_organization_ids = coalesce(
            ${update.allowlistedOrganizationIds ?? null},
            allrice_provider_release_controls.allowlisted_organization_ids
          ),
          production_approved = coalesce(
            ${update.productionApproved ?? null},
            allrice_provider_release_controls.production_approved
          ),
          approved_by = ${updatedBy},
          approved_at = case
            when ${update.productionApproved === true} then now()
            when ${update.productionApproved === false} then null
            else allrice_provider_release_controls.approved_at
          end,
          updated_at = now()
      `;
    }
  });
  return getProviderGovernance(connectionId);
}

export async function updateOrganizationModelQuota(input: {
  context: RequestContext;
  update: unknown;
}) {
  const updatedBy = await requirePlatformAdmin(input.context);
  const update = UpdateOrganizationModelQuotaInputSchema.parse(input.update);
  const sql = getDatabase();
  await sql`
    insert into allrice_organization_model_quotas (
      organization_id, monthly_run_limit, monthly_token_limit,
      monthly_cost_limit_cents, updated_by
    ) values (
      ${input.context.organizationId}, ${update.monthlyRunLimit},
      ${update.monthlyTokenLimit}, ${update.monthlyCostLimitCents}, ${updatedBy}
    ) on conflict (organization_id) do update set
      monthly_run_limit = excluded.monthly_run_limit,
      monthly_token_limit = excluded.monthly_token_limit,
      monthly_cost_limit_cents = excluded.monthly_cost_limit_cents,
      updated_by = excluded.updated_by, updated_at = now()
  `;
  return getOrganizationModelQuota(input.context.organizationId);
}

export async function resourceStatus(
  input: {
    organizationId: string;
    workspaceId: string;
    scope: 'tenant' | 'user' | 'employee' | 'provider';
    scopeId: string;
  },
  sql: GovernanceSql = getDatabase(),
) {
  const limitRows = await sql<
    {
      monthly_run_limit: number;
      monthly_token_limit: number | string;
      concurrent_run_limit: number;
      max_runtime_ms: number;
    }[]
  >`
    select monthly_run_limit, monthly_token_limit,
      concurrent_run_limit, max_runtime_ms
    from allrice_model_resource_limits
    where scope_type = ${input.scope} and scope_id = ${input.scopeId}
      and (organization_id=${input.organizationId} or organization_id is null)
    order by organization_id nulls last limit 1
  `;
  const usageFilter =
    input.scope === 'tenant'
      ? sql`true`
      : input.scope === 'user'
        ? sql`d.actor_id = ${input.scopeId}`
        : input.scope === 'employee'
          ? sql`d.employee_id = ${input.scopeId}`
          : sql`l.connection_id = ${input.scopeId}`;
  const usage = await sql<
    { used_runs: number; used_tokens: number | string }[]
  >`
    select count(l.id)::integer as used_runs,
      coalesce(sum(l.input_tokens + l.output_tokens), 0)::bigint as used_tokens
    from allrice_model_usage_ledger l
    join allrice_route_decisions d on d.id = l.route_decision_id
    where l.organization_id = ${input.organizationId}
      and l.workspace_id = ${input.workspaceId}
      and l.occurred_at >= date_trunc('month', now())
      and ${usageFilter}
  `;
  const active =
    input.scope === 'tenant'
      ? await sql<{ count: number }[]>`
          select count(*)::integer as count from allrice_jobs
          where organization_id = ${input.organizationId}
            and status in ('claimed', 'running', 'waiting_approval')
        `
      : input.scope === 'user'
        ? await sql<{ count: number }[]>`
            select count(*)::integer as count from allrice_jobs
            where organization_id = ${input.organizationId}
              and workspace_id = ${input.workspaceId}
              and owner_id = ${input.scopeId}
              and status in ('claimed', 'running', 'waiting_approval')
          `
        : input.scope === 'employee'
          ? await sql<{ count: number }[]>`
              select count(*)::integer as count from allrice_employee_runs
              where organization_id = ${input.organizationId}
                and workspace_id = ${input.workspaceId}
                and (execution_snapshot -> 'employee' ->> 'id')::uuid = ${input.scopeId}
                and status in ('queued', 'running')
            `
          : await sql<{ count: number }[]>`
              select count(distinct j.id)::integer as count
              from allrice_jobs j
              join allrice_route_decisions d on d.run_id = j.run_id
              where j.organization_id = ${input.organizationId}
                and j.workspace_id = ${input.workspaceId}
                and d.model_connection_id = ${input.scopeId}
                and j.status in ('claimed', 'running', 'waiting_approval')
            `;
  const defaults = defaultResourceLimits[input.scope];
  const limits = limitRows[0];
  return ModelResourceStatusSchema.parse({
    scope: input.scope,
    scopeId: input.scopeId,
    monthlyRunLimit: limits?.monthly_run_limit ?? defaults.monthlyRunLimit,
    monthlyTokenLimit: Number(
      limits?.monthly_token_limit ?? defaults.monthlyTokenLimit,
    ),
    concurrentRunLimit:
      limits?.concurrent_run_limit ?? defaults.concurrentRunLimit,
    maxRuntimeMs: limits?.max_runtime_ms ?? defaults.maxRuntimeMs,
    usedRuns: usage[0]?.used_runs ?? 0,
    usedTokens: Number(usage[0]?.used_tokens ?? 0),
    activeRuns: active[0]?.count ?? 0,
  });
}

/** Actor-scoped read model, using exactly the user resource admission accounting.
 * No client-supplied user ID or cached role can widen this read. */
export async function getUserMonthlyQuota(
  context: RequestContext,
  workspaceInput: string,
  database = getDatabase(),
) {
  const userId = actorId(context);
  const workspaceId = UuidSchema.parse(workspaceInput);
  return database.begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const [viewer] = await sql<{ display_name: string }[]>`
      select u.display_name from allrice_users u
      join allrice_memberships m on m.user_id=u.id and m.active
      join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
      join allrice_workspaces w on w.organization_id=o.id and w.archived_at is null
      where u.id=${userId} and u.status='active'
        and o.id=${context.organizationId} and w.id=${workspaceId}
        and (m.workspace_id is null or m.workspace_id=w.id)
      limit 1`;
      if (!viewer) throw new DataAccessError('authorization_denied');
      const quota = await resourceStatus(
        {
          organizationId: context.organizationId,
          workspaceId,
          scope: 'user',
          scopeId: userId,
        },
        sql,
      );
      const [period] = await sql<
        {
          period_start: Date;
          resets_at: Date;
          observed_at: Date;
          unknown_runs: number;
          cached: string | null;
        }[]
      >`
      select date_trunc('month', now()) as period_start,
        date_trunc('month', now()) + interval '1 month' as resets_at,
        now() as observed_at, count(*) filter(where not l.usage_complete)::integer as unknown_runs,
        case when coalesce(bool_and(l.cache_usage_known),true) then coalesce(sum(l.cached_input_tokens),0)::text else null end as cached
      from allrice_model_usage_ledger l
      join allrice_route_decisions d on d.id=l.route_decision_id
      where l.organization_id=${context.organizationId} and l.workspace_id=${workspaceId}
        and d.actor_id=${userId} and l.occurred_at>=date_trunc('month', now())
        `;
      const remainingTokens = Math.max(
        0,
        quota.monthlyTokenLimit - quota.usedTokens,
      );
      return UserMonthlyQuotaSchema.parse({
        organizationId: context.organizationId,
        workspaceId,
        userId,
        displayName: viewer.display_name || '当前账号',
        monthlyTokenLimit: quota.monthlyTokenLimit,
        usedTokens: quota.usedTokens,
        codexTokenPolicy: codexTokenPolicy(),
        cachedInputTokens:
          period!.cached === null ? null : Number(period!.cached),
        remainingTokens,
        remainingPercent: (remainingTokens / quota.monthlyTokenLimit) * 100,
        unknownUsageRuns: period!.unknown_runs,
        periodStart: period!.period_start.toISOString(),
        resetsAt: period!.resets_at.toISOString(),
        observedAt: period!.observed_at.toISOString(),
      });
    },
  );
}

export function assertModelResourceAvailable(input: {
  resources: Awaited<ReturnType<typeof resourceStatus>>[];
  requestedTokens: number;
  requestedRuntimeMs: number;
  billingMode?: 'token_metered' | 'subscription';
}) {
  for (const resource of input.resources) {
    if (
      input.billingMode !== 'subscription' &&
      resource.usedRuns >= resource.monthlyRunLimit
    ) {
      throw new ModelGovernanceError(
        'MODEL_REQUEST_QUOTA_EXCEEDED',
        resource.scope,
      );
    }
    if (
      !observeCodexTokens(input.billingMode === 'subscription') &&
      resource.usedTokens + input.requestedTokens > resource.monthlyTokenLimit
    ) {
      throw new ModelGovernanceError(
        'MODEL_TOKEN_QUOTA_EXCEEDED',
        resource.scope,
      );
    }
    if (resource.activeRuns >= resource.concurrentRunLimit) {
      throw new ModelGovernanceError(
        'MODEL_RESOURCE_CONCURRENCY_EXCEEDED',
        resource.scope,
      );
    }
    if (
      resource.maxRuntimeMs > 0 &&
      input.requestedRuntimeMs > 0 &&
      input.requestedRuntimeMs > resource.maxRuntimeMs
    ) {
      throw new ModelGovernanceError(
        'MODEL_RUNTIME_LIMIT_EXCEEDED',
        resource.scope,
      );
    }
  }
}

/** Closed/invalid roots can outlive a crashed Worker's monthly projection.
 * Read their durable dispatched-call holds, never a raw provider error or every
 * positive reservation. Live bounded in-flight work and undispatched preparation
 * remain admissible; this query neither settles holds nor acquires runtime locks.
 */
async function assertNoOrphanedAssistantUsage(
  organizationId: string,
  sql: postgres.TransactionSql,
) {
  const [unknown] = await sql`
    select 1 from allrice_runtime_roots rt
    join allrice_assistant_roots ar on ar.root_run_id=rt.root_run_id
    join allrice_runs r on r.id=rt.root_run_id
      and r.organization_id=rt.organization_id and r.workspace_id=rt.workspace_id
    join allrice_assistant_model_admissions a on a.root_run_id=rt.root_run_id
    join allrice_assistant_usage u on u.root_run_id=a.root_run_id
      and u.run_id=a.run_id and u.call_id=a.call_id
    left join allrice_assistant_instances main on main.run_id=rt.root_run_id
      and main.root_run_id=rt.root_run_id
    left join allrice_jobs j on j.id=ar.worker_job_id and j.run_id=rt.root_run_id
      and j.organization_id=rt.organization_id and j.workspace_id=rt.workspace_id
    where rt.organization_id=${organizationId}
      and a.dispatched_at is not null
      and u.metric in ('input_tokens','output_tokens')
      and u.amount>0 and u.settled_amount is null
      and (
        rt.cancel_request_id is not null or rt.deadline_at<=clock_timestamp()
        or ar.revoked_at is not null
        or r.state not in ('queued','running','waiting_approval')
        or main.run_id is null or main.stopped_at is not null
        or main.status in ('completed','partial','failed','canceled','unknown')
        or j.id is null or j.status<>'running'
        or j.cancel_requested_at is not null or j.timeout_at<=clock_timestamp()
        or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()
        or j.worker_id is distinct from ar.worker_id or j.lease_token is null
        or ar.worker_lease_digest is distinct from
          ('sha256:' || encode(sha256(convert_to(to_json(j.lease_token)::text,'UTF8')),'hex'))
      )
    limit 1
  `;
  if (unknown) throw new ModelGovernanceError('MODEL_TOKEN_USAGE_UNKNOWN');
}

export async function admitModelExecution(input: {
  organizationId: string;
  workspaceId: string;
  userId: string;
  employeeId: string;
  connectionId: string;
  requestedTokens: number;
  requestedRuntimeMs: number;
}) {
  const values = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    userId: UuidSchema.parse(input.userId),
    employeeId: UuidSchema.parse(input.employeeId),
    connectionId: UuidSchema.parse(input.connectionId),
    requestedTokens: input.requestedTokens,
    requestedRuntimeMs: input.requestedRuntimeMs,
  };
  const scopes = [
    ['tenant', values.organizationId],
    ['user', values.userId],
    ['employee', values.employeeId],
    ['provider', values.connectionId],
  ] as const;
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    for (const [scope, scopeId] of scopes) {
      await transaction`
        select pg_advisory_xact_lock(hashtext(${`${scope}:${scopeId.toLowerCase()}`}))
      `;
    }
    // This transaction is the new-Run admission boundary. RouteOutcome writers
    // take the same tenant lock before their route row lock. Re-read after any
    // wait; a previously captured UI/Worker quota is not admission authority.
    // Already admitted live bounded Runs are not retroactively canceled here.
    // Derive from the actual selected server connection, never request input.
    // Missing/unsupported identities get no exemption; frozen-route validation
    // still runs before Worker dispatch and durable subscription settlement.
    const [billing] = await transaction<{ subscription: boolean }[]>`
      select p.auth_mode='chatgpt_subscription' and p.provider_key in ('codex','openai-codex')
        and c.base_url is null and c.credential_reference is not null as subscription
      from allrice_model_connections c join allrice_model_providers p on p.id=c.provider_id
      where c.id=${values.connectionId} and (c.scope='platform' or c.organization_id=${values.organizationId})`;
    assertQuotaAvailable(
      await getOrganizationModelQuota(values.organizationId, transaction),
      billing?.subscription === true ? 'subscription' : 'token_metered',
      values.requestedTokens,
    );
    if (!observeCodexTokens(billing?.subscription === true))
      await assertNoOrphanedAssistantUsage(values.organizationId, transaction);
    const resources = await Promise.all(
      scopes.map(([scope, scopeId]) =>
        resourceStatus(
          {
            organizationId: values.organizationId,
            workspaceId: values.workspaceId,
            scope,
            scopeId,
          },
          transaction,
        ),
      ),
    );
    assertModelResourceAvailable({
      resources,
      billingMode:
        billing?.subscription === true ? 'subscription' : 'token_metered',
      requestedTokens: values.requestedTokens,
      requestedRuntimeMs: values.requestedRuntimeMs,
    });
    const releases = await transaction<
      {
        release_stage: 'experimental' | 'canary' | 'production' | 'disabled';
        allowlisted_organization_ids: string[];
        production_approved: boolean;
      }[]
    >`
      select release_stage, allowlisted_organization_ids, production_approved
      from allrice_provider_release_controls
      where connection_id = ${values.connectionId}
    `;
    const release = releases[0];
    if (release) {
      ProviderReleaseControlSchema.parse({
        connectionId: values.connectionId,
        releaseStage: release.release_stage,
        allowlistedOrganizationIds: release.allowlisted_organization_ids,
        productionApproved: release.production_approved,
      });
      const allowed =
        release.release_stage !== 'disabled' &&
        (process.env.ALLRICE_ENV !== 'production' ||
          (release.release_stage === 'production' &&
            release.production_approved) ||
          release.allowlisted_organization_ids.includes(values.organizationId));
      if (!allowed) {
        throw new ModelGovernanceError('PROVIDER_NOT_RELEASED', 'provider');
      }
    }
    return resources;
  });
}

export async function getModelGovernanceForAdmin(context: RequestContext) {
  await requirePlatformAdmin(context);
  const sql = getDatabase();
  const connections = await sql<{ id: string }[]>`
    select id from allrice_model_connections
    where scope = 'platform' order by priority, id
  `;
  const snapshot = await getModelGovernanceSnapshot({
    organizationId: context.organizationId,
    connectionIds: connections.map((row) => row.id),
  });
  const unknownUsage = await listUnknownSubscriptionUsage(context);
  const [operations, resourceLimits, incidents] = await Promise.all([
    sql<
      {
        connection_id: string;
        release_stage: 'experimental' | 'canary' | 'production' | 'disabled';
        production_approved: boolean;
        allowlisted_organization_ids: string[];
        runs: number;
        failures: number;
        fallbacks: number;
        average_latency_ms: number | string;
        input_tokens: number | string;
        output_tokens: number | string;
        cost_cents: number | string | null;
        unknown_cost_runs: number;
        subscription_runs: number;
        usage_complete: boolean;
      }[]
    >`
      select c.id as connection_id,
        coalesce(rc.release_stage, 'experimental') as release_stage,
        coalesce(rc.production_approved, false) as production_approved,
        coalesce(rc.allowlisted_organization_ids, '{}') as allowlisted_organization_ids,
        count(d.id)::integer as runs,
        count(d.id) filter (where d.status = 'failed')::integer as failures,
        count(d.id) filter (where d.fallback_from_decision_id is not null)::integer as fallbacks,
        coalesce(avg(extract(epoch from (d.completed_at - d.created_at)) * 1000), 0) as average_latency_ms,
        coalesce(sum(d.input_tokens), 0)::bigint as input_tokens,
        coalesce(sum(d.output_tokens), 0)::bigint as output_tokens,
        case when count(d.id) filter (where d.cost_cents is null and s.route_decision_id is null) > 0
          then null else coalesce(sum(d.cost_cents), 0) end as cost_cents,
        count(d.id) filter (where d.cost_cents is null and s.route_decision_id is null)::integer as unknown_cost_runs,
        count(d.id) filter (where s.route_decision_id is not null)::integer as subscription_runs,
        coalesce(bool_and(d.usage_complete), true) as usage_complete
      from allrice_model_connections c
      left join allrice_provider_release_controls rc on rc.connection_id = c.id
      left join allrice_route_decisions d on d.model_connection_id = c.id
        and d.created_at >= now() - interval '30 days'
      left join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
      where c.scope = 'platform'
      group by c.id, rc.release_stage, rc.production_approved,
        rc.allowlisted_organization_ids
      order by c.priority, c.id
    `,
    sql<
      {
        scope_type: 'tenant' | 'user' | 'employee' | 'provider';
        scope_id: string;
        monthly_run_limit: number;
        monthly_token_limit: number | string;
        concurrent_run_limit: number;
        max_runtime_ms: number;
      }[]
    >`
      select scope_type, scope_id, monthly_run_limit, monthly_token_limit,
        concurrent_run_limit, max_runtime_ms
      from allrice_model_resource_limits
      where organization_id is null
        or organization_id = ${context.organizationId}
      order by scope_type, scope_id
    `,
    sql<
      {
        id: string;
        connection_id: string | null;
        kind: string;
        severity: string;
        detail_code: string;
        created_at: Date;
      }[]
    >`
      select id, connection_id, kind, severity, detail_code, created_at
      from allrice_operational_incidents
      where organization_id is null or organization_id = ${context.organizationId}
      order by created_at desc limit 25
    `,
  ]);
  return {
    ...snapshot,
    codexTokenPolicy: codexTokenPolicy(),
    unknownUsage,
    operations: operations.map((item) => ({
      connectionId: item.connection_id,
      releaseStage: item.release_stage,
      productionApproved: item.production_approved,
      allowlistedOrganizationIds: item.allowlisted_organization_ids,
      runs: item.runs,
      failures: item.failures,
      fallbacks: item.fallbacks,
      averageLatencyMs: Math.round(Number(item.average_latency_ms)),
      inputTokens: Number(item.input_tokens),
      outputTokens: Number(item.output_tokens),
      costCents: item.cost_cents === null ? null : Number(item.cost_cents),
      unknownCostRuns: item.unknown_cost_runs,
      subscriptionRuns: item.subscription_runs,
      usageComplete: item.usage_complete,
    })),
    resourceLimits: resourceLimits.map((item) => ({
      scope: item.scope_type,
      scopeId: item.scope_id,
      monthlyRunLimit: item.monthly_run_limit,
      monthlyTokenLimit: Number(item.monthly_token_limit),
      concurrentRunLimit: item.concurrent_run_limit,
      maxRuntimeMs: item.max_runtime_ms,
    })),
    incidents: incidents.map((item) => ({
      id: item.id,
      connectionId: item.connection_id,
      kind: item.kind,
      severity: item.severity,
      detailCode: item.detail_code,
      createdAt: item.created_at.toISOString(),
    })),
  };
}
