import type postgres from 'postgres';
import {
  ReviewSubscriptionUsageBudgetInputSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { isPlatformAdmin } from './model-pool.ts';

export class UsageBudgetReviewError extends Error {
  constructor(
    public readonly code: 'USAGE_REVIEW_NOT_ELIGIBLE' | 'USAGE_REVIEW_CONFLICT',
  ) {
    super(code);
  }
}

/** Aliases l (ledger), b (review). A changed receipt invalidates approval.
 * The hold is additional organization budget, not a fabricated actual or bound.
 */
export function usageBudgetReviewMatches(
  sql: ReturnType<typeof getDatabase> | postgres.TransactionSql,
) {
  return sql`coalesce(b.ledger_snapshot=to_jsonb(l),false)
    and exists (select 1 from allrice_route_subscription_snapshots proof
      where proof.route_decision_id=l.route_decision_id)
    and exists (select 1 from allrice_route_decisions d join allrice_runs r on r.id=d.run_id
      where d.id=l.route_decision_id and r.state in ('failed','canceled')
      and not exists(select 1 from allrice_jobs j where j.run_id=r.id
        and j.status in ('queued','claimed','running','waiting_approval'))
      and not exists(select 1 from allrice_assistant_roots a where a.root_run_id=r.id)
      and not exists(select 1 from allrice_assistant_instances a where a.run_id=r.id))`;
}

async function requireAdmin(
  context: RequestContext,
  sql: ReturnType<typeof getDatabase>,
) {
  if (!(await isPlatformAdmin(context, sql)))
    throw new DataAccessError('authorization_denied');
  return context.actor.id;
}

export async function listUnknownSubscriptionUsage(
  context: RequestContext,
  sql = getDatabase(),
) {
  await requireAdmin(context, sql);
  const rows = await sql`
    select d.id as decision_id,d.run_id,d.provider,d.model,l.occurred_at,
      d.organization_id,o.name as organization_name,
      l.input_tokens+l.output_tokens as known_tokens,
      exists(select 1 from allrice_route_subscription_snapshots s where s.route_decision_id=d.id) as subscription,
      b.reserved_tokens,b.reason,b.created_at as reviewed_at,
      (${usageBudgetReviewMatches(sql)}) as approved,
      r.state in ('failed','canceled')
        and not exists(select 1 from allrice_jobs j where j.run_id=r.id and j.status in ('queued','claimed','running','waiting_approval'))
        and not exists(select 1 from allrice_assistant_roots a where a.root_run_id=r.id)
        and not exists(select 1 from allrice_assistant_instances a where a.run_id=r.id) as terminal_ordinary
    from allrice_model_usage_ledger l
    join allrice_route_decisions d on d.id=l.route_decision_id
    join allrice_runs r on r.id=d.run_id
    join allrice_organizations o on o.id=d.organization_id
    left join allrice_subscription_usage_budget_reviews b on b.route_decision_id=d.id
    where not l.usage_complete
      and l.occurred_at>=date_trunc('month',now())
    order by l.occurred_at desc limit 100`;
  return rows.map((r) => ({
    decisionId: r.decision_id as string,
    organizationId: r.organization_id as string,
    organizationName: r.organization_name as string,
    runId: r.run_id as string,
    provider: r.provider as string,
    model: r.model as string,
    occurredAt: (r.occurred_at as Date).toISOString(),
    knownTokens: Number(r.known_tokens),
    reservedTokens:
      r.reserved_tokens === null ? null : Number(r.reserved_tokens),
    approved: r.approved === true,
    eligible:
      r.subscription === true &&
      r.terminal_ordinary === true &&
      r.reserved_tokens === null,
    reason: r.reason as string | null,
    reviewedAt: r.reviewed_at ? (r.reviewed_at as Date).toISOString() : null,
  }));
}

/** Platform console is in its own organization. Resolve the selected ledger's
 * tenant on the server, only after authenticating a real platform admin. */
export async function reviewSubscriptionUsageBudgetForAdmin(
  input: { context: RequestContext; review: unknown },
  sql = getDatabase(),
) {
  await requireAdmin(input.context, sql);
  const review = ReviewSubscriptionUsageBudgetInputSchema.parse(input.review);
  const [route] =
    await sql`select organization_id,workspace_id from allrice_route_decisions where id=${review.decisionId}`;
  if (!route) throw new DataAccessError('not_found');
  return reviewSubscriptionUsageBudget(
    {
      context: {
        ...input.context,
        organizationId: route.organization_id as string,
        workspaceId: route.workspace_id as string,
      },
      review,
    },
    sql,
  );
}

export async function reviewSubscriptionUsageBudget(
  input: { context: RequestContext; review: unknown },
  sql = getDatabase(),
) {
  const approvedBy = await requireAdmin(input.context, sql);
  const review = ReviewSubscriptionUsageBudgetInputSchema.parse(input.review);
  return sql.begin(async (tx) => {
    // Same fence/order as admission and ordinary outcome persistence.
    await tx`select pg_advisory_xact_lock(hashtext(${`tenant:${input.context.organizationId.toLowerCase()}`}))`;
    const [route] = await tx`
      select d.id,d.run_id,d.workspace_id,r.state,
        exists(select 1 from allrice_route_subscription_snapshots s where s.route_decision_id=d.id) as subscription,
        (exists(select 1 from allrice_assistant_roots a where a.root_run_id=r.id)
          or exists(select 1 from allrice_assistant_instances a where a.run_id=r.id)) as assistant,
        exists(select 1 from allrice_jobs j where j.run_id=r.id and j.status in ('queued','claimed','running','waiting_approval')) as active
      from allrice_route_decisions d join allrice_runs r on r.id=d.run_id
      where d.id=${review.decisionId} and d.organization_id=${input.context.organizationId}
      for update of d,r`;
    if (!route) throw new DataAccessError('not_found');
    const [ledger] =
      await tx`select to_jsonb(l) as snapshot,l.usage_complete from allrice_model_usage_ledger l where route_decision_id=${route.id} for update`;
    if (
      !ledger ||
      ledger.usage_complete ||
      !route.subscription ||
      route.assistant ||
      route.active ||
      !['failed', 'canceled'].includes(route.state)
    )
      throw new UsageBudgetReviewError('USAGE_REVIEW_NOT_ELIGIBLE');
    const [existing] =
      await tx`select reserved_tokens,reason,ledger_snapshot=${tx.json(ledger.snapshot)} as matches from allrice_subscription_usage_budget_reviews where route_decision_id=${route.id}`;
    if (existing) {
      if (
        Number(existing.reserved_tokens) !== review.reservedTokens ||
        existing.reason !== review.reason ||
        !existing.matches
      )
        throw new UsageBudgetReviewError('USAGE_REVIEW_CONFLICT');
      return {
        decisionId: review.decisionId,
        reservedTokens: review.reservedTokens,
        usageComplete: false,
        replayed: true,
      };
    }
    await tx`insert into allrice_subscription_usage_budget_reviews
      (route_decision_id,organization_id,workspace_id,reserved_tokens,ledger_snapshot,reason,approved_by,request_id)
      values(${route.id},${input.context.organizationId},${route.workspace_id},${review.reservedTokens},${tx.json(ledger.snapshot)},${review.reason},${approvedBy},${input.context.requestId})`;
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${input.context.organizationId},${route.workspace_id},${approvedBy},'model_usage.budget_review','route_decision',${route.id},'recorded','platform_admin_explicit_unknown_usage_acceptance',${input.context.requestId},
      ${tx.json({ reservedTokens: review.reservedTokens, reason: review.reason, runId: route.run_id, usageComplete: false, scope: 'organization_monthly_budget', notActualUsage: true })})`;
    return {
      decisionId: review.decisionId,
      reservedTokens: review.reservedTokens,
      usageComplete: false,
      replayed: false,
    };
  });
}
