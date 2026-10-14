import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CreateEmployeeInstanceInputSchema,
  UpdateEmployeeInstanceInputSchema,
  EmployeeInstanceSchema,
  EmployeeInstanceSnapshotSchema,
  EmployeeInstanceLifecycleInputSchema,
  EmployeeInstanceRevisionSchema,
  EmployeeVersionSourceSchema,
  EmployeeProfileChatInputSchema,
  ExecutionContextSchema,
  EmployeeInstanceProfileSchema,
  UuidSchema,
  type EmployeeInstance,
  type EmployeeInstanceSnapshot,
  type RequestContext,
  type ExecutionContext,
  type EmployeeInstanceProfile,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import {
  cancelEmployeeAccessRuns,
  employeeAccessTransaction,
} from './employee-access-cancellation.ts';
import { assertEmployeeChatRun } from './employee-chat-authority.ts';
import { explicitEmployeeProfileIntent } from './employee-profile-intent.ts';

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
  archived_at: Date | null;
};

/** Resolve an immutable tenant version, never the deployment's mutable pointer. */
export async function readEmployeeVersionPublication(
  scope: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    versionId: string;
  },
  sql: Sql = getDatabase(),
) {
  const [publication] = await sql<
    { revision_id: string; checksum: string; definition: unknown }[]
  >`
    select r.id as revision_id, r.checksum, r.definition
    from allrice_employee_version_sources p
    join allrice_platform_employee_revisions r
      on r.id = p.platform_revision_id and r.employee_id = p.platform_employee_id
    where p.organization_id = ${scope.organizationId}
      and p.workspace_id = ${scope.workspaceId}
      and p.employee_id = ${scope.employeeId}
      and p.employee_version_id = ${scope.versionId}
      and r.status = 'published'
  `;
  return publication;
}

