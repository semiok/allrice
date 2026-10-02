import {
  OrganizationDashboardFilterSchema,
  UuidSchema,
  type OrganizationDashboard,
  type OrganizationDashboardFilter,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import type { TransactionSql } from 'postgres';
import { DataAccessError } from './data.ts';
import { getManagedOrganization } from './organization-administration.ts';

type Database = ReturnType<typeof getDatabase>;

export function organizationDashboardPeriod(
  filter: OrganizationDashboardFilter,
  now = new Date(),
) {
  return {
    from:
      filter.range === 'custom'
        ? new Date(filter.from!).toISOString()
        : new Date(
            now.getTime() - (filter.range === '30d' ? 30 : 7) * 86400000,
          ).toISOString(),
    to:
      filter.range === 'custom'
        ? new Date(filter.to!).toISOString()
        : now.toISOString(),
    timeZone: filter.timeZone,
  };
}

/** One formal root Run per row, including archived sessions and former staff.
 * Assistant attempts and platform test runs never enter this source. */
export function organizationWorkSource(
  db: Database,
  organizationId: string,
  filter: Pick<
    OrganizationDashboardFilter,
    'userId' | 'employeeId' | 'jobTitle'
  >,
) {
  return db`
    from allrice_runs r
    join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id
      and er.workspace_id=r.workspace_id and er.owner_id=r.owner_id
    join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=r.organization_id
      and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id
    join allrice_employee_versions v on v.id=er.employee_version_id
      and v.organization_id=r.organization_id and v.workspace_id=r.workspace_id
    join allrice_employees e on e.id=v.employee_id
    join allrice_users u on u.id=r.owner_id
    left join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id
      and d.organization_id=r.organization_id and d.workspace_id=r.workspace_id
    left join allrice_organization_people person on person.organization_id=r.organization_id and person.user_id=r.owner_id
    left join allrice_task_clocks c on c.run_id=r.id
    where r.organization_id=${organizationId}
      and (${filter.userId ?? null}::uuid is null or r.owner_id=${filter.userId ?? null})
      and (${filter.employeeId ?? null}::uuid is null or coalesce(d.employee_id,e.id)=${filter.employeeId ?? null})
      and (${filter.jobTitle || null}::text is null or coalesce(person.job_title,'')=${filter.jobTitle || null})
      and not exists(select 1 from allrice_assistant_instances assistant
        where assistant.run_id=r.id and assistant.run_id<>assistant.root_run_id)
  `;
}

/** Explicit business deliveries plus compatible legacy documents. Tool paging,
 * raw command output and browser evidence are not business delivery counts. */
export function businessDeliverablePredicate(db: Database | TransactionSql) {
  return db`(
    (a.version_id is not null and a.kind in ('document','plan','file'))
    or (a.version_id is null and not (
      coalesce(dv.change_summary,'') like 'Tool result %; Run %; call %'
      and dv.file_name='tool-result-' || replace(replace(split_part(dv.change_summary,';',1),'Tool result ',''),'.','-') || '-' || dv.object_id::text || '.txt'
    ))
  )`;
}

export async function readOrganizationDashboard(
  context: RequestContext,
  idInput: string,
  input: unknown = {},
): Promise<OrganizationDashboard> {
  const organizationId = UuidSchema.parse(idInput);
  const filter = OrganizationDashboardFilterSchema.parse(input);
  const { organization } = await getManagedOrganization(
    context,
    organizationId,
  );
  const db = getDatabase();
  if (filter.userId) {
    const [person] =
      await db`select 1 from allrice_users u where u.id=${filter.userId}
      and (exists(select 1 from allrice_memberships m where m.organization_id=${organizationId} and m.user_id=u.id)
        or exists(select 1 from allrice_employee_runs er where er.organization_id=${organizationId} and er.owner_id=u.id))`;
    if (!person) throw new DataAccessError('not_found');
  }
  const now = new Date();
  const period = organizationDashboardPeriod(filter, now);
  const source = organizationWorkSource(db, organizationId, filter);
  const currentEmployee = db`exists(select 1 from allrice_memberships m
    where m.organization_id=${organizationId} and m.user_id=u.id and m.active) and u.status='active'`;
  const createdInPeriod = db`r.created_at>=${period.from}::timestamptz and r.created_at<${period.to}::timestamptz`;
  const completedInPeriod = db`r.completed_at>=${period.from}::timestamptz and r.completed_at<${period.to}::timestamptz`;
  const [people] = await db<Record<string, number>[]>`
    select count(*) filter(where ${currentEmployee})::int as active,
      count(*) filter(where not (${currentEmployee}))::int as inactive,
      count(*) filter(where ${currentEmployee} and exists(
        select 1 from allrice_employee_assignments a join allrice_workspaces w on w.id=a.workspace_id and w.organization_id=a.organization_id
        where a.organization_id=${organizationId} and a.user_id=u.id and a.active and w.archived_at is null
        and (${filter.employeeId ?? null}::uuid is null or a.employee_id=${filter.employeeId ?? null} or exists(
          select 1 from allrice_platform_employee_tenant_assignments da where da.tenant_employee_id=a.employee_id
            and da.organization_id=a.organization_id and da.workspace_id=a.workspace_id and da.employee_id=${filter.employeeId ?? null}))))::int as assigned
    from allrice_users u left join allrice_organization_people person on person.organization_id=${organizationId} and person.user_id=u.id
    where exists(select 1 from allrice_memberships m where m.organization_id=${organizationId} and m.user_id=u.id)
      and (${filter.userId ?? null}::uuid is null or u.id=${filter.userId ?? null})
      and (${filter.jobTitle || null}::text is null or coalesce(person.job_title,'')=${filter.jobTitle || null})`;
  const [work] = await db<Record<string, number>[]>`
    select count(*) filter(where ${createdInPeriod})::int as started,
      count(*) filter(where r.state='succeeded' and ${completedInPeriod})::int as completed,
      count(*) filter(where r.state='failed' and ${completedInPeriod})::int as failed,
      count(*) filter(where r.state='canceled' and ${completedInPeriod})::int as canceled,
      count(*) filter(where r.state not in ('succeeded','failed','canceled') and (r.state='waiting_approval' or c.phase='waiting'))::int as waiting,
      count(*) filter(where r.state='queued' and coalesce(c.phase,'')<>'waiting')::int as queued,
      count(*) filter(where r.state not in ('succeeded','failed','canceled','queued','waiting_approval') and coalesce(c.phase,'')<>'waiting')::int as running,
      count(distinct r.owner_id) filter(where ${createdInPeriod} and ${currentEmployee})::int as participants,
      count(distinct r.owner_id) filter(where ${createdInPeriod} and not (${currentEmployee}))::int as historical_participants
    ${source}`;
  const [deliveries] = await db<Record<string, number>[]>`
    with scoped_runs as (select r.id,r.workspace_id,r.owner_id,er.session_id ${source})
    select count(distinct dv.series_id) filter(where o.state='ready' and o.deleted_at is null and w.archived_at is null
        and (o.retention_until is null or o.retention_until>clock_timestamp()))::int as available,
      count(distinct dv.series_id) filter(where dv.version=1 and dv.created_at>=${period.from}::timestamptz and dv.created_at<${period.to}::timestamptz)::int as first_deliveries,
      count(distinct dv.series_id) filter(where dv.version>1 and dv.created_at>=${period.from}::timestamptz and dv.created_at<${period.to}::timestamptz)::int as revisions
    from allrice_deliverable_versions dv
    join allrice_workspaces w on w.id=dv.workspace_id and w.organization_id=dv.organization_id
    join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
    left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
    where dv.organization_id=${organizationId} and dv.session_id is not null and dv.platform_test_run_id is null
      and exists(select 1 from scoped_runs f where f.workspace_id=dv.workspace_id and f.owner_id=dv.owner_id and f.session_id=dv.session_id
        and (a.run_id is null or a.run_id=f.id))
      and (${filter.employeeId ?? null}::uuid is null or a.run_id is not null)
      and ${businessDeliverablePredicate(db)}`;
  const [usage] = await db<Record<string, number | string | null>[]>`
    with scoped_runs as (select r.id,r.completed_at,r.state ${source}), receipts as (
      select l.*,ss.route_decision_id as subscription_id,rd.run_id
      from allrice_model_usage_ledger l join allrice_route_decisions rd on rd.id=l.route_decision_id
        and rd.organization_id=l.organization_id and rd.workspace_id=l.workspace_id
      join scoped_runs f on f.id=rd.run_id
      left join allrice_route_subscription_snapshots ss on ss.route_decision_id=rd.id
      where l.organization_id=${organizationId} and l.occurred_at>=${period.from}::timestamptz and l.occurred_at<${period.to}::timestamptz
    ) select count(*)::int as receipts, sum(input_tokens)::bigint as input_tokens,
      sum(output_tokens)::bigint as output_tokens,sum(cached_input_tokens)::bigint as cached_tokens,
      count(*) filter(where not usage_complete)::int as incomplete,
      count(*) filter(where not cache_usage_known)::int as unknown_cache,
      count(*) filter(where cost_cents is not null and subscription_id is null)::int as priced,
      count(*) filter(where subscription_id is not null)::int as subscriptions,
      count(*) filter(where cost_cents is null and subscription_id is null)::int as unknown_cost,
      sum(cost_cents) filter(where subscription_id is null) as recorded_cost,
      (select count(*)::int from scoped_runs f where f.state in ('succeeded','failed','canceled')
        and f.completed_at>=${period.from}::timestamptz and f.completed_at<${period.to}::timestamptz) as terminal_runs,
      (select count(*)::int from scoped_runs f where f.state in ('succeeded','failed','canceled')
        and f.completed_at>=${period.from}::timestamptz and f.completed_at<${period.to}::timestamptz
        and exists(select 1 from allrice_route_decisions rd join allrice_model_usage_ledger l on l.route_decision_id=rd.id
          where rd.run_id=f.id and rd.organization_id=${organizationId})) as covered_runs
    from receipts`;
  const optionSource = organizationWorkSource(db, organizationId, {
    userId: filter.userId,
    jobTitle: filter.jobTitle,
  });
  const employees = await db<{ id: string; name: string }[]>`
    select id,name from (
      select distinct on (id) id,name from (
        select coalesce(d.employee_id,e.id) as id,coalesce(p.name,e.name) as name,
          1 as priority,a.updated_at as changed_at
        from allrice_employee_assignments a
        join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
        left join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id
          and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
        left join allrice_platform_employees p on p.id=d.employee_id
        left join allrice_organization_people person on person.organization_id=a.organization_id and person.user_id=a.user_id
        where a.organization_id=${organizationId} and a.active
          and (${filter.userId ?? null}::uuid is null or a.user_id=${filter.userId ?? null})
          and (${filter.jobTitle || null}::text is null or coalesce(person.job_title,'')=${filter.jobTitle || null})
        union all select coalesce(d.employee_id,e.id),v.name,0,r.created_at ${optionSource}
      ) candidates order by id,priority desc,changed_at desc,name
    ) options order by name,id limit 200`;
  const titles = await db<{ job_title: string }[]>`
    select distinct job_title from allrice_organization_people where organization_id=${organizationId}
      and job_title<>'' order by job_title limit 200`;
  const number = (value: number | string | null | undefined) =>
    Number(value ?? 0);
  const nullable = (value: number | string | null | undefined) =>
    value == null ? null : Number(value);
  const observedTokens = (
    value: number | string | null | undefined,
    unknown: number,
  ) =>
    number(value) > 0 || number(usage?.receipts) > unknown
      ? nullable(value)
      : null;
  return {
    organization,
    period,
    updatedAt: now.toISOString(),
    people: {
      activeEmployees: number(people?.active),
      inactiveEmployees: number(people?.inactive),
      assignedEmployees: number(people?.assigned),
      activeParticipants: number(work?.participants),
      historicalParticipants: number(work?.historical_participants),
    },
    work: {
      started: number(work?.started),
      completed: number(work?.completed),
      failed: number(work?.failed),
      canceled: number(work?.canceled),
      current: {
        running: number(work?.running),
        waiting: number(work?.waiting),
        queued: number(work?.queued),
      },
    },
    deliverables: {
      availableSeries: number(deliveries?.available),
      firstDeliveries: number(deliveries?.first_deliveries),
      revisedSeries: number(deliveries?.revisions),
    },
    usage: {
      receiptCount: number(usage?.receipts),
      inputTokens: observedTokens(
        usage?.input_tokens,
        number(usage?.incomplete),
      ),
      outputTokens: observedTokens(
        usage?.output_tokens,
        number(usage?.incomplete),
      ),
      cachedInputTokens: observedTokens(
        usage?.cached_tokens,
        number(usage?.unknown_cache),
      ),
      incompleteReceipts: number(usage?.incomplete),
      unknownCacheReceipts: number(usage?.unknown_cache),
      pricedReceipts: number(usage?.priced),
      subscriptionReceipts: number(usage?.subscriptions),
      unknownCostReceipts: number(usage?.unknown_cost),
      terminalRuns: number(usage?.terminal_runs),
      terminalRunsWithReceipts: number(usage?.covered_runs),
      recordedCostCents: nullable(usage?.recorded_cost),
      currency: null,
      costBasis: 'ledger-records-without-billing-currency',
    },
    filters: {
      employees: [...employees],
      jobTitles: titles.map((r) => r.job_title),
    },
  };
}
