import { diagnosticText } from './tenant-validation.ts';
import { z } from 'zod';
import {
  UuidSchema,
  type RequestContext,
  type ActivityCounts,
  type OrganizationActivityOverview,
  type OrganizationActivityPeople,
  type OrganizationActivityRuns,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  listManagedOrganizations,
  getManagedOrganization,
  listOrganizationPeople,
} from './organization-administration.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import { readTaskClocks } from './task-clock.ts';

const emptyCounts = (): ActivityCounts => ({
  running: 0,
  waiting: 0,
  queued: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
});
// Same authoritative Run + task-clock state everywhere in this projection.
const state = (db: ReturnType<typeof getDatabase>) =>
  db`case when r.state in ('succeeded','failed','canceled') then r.state when c.phase='waiting' or r.state='waiting_approval' then 'waiting' when r.state='queued' then 'queued' else 'running' end`;
async function countsForOrganizations(ids: string[]) {
  const db = getDatabase();
  return db<
    {
      organization_id: string;
      owner_id: string;
      state: keyof ActivityCounts;
      count: number;
    }[]
  >`
    select r.organization_id,r.owner_id,${state(db)} as state,count(*)::int as count
    from allrice_runs r join allrice_employee_runs er on er.run_id=r.id and er.owner_id=r.owner_id
      and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id
    join allrice_chat_sessions s on s.id=er.session_id and s.owner_id=r.owner_id and s.archived_at is null
    left join allrice_task_clocks c on c.run_id=r.id
    where r.organization_id=any(${db.array(ids)}::uuid[])
      and (r.state not in ('succeeded','failed','canceled') or r.completed_at>=clock_timestamp()-interval '7 days')
    group by r.organization_id,r.owner_id,${state(db)}`;
}
export async function listOrganizationActivityOverview(
  context: RequestContext,
  after?: string,
): Promise<OrganizationActivityOverview> {
  const page = await listManagedOrganizations(context, after),
    rows = await countsForOrganizations(page.organizations.map((o) => o.id));
  return {
    ...page,
    organizations: page.organizations.map((o) => {
      const counts = emptyCounts();
      for (const r of rows.filter((r) => r.organization_id === o.id))
        counts[r.state] += r.count;
      return { ...o, counts };
    }),
  };
}
export async function listOrganizationActivityPeople(
  context: RequestContext,
  organizationId: string,
  input: { after?: string; search?: string } = {},
): Promise<OrganizationActivityPeople> {
  const { organization } = await getManagedOrganization(
      context,
      organizationId,
    ),
    page = await listOrganizationPeople(context, organizationId, input);
  const db = getDatabase(),
    ids = page.people.map((p) => p.userId),
    counts = await countsForOrganizations([organizationId]);
  const computers = await db<
    { owner_id: string; count: number; last_seen_at: Date | null }[]
  >`
    select owner_id,count(*)::int as count,max(last_seen_at) as last_seen_at from allrice_bridge_devices
    where organization_id=${organizationId} and owner_id=any(${db.array(ids)}::uuid[]) and revoked_at is null group by owner_id`;
  const apps = await db<{ user_id: string; count: number }[]>`
    select m.user_id,count(*)::int as count from allrice_mcp_member_connections m
    join allrice_connector_bindings b on b.id=m.binding_id and b.organization_id=m.organization_id and b.workspace_id=m.workspace_id and b.enabled
    where m.organization_id=${organizationId} and m.user_id=any(${db.array(ids)}::uuid[]) and m.connected and not m.removed group by m.user_id`;
  return {
    organization,
    nextCursor: page.nextCursor,
    people: page.people.map((p) => {
      const totals = emptyCounts();
      for (const r of counts.filter((r) => r.owner_id === p.userId))
        totals[r.state] += r.count;
      const computer = computers.find((c) => c.owner_id === p.userId);
      return {
        ...p,
        counts: totals,
        computerCount: computer?.count ?? 0,
        lastDeviceSeenAt: computer?.last_seen_at?.toISOString() ?? null,
        applicationCount: apps.find((a) => a.user_id === p.userId)?.count ?? 0,
      };
    }),
  };
}
const filterSchema = z.object({
  employeeId: UuidSchema.optional(),
  status: z
    .enum([
      'all',
      'running',
      'waiting',
      'queued',
      'succeeded',
      'failed',
      'canceled',
    ])
    .default('all'),
  before: UuidSchema.optional(),
});
export async function listOrganizationActivityRuns(
  context: RequestContext,
  orgInput: string,
  userInput: string,
  input: unknown = {},
): Promise<OrganizationActivityRuns> {
  const db = getDatabase(),
    organizationId = UuidSchema.parse(orgInput),
    userId = UuidSchema.parse(userInput),
    filter = filterSchema.parse(input);
  await requireTenantAdministrationAuthority(context, db);
  await requireTenantAdministrationTarget(db, organizationId, null);
  const [person] =
    await db`select id from allrice_memberships where organization_id=${organizationId} and user_id=${userId} limit 1`;
  if (!person) throw new DataAccessError('not_found');
  const employees = await db<{ id: string; name: string }[]>`
    select distinct coalesce(d.employee_id,e.id) as id,coalesce(p.name,e.name) as name from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id
    left join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
    left join allrice_platform_employees p on p.id=d.employee_id
    where a.organization_id=${organizationId} and a.user_id=${userId} order by name,id`;
  let before: Date | null = null;
  if (filter.before) {
    const [cursor] = await db<
      { created_at: Date }[]
    >`select r.created_at from allrice_runs r join allrice_employee_runs er on er.run_id=r.id
      where r.id=${filter.before} and r.organization_id=${organizationId} and r.owner_id=${userId}`;
    if (!cursor) throw new DataAccessError('not_found');
    before = cursor.created_at;
  }
  const rows = await db<
    {
      id: string;
      workspace_id: string;
      session_id: string;
      title: string;
      employee_id: string;
      employee_name: string;
      status: keyof ActivityCounts;
      created_at: Date;
      completed_at: Date | null;
      question: boolean;
      paused: boolean;
      device_wait: boolean;
      last_label: string | null;
    }[]
  >`
    select r.id,r.workspace_id,er.session_id,left(s.title,250) as title,coalesce(d.employee_id,e.id) as employee_id,v.name as employee_name,
      ${state(db)} as status,r.created_at,r.completed_at,
      exists(select 1 from allrice_task_questions q where q.run_id=r.id and q.pending) as question,
      exists(select 1 from allrice_task_progress p where p.run_id=r.id and p.pause_id is not null) as paused,
      exists(select 1 from allrice_runtime_operations op where op.root_run_id=r.id and op.snapshot->>'status'='waiting_device') as device_wait,
      (select left(ev.payload->>'label',240) from allrice_run_events ev where ev.run_id=r.id and ev.organization_id=r.organization_id
        and ev.workspace_id=r.workspace_id and ev.event_type='harness.native' and ev.payload->>'source'='dsh'
        and ev.payload->>'presentation' in ('tool','todo','search','compaction','context','lifecycle')
        and ev.payload->>'label' is not null order by ev.sequence desc limit 1) as last_label
    from allrice_runs r join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id and er.owner_id=r.owner_id
    join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=r.organization_id and s.workspace_id=r.workspace_id and s.owner_id=r.owner_id and s.archived_at is null
    join allrice_employee_versions v on v.id=er.employee_version_id and v.organization_id=r.organization_id and v.workspace_id=r.workspace_id
    join allrice_employees e on e.id=v.employee_id
    left join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=e.id and d.organization_id=r.organization_id and d.workspace_id=r.workspace_id
    left join allrice_task_clocks c on c.run_id=r.id
    where r.organization_id=${organizationId} and r.owner_id=${userId}
      and (${filter.employeeId ?? null}::uuid is null or coalesce(d.employee_id,e.id)=${filter.employeeId ?? null})
      and (${filter.status}='all' or ${state(db)}=${filter.status})
      and (${before}::timestamptz is null or (r.created_at,r.id)<(${before},${filter.before ?? null}::uuid))
    order by r.created_at desc,r.id desc limit 51`;
  const page = rows.slice(0, 50),
    timings = await db.begin((tx) =>
      readTaskClocks(
        tx,
        page.map((r) => r.id),
      ),
    );
  const labels: Record<keyof ActivityCounts, string> = {
    running: '正在处理',
    queued: '正在排队',
    waiting: '等待继续',
    failed: '工作失败',
    succeeded: '已完成',
    canceled: '已取消',
  };
  return {
    organizationId,
    userId,
    employees: [...employees],
    nextCursor: rows.length > 50 ? page.at(-1)!.id : null,
    runs: page.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      sessionId: r.session_id,
      title: diagnosticText(r.title),
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      timing: timings.get(r.id) ?? null,
      stage:
        r.status === 'waiting'
          ? r.paused
            ? '暂无新进展，等待员工决定是否继续'
            : r.question
              ? '等待员工回复'
              : r.device_wait
                ? '等待电脑连接'
                : '等待确认或外部操作'
          : r.status === 'running'
            ? r.last_label
              ? diagnosticText(r.last_label)
              : labels.running
            : labels[r.status],
    })),
  };
}