export class EmployeeInstanceError extends Error {
  constructor(public readonly code: 'instance_conflict' | 'instance_archived') {
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
  context: Identity & Pick<RequestContext, 'requestId'>,
  id: string,
  operation: 'create' | 'update' | 'archive' | 'restore',
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
  await sql`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation)
    select id,1,'{}'::jsonb,'create' from allrice_employee_instances where id=${assignmentId}
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
      archivedAt: r.archived_at?.toISOString() ?? null,
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
      and i.owner_id=${actorId(context)} and i.archived_at is null and a.active and e.status='active'
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
  const instance = await getEmployeeInstanceForHistory(context, idInput, sql);
  await assignment(context, instance.assignmentId, sql);
  if (instance.archivedAt) throw new EmployeeInstanceError('instance_archived');
  return instance;
}

/** Read-only owner history survives archival/withdrawal. Execution and edits
 * must use getEmployeeInstance and independently require current assignment. */
export async function getEmployeeInstanceForHistory(
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
  return (await mapInstances([row], sql))[0]!;
}

export async function getEmployeeInstanceHistory(
  context: Identity,
  idInput: string,
  beforeRevision?: number,
) {
  const sql = getDatabase(),
    instance = await getEmployeeInstanceForHistory(context, idInput, sql);
  if (
    beforeRevision !== undefined &&
    (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
  )
    throw new EmployeeInstanceError('instance_conflict');
  const rows =
    await sql`select revision,profile,operation,archived_at,restored_from_revision,created_at
    from allrice_employee_instance_revisions where instance_id=${instance.id}
      ${beforeRevision === undefined ? sql`` : sql`and revision<${beforeRevision}`}
    order by revision desc limit 101`;
  const revisions = rows.slice(0, 100).map((row) =>
    EmployeeInstanceRevisionSchema.parse({
      revision: row.revision,
      profile: row.profile,
      operation: row.operation,
      archivedAt: row.archived_at?.toISOString() ?? null,
      restoredFromRevision: row.restored_from_revision,
      createdAt: row.created_at.toISOString(),
    }),
  );
  return {
    instance,
    revisions,
    nextBeforeRevision: rows.length > 100 ? revisions.at(-1)!.revision : null,
  };
}

/** Owner-only discovery also includes archived and withdrawn instances. This
 * list grants no execution or editing authority. */
export async function listHistoricalEmployeeInstances(
  context: Identity,
  workspaceId: string,
  beforeId?: string,
) {
  const scope = { ...context, workspaceId: UuidSchema.parse(workspaceId) };
  const cursor =
    beforeId === undefined ? undefined : UuidSchema.parse(beforeId);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await authority(scope, tx);
      const rows = await tx<
        InstanceRow[]
      >`select i.*,a.employee_version_id current_version_id
      from allrice_employee_instances i join allrice_employee_assignments a on a.id=i.assignment_id
      where i.organization_id=${scope.organizationId} and i.workspace_id=${scope.workspaceId}
        and i.owner_id=${actorId(scope)} ${cursor ? tx`and i.id<${cursor}` : tx``}
      order by i.id desc limit 101`;
      return {
        instances: await mapInstances(rows.slice(0, 100), tx),
        nextBeforeId: rows.length > 100 ? rows[99]!.id : null,
      };
    },
  );
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
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation) values(${id},1,${tx.json(value.profile)},'create')`;
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
  return getDatabase().begin((tx) =>
    writeInstanceProfile(tx, scope, id, value, () => value.profile),
  );
}

/** One revision/receipt transaction for HTTP and governed chat updates. Patch
 * against the locked profile only after replay lookup, preserving other fields. */
async function writeInstanceProfile(
  tx: Tx,
  scope: Identity & Pick<RequestContext, 'requestId'>,
  id: string,
  value: { requestId: string; expectedRevision: number } & postgres.JSONValue,
  profileFor: (current: EmployeeInstanceProfile) => EmployeeInstanceProfile,
  authorize?: (before: EmployeeInstance) => Promise<void>,
) {
  await authority(scope, tx, true);
  const before = await getEmployeeInstance(scope, id, tx);
  await assignment(scope, before.assignmentId, tx, true);
  const [row] = await tx<
    { revision: number; profile: unknown; archived_at: Date | null }[]
  >`select revision,profile,archived_at from allrice_employee_instances where id=${id} for update`;
  if (!row || row.archived_at)
    throw new EmployeeInstanceError('instance_archived');
  await authorize?.(before);
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
  const profile = EmployeeInstanceProfileSchema.parse(
    profileFor(EmployeeInstanceProfileSchema.parse(row.profile)),
  );
  await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,request_id,request_input)
      values(${id},${revision},${tx.json(profile)},${value.requestId},${tx.json(value)})`;
  await tx`update allrice_employee_instances set revision=${revision},profile=${tx.json(profile)},updated_at=clock_timestamp() where id=${id}`;
  const result = await getEmployeeInstance(scope, id, tx);
  await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=${revision}`;
  await auditInstance(tx, scope, id, 'update');
  return result;
}

export class EmployeeProfileChatError extends Error {
  constructor(
    public readonly code:
      'explicit_profile_request_required' | 'profile_run_unavailable',
  ) {
    super(code);
  }
}

/** The sole chat write entry. The root Run, original user message, Session and
 * current assignment resolve the private target; model arguments contain none. */
export async function updateEmployeeProfileFromChat(input: {
  context: ExecutionContext;
  sessionId: string;
  userMessageId: string;
  callId: string;
  worker: { attempt: number; leaseToken: string };
  arguments: unknown;
}) {
  const ctx = ExecutionContextSchema.parse(input.context);
  const args = EmployeeProfileChatInputSchema.parse(input.arguments);
  function fail(): never {
    throw new EmployeeProfileChatError('profile_run_unavailable');
  }
  if (
    !ctx.workspaceId ||
    ctx.policySnapshot.organizationId !== ctx.organizationId ||
    ctx.delegatedBy.type !== 'user' ||
    ctx.delegatedBy.id !== ctx.policySnapshot.subjectId ||
    Date.parse(ctx.policySnapshot.expiresAt) <= Date.now() ||
    !input.callId ||
    input.callId.length > 200 ||
    !Number.isSafeInteger(input.worker.attempt) ||
    input.worker.attempt < 0
  )
    fail();
  UuidSchema.parse(input.sessionId);
  UuidSchema.parse(input.userMessageId);
  UuidSchema.parse(input.worker.leaseToken);
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        ctx.organizationId,
        ctx.workspaceId,
        ctx.runId,
        input.callId,
      ]),
    )
    .digest('hex');
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const scope: Identity & Pick<RequestContext, 'requestId'> = {
    actor: { type: 'user', id: ctx.policySnapshot.subjectId },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId!,
    requestId,
  };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    // Read the target without locks first. The same binding is checked again
    // under the Session lock below, after identity/assignment/instance locks.
    const [target] = await tx<
      { id: string }[]
    >`select coalesce(s.employee_instance_id,s.employee_assignment_id) id
      from allrice_chat_sessions s where s.id=${input.sessionId} and s.organization_id=${ctx.organizationId}
        and s.workspace_id=${ctx.workspaceId!} and s.owner_id=${ctx.policySnapshot.subjectId} and s.archived_at is null`;
    if (!target) fail();
    const { expectedRevision, ...patch } = args;
    return writeInstanceProfile(
      tx,
      scope,
      target.id,
      {
        requestId,
        expectedRevision,
        patch,
        runId: ctx.runId,
        userMessageId: input.userMessageId,
      },
      (current) => ({ ...current, ...patch }),
      async (before) => {
        if (before.kind !== 'custom') fail();
        const text = await assertEmployeeChatRun(
          tx,
          input,
          before,
          'workspace.employee.profile.update',
          fail,
        );
        if (!explicitEmployeeProfileIntent(text, args))
          throw new EmployeeProfileChatError(
            'explicit_profile_request_required',
          );
      },
    );
  });
}

