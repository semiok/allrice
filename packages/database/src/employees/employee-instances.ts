import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CreateEmployeeInstanceInputSchema,
  UpdateEmployeeInstanceInputSchema,
  EmployeeInstanceSchema,
  EmployeeInstanceSnapshotSchema,
  EmployeeVersionSourceSchema,
  UuidSchema,
  type EmployeeInstance,
  type EmployeeInstanceSnapshot,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
type Tx = postgres.TransactionSql;
type Identity = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId'
> &
  Partial<Pick<RequestContext, 'sessionId'>>;
type InstanceRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  assignment_id: string;
  kind: 'general' | 'custom';
  creation_version_id: string;
  current_version_id: string;
  revision: number;
  profile: unknown;
  created_at: Date;
  updated_at: Date;
};

export class EmployeeInstanceError extends Error {
  constructor(public readonly code: 'instance_conflict') {
    super(code);
  }
}

function actorId(context: Identity) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context.actor.id;
}

async function authority(
  context: Identity,
  sql: Sql,
  lock: boolean | 'update_user' = false,
) {
  const principal = await readContentPrincipal(context, sql, lock);
  if (!principal || (lock && !principal.writable))
    throw new DataAccessError('authorization_denied');
}

async function auditInstance(
  tx: Tx,
  context: RequestContext,
  id: string,
  operation: 'create' | 'update',
) {
  await tx`insert into allrice_audit_events
    (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${context.organizationId},${context.workspaceId},${actorId(context)},${`employee.instance.${operation}`},
      'employee_instance',${id},'allowed','owner_with_current_assignment',${context.requestId})`;
}

/** The assignment row serializes publication/revocation. We deliberately do
 * not take the deployment advisory gate after identity locks: publication and
 * membership writers already hold different outer gates. */
async function assignment(
  context: Identity,
  id: string,
  sql: Sql,
  lock = false,
) {
  const rows = await sql<
    { id: string; employee_version_id: string; employee_id: string }[]
  >`
    select a.id,a.employee_version_id,a.employee_id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    where a.id=${UuidSchema.parse(id)} and a.organization_id=${context.organizationId}
      and a.workspace_id=${context.workspaceId} and a.user_id=${actorId(context)}
      and a.active and e.status='active'
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
          and d.tenant_employee_id=a.employee_id and not d.active)
    ${lock ? sql`for share of a` : sql``}`;
  if (!rows[0]) throw new DataAccessError('authorization_denied');
  return rows[0];
}

/** Stable default mapping for old and newly assigned employees. This never
 * changes a profile, revives an instance, or transfers its owner. */
export async function ensureGeneralEmployeeInstance(
  sql: Sql,
  assignmentId: string,
) {
  await sql`insert into allrice_employee_instances
    (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
    select id,organization_id,workspace_id,user_id,id,'general',employee_version_id
    from allrice_employee_assignments where id=${assignmentId}
    on conflict(id) do nothing`;
  await sql`insert into allrice_employee_instance_revisions(instance_id,revision,profile)
    select id,1,'{}'::jsonb from allrice_employee_instances where id=${assignmentId}
    on conflict(instance_id,revision) do nothing`;
}

async function mapInstances(
  rows: InstanceRow[],
  sql: Sql,
): Promise<EmployeeInstance[]> {
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.creation_version_id, r.current_version_id]),
    ),
  ];
  const sources = ids.length
    ? await sql<
        {
          employee_version_id: string;
          platform_employee_id: string;
          platform_revision_id: string;
          revision: number;
          checksum: string;
        }[]
      >`
    select s.employee_version_id,s.platform_employee_id,s.platform_revision_id,r.revision,r.checksum
    from allrice_employee_version_sources s join allrice_platform_employee_revisions r
      on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
    where s.employee_version_id in ${sql(ids)}`
    : [];
  const source = (id: string) => {
    const row = sources.find((s) => s.employee_version_id === id);
    return EmployeeVersionSourceSchema.parse(
      row
        ? {
            kind: 'platform',
            employeeVersionId: id,
            templateId: row.platform_employee_id,
            templateRevisionId: row.platform_revision_id,
            templateRevision: row.revision,
            templateChecksum: row.checksum,
          }
        : { kind: 'tenant_version', employeeVersionId: id },
    );
  };
  return rows.map((r) =>
    EmployeeInstanceSchema.parse({
      id: r.id,
      assignmentId: r.assignment_id,
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      kind: r.kind,
      revision: r.revision,
      profile: r.profile,
      creationSource: source(r.creation_version_id),
      source: source(r.current_version_id),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }),
  );
}

