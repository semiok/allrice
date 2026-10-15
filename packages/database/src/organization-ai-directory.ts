import type postgres from 'postgres';
import {
  OrganizationAiDirectoryQuerySchema,
  OrganizationAiDirectorySchema,
  OrganizationAiInstanceSchema,
  OrganizationAiSharedDetailsSchema,
  OrganizationAiPersonSchema,
  OrganizationPersonAiInstancesSchema,
  UuidSchema,
  type OrganizationAiDirectoryQuery,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { OrganizationSharedReader } from './organization-shared-reader.ts';
import { getOrganizationSharedEmployeeDetails } from './employees/employee-content.ts';
import { getReferenceFile } from './reference-library.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';

type Sql = postgres.TransactionSql;

/** The directory is a projection of stored instances and assignments. A read
 * never creates a general instance, revives access, or reads a private profile. */
function directoryRows(
  sql: Sql,
  organizationId: string,
  query: OrganizationAiDirectoryQuery = {},
) {
  const departmentId =
    query.departmentId && query.departmentId !== 'unassigned'
      ? query.departmentId
      : null;
  const search = query.search?.toLowerCase() || null;
  const sourceTemplate =
    query.sourceTemplate && query.sourceTemplate !== 'legacy'
      ? query.sourceTemplate
      : null;
  return sql`people as (
    select u.id as user_id,u.username,coalesce(p.display_name,u.display_name) as display_name,
      coalesce(p.job_title,'') as job_title,p.department_id,d.name as department_name,
      (d.id is not null and d.archived_at is null) as department_active,
      (u.status='active' and exists(select 1 from allrice_memberships m
        where m.organization_id=${organizationId} and m.user_id=u.id and m.active)) as active,
      coalesce(p.content_maintenance_level,'personal') as maintenance_level
    from allrice_users u
    left join allrice_organization_people p on p.organization_id=${organizationId} and p.user_id=u.id
    left join allrice_departments d on d.organization_id=${organizationId} and d.id=p.department_id
    where exists(select 1 from allrice_memberships m where m.organization_id=${organizationId} and m.user_id=u.id)
      and (${departmentId}::uuid is null or p.department_id=${departmentId})
      and (${query.departmentId !== 'unassigned'} or p.department_id is null)
      and (${search}::text is null or position(${search} in lower(coalesce(p.display_name,u.display_name)||' '||coalesce(u.username,'')||' '||coalesce(p.job_title,'')))>0)
  ), instances as (
    select i.id,i.owner_id,i.kind,i.revision,i.updated_at,i.assignment_id,
      a.employee_id,a.employee_version_id,i.workspace_id,w.name as workspace_name,
      case when i.archived_at is not null then 'archived'
        when not p.active or not exists(select 1 from allrice_memberships m
          where m.organization_id=${organizationId} and m.user_id=i.owner_id and m.active
            and (m.workspace_id is null or m.workspace_id=i.workspace_id)) then 'owner_inactive'
        when not a.active or e.status<>'active' or w.archived_at is not null
          or exists(select 1 from allrice_platform_employee_tenant_assignments d
            where d.organization_id=${organizationId} and d.workspace_id=i.workspace_id
              and d.tenant_employee_id=a.employee_id and not d.active) then 'assignment_unavailable'
        else 'active' end as state
    from allrice_employee_instances i
    join people p on p.user_id=i.owner_id
    join allrice_employee_assignments a on a.id=i.assignment_id and a.organization_id=i.organization_id
      and a.workspace_id=i.workspace_id and a.user_id=i.owner_id
    join allrice_employees e on e.id=a.employee_id and e.organization_id=i.organization_id and e.workspace_id=i.workspace_id
    join allrice_workspaces w on w.id=i.workspace_id and w.organization_id=i.organization_id
    left join allrice_employee_version_sources source on source.employee_version_id=a.employee_version_id
    where i.organization_id=${organizationId}
      and (${query.kind ?? null}::text is null or i.kind=${query.kind ?? null})
      and (${query.sourceTemplate !== 'legacy'} or source.platform_revision_id is null)
      and (${sourceTemplate}::uuid is null or (source.platform_employee_id=${sourceTemplate} and source.platform_revision_id is not null))
  ), instance_counts as (
    select owner_id,
      count(*) filter(where kind='general' and state='active')::integer as general,
      count(*) filter(where kind='custom' and state='active')::integer as custom,
      count(*) filter(where state in ('owner_inactive','assignment_unavailable'))::integer as inactive,
      count(*) filter(where state='archived')::integer as archived
    from instances group by owner_id
  ), pending as (
    select a.user_id,count(*)::integer as pending_assignments
    from allrice_employee_assignments a join people p on p.user_id=a.user_id and p.active
    join allrice_employees e on e.id=a.employee_id and e.status='active'
    join allrice_workspaces w on w.id=a.workspace_id and w.archived_at is null
    left join allrice_employee_version_sources source on source.employee_version_id=a.employee_version_id
    where a.organization_id=${organizationId} and a.active
      and ${query.kind !== 'custom'}
      and (${query.sourceTemplate !== 'legacy'} or source.platform_revision_id is null)
      and (${sourceTemplate}::uuid is null or (source.platform_employee_id=${sourceTemplate} and source.platform_revision_id is not null))
      and exists(select 1 from allrice_memberships m where m.organization_id=a.organization_id
        and m.user_id=a.user_id and m.active and (m.workspace_id is null or m.workspace_id=a.workspace_id))
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and d.tenant_employee_id=a.employee_id and not d.active)
      and not exists(select 1 from allrice_employee_instances i where i.assignment_id=a.id and i.kind='general')
    group by a.user_id
  ), counts as (
    select p.user_id as owner_id,c.general,c.custom,c.inactive,c.archived,a.pending_assignments
    from people p left join instance_counts c on c.owner_id=p.user_id
    left join pending a on a.user_id=p.user_id
  ), visible_people as (
    select p.*,c.general,c.custom,c.inactive,c.archived,c.pending_assignments
    from people p left join counts c on c.owner_id=p.user_id
    where (${!query.kind && !query.sourceTemplate} or
      coalesce(c.general,0)+coalesce(c.custom,0)+coalesce(c.inactive,0)+coalesce(c.archived,0)+coalesce(c.pending_assignments,0)>0)
  )`;
}

function person(row: Record<string, unknown>) {
  return OrganizationAiPersonSchema.parse({
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    jobTitle: row.job_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    departmentActive: row.department_active,
    active: row.active,
    maintenanceLevel: row.maintenance_level,
    counts: {
      general: Number(row.general ?? 0),
      custom: Number(row.custom ?? 0),
      inactive: Number(row.inactive ?? 0),
      archived: Number(row.archived ?? 0),
      pendingAssignments: Number(row.pending_assignments ?? 0),
    },
  });
}

export async function listOrganizationAiDirectory(
  context: RequestContext,
  organizationInput: string,
  queryInput: OrganizationAiDirectoryQuery = {},
) {
  const organizationId = UuidSchema.parse(organizationInput);
  const query = OrganizationAiDirectoryQuerySchema.parse(queryInput);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await requireTenantAdministrationAuthority(context, sql);
      await requireTenantAdministrationTarget(sql, organizationId, null);
      const rows = await sql`with ${directoryRows(sql, organizationId, query)}
        select p.* from visible_people p
        where (${query.after ?? null}::uuid is null or p.user_id>${query.after ?? null})
        order by p.user_id limit 51`;
      const [totals] =
        await sql`with ${directoryRows(sql, organizationId, query)}
        select count(*)::integer as people,
          coalesce(sum(p.general),0)::integer as general,
          coalesce(sum(p.custom),0)::integer as custom,
          coalesce(sum(p.inactive),0)::integer as inactive,
          coalesce(sum(p.archived),0)::integer as archived,
          coalesce(sum(p.pending_assignments),0)::integer as "pendingAssignments"
        from visible_people p`;
      return OrganizationAiDirectorySchema.parse({
        organizationId,
        totals,
        people: rows.slice(0, 50).map(person),
        nextCursor: rows.length > 50 ? rows[49]!.user_id : null,
      });
    },
  );
}