export async function changeEmployeeInstanceLifecycle(
  contextInput: RequestContext,
  idInput: string,
  raw: unknown,
) {
  const value = EmployeeInstanceLifecycleInputSchema.parse(raw),
    id = UuidSchema.parse(idInput),
    context = { ...contextInput, workspaceId: value.workspaceId };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await authority(context, tx, true);
    const before = await getEmployeeInstanceForHistory(context, id, tx);
    await assignment(context, before.assignmentId, tx, true);
    const [row] = await tx<
      InstanceRow[]
    >`select * from allrice_employee_instances where id=${id} for update`;
    const [prior] =
      await tx`select response,request_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instance_revisions where instance_id=${id} and request_id=${value.requestId}`;
    if (prior) {
      if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
      return EmployeeInstanceSchema.parse(prior.response);
    }
    if (!row || row.revision !== value.expectedRevision)
      throw new EmployeeInstanceError('instance_conflict');
    const revision = row.revision + 1;
    let profile = row.profile;
    if (value.operation === 'restore') {
      const [source] =
        await tx`select profile from allrice_employee_instance_revisions where instance_id=${id} and revision=${value.sourceRevision}`;
      if (!source) throw new DataAccessError('not_found');
      profile = source.profile;
    } else if (row.archived_at)
      throw new EmployeeInstanceError('instance_conflict');
    const [updated] =
      await tx`update allrice_employee_instances set revision=${revision},profile=${tx.json(profile as postgres.JSONValue)},
      archived_at=${value.operation === 'archive' ? tx`clock_timestamp()` : tx`null`},updated_at=clock_timestamp() where id=${id} returning archived_at`;
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation,archived_at,restored_from_revision,request_id,request_input)
      values(${id},${revision},${tx.json(profile as postgres.JSONValue)},${value.operation},${updated!.archived_at},${value.operation === 'restore' ? value.sourceRevision : null},${value.requestId},${tx.json(value)})`;
    if (value.operation === 'archive')
      await cancelEmployeeAccessRuns(
        tx,
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          instanceId: id,
        },
        'AI 员工已归档',
        context,
      );
    const result = await getEmployeeInstanceForHistory(context, id, tx);
    await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=${revision}`;
    await auditInstance(tx, context, id, value.operation);
    return result;
  });
}

/** Caller covers authorization and Session/message persistence in one
 * transaction. Identity → assignment → instance precede any Session lock;
 * archival cannot pass this check while a new Session or message is saved. */
export async function resolveEmployeeSessionInstance(
  context: Identity,
  assignmentId: string,
  instanceId: string | undefined,
  tx: Tx,
) {
  await authority(context, tx, true);
  await assignment(context, assignmentId, tx, true);
  if (!instanceId) await ensureGeneralEmployeeInstance(tx, assignmentId);
  await tx`select id from allrice_employee_instances where id=${instanceId ?? assignmentId} for share`;
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
  delete snapshot.archivedAt;
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
  delete currentSnapshot.archivedAt;
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