export async function listEmployeeInstances(
  context: Identity,
  workspaceId: string,
  sql: Sql = getDatabase(),
) {
  const scope = { ...context, workspaceId: UuidSchema.parse(workspaceId) };
  await authority(scope, sql);
  const rows = await sql<InstanceRow[]>`
    select i.*,a.employee_version_id current_version_id from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id
    join allrice_employees e on e.id=a.employee_id
    where i.organization_id=${context.organizationId} and i.workspace_id=${workspaceId}
      and i.owner_id=${actorId(context)} and a.active and e.status='active'
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
          and d.tenant_employee_id=a.employee_id and not d.active)
    order by i.kind desc,i.created_at,i.id`;
  return mapInstances(rows, sql);
}

export async function getEmployeeInstance(
  context: Identity,
  idInput: string,
  sql: Sql = getDatabase(),
) {
  await authority(context, sql);
  const [row] = await sql<
    InstanceRow[]
  >`select i.*,a.employee_version_id current_version_id
    from allrice_employee_instances i join allrice_employee_assignments a on a.id=i.assignment_id
    where i.id=${UuidSchema.parse(idInput)} and i.organization_id=${context.organizationId}
      and i.workspace_id=${context.workspaceId} and i.owner_id=${actorId(context)}`;
  if (!row) throw new DataAccessError('not_found');
  await assignment(context, row.assignment_id, sql);
  return (await mapInstances([row], sql))[0]!;
}

export async function createEmployeeInstance(
  context: RequestContext,
  input: unknown,
) {
  const value = CreateEmployeeInstanceInputSchema.parse(input),
    scope = { ...context, workspaceId: value.workspaceId };
  return getDatabase().begin(async (tx) => {
    await authority(scope, tx, true);
    const current = await assignment(scope, value.assignmentId, tx, true);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-instance-create:${scope.organizationId}:${scope.workspaceId}:${actorId(scope)}:${value.requestId}`},0))`;
    const [prior] = await tx<
      { id: string; matches: boolean }[]
    >`select id,creation_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instances where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${actorId(scope)} and creation_request_id=${value.requestId}`;
    if (prior) {
      if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
      await getEmployeeInstance(scope, prior.id, tx);
      const [saved] =
        await tx`select response from allrice_employee_instance_revisions where instance_id=${prior.id} and revision=1`;
      return EmployeeInstanceSchema.parse(saved?.response);
    }
    const id = randomUUID();
    await tx`insert into allrice_employee_instances
      (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id,profile,creation_request_id,creation_input)
      values(${id},${scope.organizationId},${scope.workspaceId},${actorId(scope)},${current.id},'custom',${current.employee_version_id},${tx.json(value.profile)},${value.requestId},${tx.json(value)})`;
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile) values(${id},1,${tx.json(value.profile)})`;
    const result = await getEmployeeInstance(scope, id, tx);
    await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=1`;
    await auditInstance(tx, scope, id, 'create');
    return result;
  });
}

export async function updateEmployeeInstance(
  context: RequestContext,
  idInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    value = UpdateEmployeeInstanceInputSchema.parse(input),
    scope = { ...context, workspaceId: value.workspaceId };
  return getDatabase().begin(async (tx) => {
    await authority(scope, tx, true);
    const before = await getEmployeeInstance(scope, id, tx);
    await assignment(scope, before.assignmentId, tx, true);
    const [row] = await tx<
      { revision: number }[]
    >`select revision from allrice_employee_instances where id=${id} for update`;
    const [prior] = await tx<
      { response: unknown; matches: boolean }[]
    >`select response,request_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instance_revisions where instance_id=${id} and request_id=${value.requestId}`;
    if (prior) {
      if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
      return EmployeeInstanceSchema.parse(prior.response);
    }
    if (row?.revision !== value.expectedRevision)
      throw new EmployeeInstanceError('instance_conflict');
    const revision = row.revision + 1;
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,request_id,request_input)
      values(${id},${revision},${tx.json(value.profile)},${value.requestId},${tx.json(value)})`;
    await tx`update allrice_employee_instances set revision=${revision},profile=${tx.json(value.profile)},updated_at=clock_timestamp() where id=${id}`;
    const result = await getEmployeeInstance(scope, id, tx);
    await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=${revision}`;
    await auditInstance(tx, scope, id, 'update');
    return result;
  });
}