export async function listOrganizationPersonAiInstances(
  context: RequestContext,
  organizationInput: string,
  userInput: string,
  queryInput: OrganizationAiDirectoryQuery = {},
) {
  const organizationId = UuidSchema.parse(organizationInput);
  const userId = UuidSchema.parse(userInput);
  const query = OrganizationAiDirectoryQuerySchema.parse(queryInput);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await requireTenantAdministrationAuthority(context, sql);
      await requireTenantAdministrationTarget(sql, organizationId, null);
      const [owner] =
        await sql`with ${directoryRows(sql, organizationId, query)}
        select p.*,c.general,c.custom,c.inactive,c.archived,c.pending_assignments from people p
        left join counts c on c.owner_id=p.user_id where p.user_id=${userId}`;
      if (!owner) throw new DataAccessError('not_found');
      const rows = await instanceRows(
        sql,
        organizationId,
        userId,
        query.after ?? null,
        null,
        query,
      );
      return OrganizationPersonAiInstancesSchema.parse({
        organizationId,
        person: person(owner),
        instances: rows.slice(0, 50).map(instanceMetadata),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      });
    },
  );
}

function instanceRows(
  sql: Sql,
  organizationId: string,
  userId: string,
  after: string | null = null,
  instanceId: string | null = null,
  query: OrganizationAiDirectoryQuery = {},
) {
  return sql`with ${directoryRows(sql, organizationId, query)}, shared_layers as (
    select s.employee_id,s.workspace_id,r.manifest from allrice_employee_content_sets s
    join allrice_employee_content_revisions r on r.id=s.active_revision_id
    where s.organization_id=${organizationId} and s.instance_id is null
      and (s.scope='company' or (s.scope='department' and s.department_id=(select department_id from people where user_id=${userId} and department_active)))
  )
        select i.*,v.name as source_name,s.platform_employee_id,s.platform_revision_id,
          r.revision as template_revision,r.checksum as template_checksum,
          (select count(distinct scene->>'id')::integer from shared_layers l,
            lateral jsonb_array_elements(l.manifest->'scenes') scene
            where l.employee_id=i.employee_id and l.workspace_id=i.workspace_id) as scene_count,
          (select count(distinct ref::text)::integer from shared_layers l,
            lateral jsonb_array_elements((l.manifest->'common') || coalesce((
              select jsonb_agg(ref) from jsonb_array_elements(l.manifest->'scenes') scene,
              lateral jsonb_array_elements(scene->'references') ref),'[]'::jsonb)) ref
            where l.employee_id=i.employee_id and l.workspace_id=i.workspace_id and ref->>'sourceKind'='knowledge') as reference_count
        from instances i
        join allrice_employee_versions v on v.id=i.employee_version_id and v.employee_id=i.employee_id
          and v.organization_id=${organizationId} and v.workspace_id=i.workspace_id
        left join allrice_employee_version_sources s on s.employee_version_id=v.id
        left join allrice_platform_employee_revisions r on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
        where i.owner_id=${userId} and (${instanceId}::uuid is null or i.id=${instanceId}) and (${after}::uuid is null or i.id>${after})
        order by i.id limit 51`;
}
function instanceMetadata(row: Record<string, unknown>) {
  return OrganizationAiInstanceSchema.parse({
    id: row.id,
    employeeId: row.employee_id,
    assignmentId: row.assignment_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    kind: row.kind,
    state: row.state,
    sourceName: row.source_name,
    source: row.platform_revision_id
      ? {
          kind: 'platform',
          employeeVersionId: row.employee_version_id,
          templateId: row.platform_employee_id,
          templateRevisionId: row.platform_revision_id,
          templateRevision: row.template_revision,
          templateChecksum: row.template_checksum,
        }
      : {
          kind: 'tenant_version',
          employeeVersionId: row.employee_version_id,
        },
    revision: row.revision,
    updatedAt: (row.updated_at as Date).toISOString(),
    sharedSummary:
      row.state === 'active'
        ? {
            sceneCount: row.scene_count,
            referenceCount: row.reference_count,
            automaticExperience: 'not_enabled',
          }
        : null,
  });
}