/** Caller provides a transaction covering authorization, mapping and Session
 * creation. A Session can never switch instances after creation. */
export async function resolveEmployeeSessionInstance(
  context: Identity,
  assignmentId: string,
  instanceId: string | undefined,
  tx: Tx,
) {
  await authority(context, tx, true);
  await assignment(context, assignmentId, tx, true);
  if (!instanceId) await ensureGeneralEmployeeInstance(tx, assignmentId);
  const instance = await getEmployeeInstance(
    context,
    instanceId ?? assignmentId,
    tx,
  );
  if (instance.assignmentId !== assignmentId)
    throw new DataAccessError('authorization_denied');
  return instance;
}

export async function prepareEmployeeInstanceSnapshot(
  context: Identity,
  sessionId: string,
  assignmentId: string,
  versionId: string,
): Promise<EmployeeInstanceSnapshot> {
  const sql = getDatabase();
  const [session] = await sql<
    { instance_id: string }[]
  >`select coalesce(employee_instance_id,employee_assignment_id) instance_id
    from allrice_chat_sessions where id=${sessionId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId} and owner_id=${actorId(context)} and employee_assignment_id=${assignmentId} and archived_at is null`;
  if (!session) throw new DataAccessError('authorization_denied');
  // Legacy/default mappings may have been materialized outside the publication path.
  if (session.instance_id === assignmentId)
    await ensureGeneralEmployeeInstance(sql, assignmentId);
  const instance = await getEmployeeInstance(context, session.instance_id, sql);
  if (
    instance.assignmentId !== assignmentId ||
    instance.source.employeeVersionId !== versionId
  )
    throw new EmployeeInstanceError('instance_conflict');
  const snapshot = { ...instance } as Record<string, unknown>;
  delete snapshot.createdAt;
  delete snapshot.updatedAt;
  return EmployeeInstanceSnapshotSchema.parse(snapshot);
}

/** Runs retain their frozen profile, but admission uses current authority.
 * Take the user's final NO KEY UPDATE mode up front (queue allocates a policy version)
 * instead of upgrading SHARE locks in concurrent Sessions. */
export async function assertEmployeeInstanceAdmission(
  tx: Tx,
  context: Identity,
  sessionId: string,
  snapshotInput: EmployeeInstanceSnapshot,
) {
  const snapshot = EmployeeInstanceSnapshotSchema.parse(snapshotInput);
  if (
    snapshot.ownerId !== actorId(context) ||
    snapshot.organizationId !== context.organizationId ||
    snapshot.workspaceId !== context.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  await authority(context, tx, 'update_user');
  const current = await assignment(context, snapshot.assignmentId, tx, true);
  await tx`select id from allrice_employee_instances where id=${snapshot.id} for share`;
  const instance = await getEmployeeInstance(context, snapshot.id, tx);
  const currentSnapshot = { ...instance } as Record<string, unknown>;
  delete currentSnapshot.createdAt;
  delete currentSnapshot.updatedAt;
  if (
    current.employee_version_id !== snapshot.source.employeeVersionId ||
    JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot)
  )
    throw new EmployeeInstanceError('instance_conflict');
  const [session] =
    await tx`select id from allrice_chat_sessions where id=${sessionId}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${actorId(context)}
    and employee_assignment_id=${snapshot.assignmentId} and coalesce(employee_instance_id,employee_assignment_id)=${snapshot.id}
    and archived_at is null for update`;
  if (!session) throw new DataAccessError('authorization_denied');
}

export async function lockEmployeeInstanceAdmissionIdentity(
  tx: Tx,
  context: Identity,
) {
  await authority(context, tx, 'update_user');
}