async function sharedTarget(
  context: RequestContext,
  organizationId: string,
  userId: string,
  instanceId: string,
  sql: Sql,
) {
  await requireTenantAdministrationAuthority(context, sql);
  await requireTenantAdministrationTarget(sql, organizationId, null);
  const [row] = await instanceRows(
    sql,
    organizationId,
    userId,
    null,
    instanceId,
  );
  if (!row || row.state !== 'active') throw new DataAccessError('not_found');
  const [owner] = await sql`with ${directoryRows(sql, organizationId)}
    select department_id,department_active from people where user_id=${userId}`;
  const instance = instanceMetadata(row);
  const reader = await OrganizationSharedReader.authorize(
    context,
    {
      organizationId,
      workspaceId: instance.workspaceId,
      departmentId: owner?.department_active ? owner.department_id : null,
    },
    sql,
  );
  return { instance, reader };
}

export async function getOrganizationAiSharedDetails(
  context: RequestContext,
  organizationInput: string,
  userInput: string,
  instanceInput: string,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    userId = UuidSchema.parse(userInput),
    instanceId = UuidSchema.parse(instanceInput);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const { instance, reader } = await sharedTarget(
        context,
        organizationId,
        userId,
        instanceId,
        sql,
      );
      return OrganizationAiSharedDetailsSchema.parse({
        organizationId,
        userId,
        visibility: 'shared_only',
        details: await getOrganizationSharedEmployeeDetails(
          reader,
          instance,
          instance.employeeId,
          sql,
        ),
      });
    },
  );
}

/** Each file/page read checks the current shared layer and its exact pin, not
 * just a revision ID learned earlier from the directory. */
export async function getOrganizationAiReferenceFile(
  context: RequestContext,
  organizationInput: string,
  userInput: string,
  instanceInput: string,
  revisionInput: string,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    userId = UuidSchema.parse(userInput),
    instanceId = UuidSchema.parse(instanceInput),
    revisionId = UuidSchema.parse(revisionInput);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const { instance, reader } = await sharedTarget(
        context,
        organizationId,
        userId,
        instanceId,
        sql,
      );
      const details = await getOrganizationSharedEmployeeDetails(
        reader,
        instance,
        instance.employeeId,
        sql,
      );
      if (
        !details.content.sources.some(
          (source) =>
            source.available && source.referenceFile?.revisionId === revisionId,
        )
      )
        throw new DataAccessError('not_found');
      return getReferenceFile(
        reader.context,
        instance.workspaceId,
        revisionId,
        sql,
        reader,
      );
    },
  );
}
