import {
  StorageObjectSchema,
  UuidSchema,
  WorkflowPackageBindingSchema,
  WorkflowPackageExecutionSelectionSchema,
  WorkflowPackageResolutionSchema,
  WorkflowPackageSchema,
  WorkflowPackageSelectionSchema,
  type StorageObject,
  type StoragePort,
  type WorkflowPackageManifest,
  type WorkflowPackageSelection,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { freezeEmployeeRuntimeContent } from '../employees/employee-content.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import { resolveEmployeeContentSource } from '../employees/employee-content-sources.ts';
import type { ContentSql } from '../employees/employee-content-model.ts';
import { capabilityChecksum } from './capability-registry.ts';
import {
  readWorkflowPackageObject,
  validateWorkflowPackageDefinition,
  validateWorkflowPackageSource,
  workflowPackageChecksum,
  workflowPackageMethodSync,
  workflowPackageSelectedReferences,
  WorkflowPackageError,
} from './workflow-package-model.ts';

export {
  WorkflowPackageError,
  workflowPackageChecksum,
} from './workflow-package-model.ts';

type ScopeInput = {
  workspaceId: string;
  instanceId: string;
  sceneId: string | null;
};
type PackageRow = {
  workflow_revision_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  assignment_id: string;
  employee_id: string;
  instance_id: string;
  scene_id: string | null;
  manifest: unknown;
  checksum: string;
  created_at: Date;
  workflow_id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  status: string;
  workflow_checksum: string;
  definition: unknown;
  published_at: Date | null;
  workflow_status: string;
};
type BindingRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  assignment_id: string;
  employee_id: string;
  instance_id: string;
  scene_id: string | null;
  workflow_revision_id: string;
  package_checksum: string;
  binding_revision: number;
  enabled: boolean;
  bound_at: Date;
};

function identity(context: ContentIdentity, workspaceId: string) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  return { ...context, workspaceId: UuidSchema.parse(workspaceId) };
}

async function readScope(
  context: ContentIdentity,
  input: ScopeInput,
  sql: ContentSql,
  lock: false | 'read' | 'write',
  allowMissingScene = false,
  requireWritable = lock === 'write',
) {
  const scope = identity(context, input.workspaceId);
  const principal = await readContentPrincipal(scope, sql, !!lock);
  if (!principal || (requireWritable && !principal.writable))
    throw new DataAccessError('authorization_denied');
  if (lock === 'write')
    await sql`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
  else if (lock === 'read')
    // Runtime content checks already hold this shared lock before locking the
    // generation. Upgrading it here deadlocks with concurrent content readers.
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
  let instance = await getEmployeeInstance(
    scope,
    UuidSchema.parse(input.instanceId),
    sql,
  );
  if (instance.kind !== 'custom')
    throw new DataAccessError('authorization_denied');
  const [assignment] = await sql<
    { employee_id: string; employee_version_id: string }[]
  >`
    select employee_id,employee_version_id from allrice_employee_assignments
    where id=${instance.assignmentId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and user_id=${scope.actor.id} and active
    ${lock ? sql`for share` : sql``}`;
  if (!assignment) throw new DataAccessError('authorization_denied');
  if (lock) {
    await sql`select id from allrice_employee_instances where id=${instance.id} for share`;
    instance = await getEmployeeInstance(scope, instance.id, sql);
  }
  const snapshot = await freezeEmployeeRuntimeContent(
    scope,
    {
      instanceId: instance.id,
      employeeId: assignment.employee_id,
      employeeVersionId: assignment.employee_version_id,
    },
    sql,
  );
  const sceneId =
    input.sceneId === null ? null : UuidSchema.parse(input.sceneId);
  let references;
  try {
    references = workflowPackageSelectedReferences(snapshot, sceneId);
  } catch (error) {
    if (
      !allowMissingScene ||
      !(error instanceof WorkflowPackageError) ||
      error.code !== 'not_found'
    )
      throw error;
    references = workflowPackageSelectedReferences(snapshot, null);
  }
  return {
    context: scope,
    instance,
    employeeId: assignment.employee_id,
    sceneId,
    references,
  };
}
type Scope = Awaited<ReturnType<typeof readScope>>;

async function readMethod(
  scope: Scope,
  manifest: WorkflowPackageManifest,
  sql: ContentSql,
  lock: boolean,
) {
  return resolveEmployeeContentSource({
    context: scope.context,
    employeeId: scope.employeeId,
    ownership: {
      scope: 'personal',
      organizationId: scope.context.organizationId,
      ownerId: scope.context.actor.id,
    },
    ref: manifest.method,
    sql,
    lock,
    allowDraft: false,
  });
}

async function packageObjects(
  scope: Scope,
  manifest: WorkflowPackageManifest,
  sql: ContentSql,
  lock: boolean,
) {
  const objects: StorageObject[] = [];
  const selected = [
    ...(manifest.source ? [manifest.source] : []),
    ...manifest.assets,
  ];
  const identities = new Map<string, string>();
  for (const ref of selected) {
    if (identities.has(ref.objectId)) {
      if (identities.get(ref.objectId) !== ref.checksum)
        throw new WorkflowPackageError('source_changed');
      continue;
    }
    identities.set(ref.objectId, ref.checksum);
    const [row] = await sql<
      {
        id: string;
        organization_id: string;
        workspace_id: string;
        owner_id: string;
        object_key: string;
        checksum: string;
        media_type: string;
        size_bytes: string | number;
        retention_until: Date | null;
        deleted_at: Date | null;
        immutable: boolean;
      }[]
    >`select * from allrice_storage_objects where id=${ref.objectId}
      and organization_id=${scope.context.organizationId} and workspace_id=${scope.context.workspaceId}
      and owner_id=${scope.context.actor.id} and checksum=${ref.checksum}
      and state='ready' and immutable and deleted_at is null
      and (retention_until is null or retention_until>clock_timestamp())
      ${lock ? sql`for share` : sql``}`;
    if (!row) throw new WorkflowPackageError('source_unavailable');
    objects.push(
      StorageObjectSchema.parse({
        id: row.id,
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        ownerId: row.owner_id,
        key: row.object_key,
        checksum: row.checksum,
        mediaType: row.media_type,
        sizeBytes: Number(row.size_bytes),
        retentionUntil: row.retention_until?.toISOString() ?? null,
        deletedAt: null,
        immutable: row.immutable,
      }),
    );
  }
  return objects;
}

function mapPackage(row: PackageRow) {
  const value = WorkflowPackageSchema.parse({
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    assignmentId: row.assignment_id,
    employeeId: row.employee_id,
    instanceId: row.instance_id,
    sceneId: row.scene_id,
    workflow: {
      kind: 'workflow',
      id: row.workflow_revision_id,
      workflowId: row.workflow_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      revision: row.revision,
      status: row.status,
      checksum: row.workflow_checksum,
      definition: row.definition,
      publishedAt: row.published_at?.toISOString() ?? null,
    },
    manifest: row.manifest,
    checksum: row.checksum,
    createdAt: row.created_at.toISOString(),
  });
  validateWorkflowPackageDefinition(value.workflow.definition, value.manifest);
  if (
    capabilityChecksum({
      name: value.workflow.name,
      description: value.workflow.description,
      definition: value.workflow.definition,
    }) !== value.workflow.checksum ||
    workflowPackageChecksum({
      workflowChecksum: value.workflow.checksum,
      manifest: value.manifest,
    }) !== value.checksum
  )
    throw new WorkflowPackageError('source_changed');
  return value;
}

function mapBinding(row: BindingRow) {
  return WorkflowPackageBindingSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    assignmentId: row.assignment_id,
    employeeId: row.employee_id,
    instanceId: row.instance_id,
    sceneId: row.scene_id,
    workflowRevisionId: row.workflow_revision_id,
    packageChecksum: row.package_checksum,
    revision: row.binding_revision,
    enabled: row.enabled,
    boundAt: row.bound_at.toISOString(),
  });
}

async function readPackage(
  scope: Scope,
  revisionId: string,
  sql: ContentSql,
  lock: boolean,
) {
  const [row] = await sql<
    PackageRow[]
  >`select p.*,r.workflow_id,w.slug,r.name,r.description,r.revision,
      r.status,r.checksum as workflow_checksum,r.definition,r.published_at,w.status as workflow_status
    from allrice_workflow_packages p join allrice_workflow_revisions r on r.id=p.workflow_revision_id
    join allrice_workflows w on w.id=r.workflow_id
    where p.workflow_revision_id=${revisionId} and p.organization_id=${scope.context.organizationId}
      and p.workspace_id=${scope.context.workspaceId} and p.owner_id=${scope.context.actor.id}
      and p.assignment_id=${scope.instance.assignmentId} and p.employee_id=${scope.employeeId}
      and p.instance_id=${scope.instance.id} and (p.scene_id is null or p.scene_id=${scope.sceneId})
    ${lock ? sql`for share of p,r,w` : sql``}`;
  if (!row) throw new WorkflowPackageError('not_found');
  return { row, package: mapPackage(row) };
}

async function resolution(
  scope: Scope,
  revisionId: string,
  sql: ContentSql,
  lock: boolean,
) {
  const value = await readPackage(scope, revisionId, sql, lock);
  const [bound] = await sql<
    BindingRow[]
  >`select * from allrice_employee_workflow_bindings
    where organization_id=${scope.context.organizationId} and workspace_id=${scope.context.workspaceId}
      and owner_id=${scope.context.actor.id} and assignment_id=${scope.instance.assignmentId}
      and instance_id=${scope.instance.id} and employee_id=${scope.employeeId}
      and scene_id is not distinct from ${value.package.sceneId}::uuid
      and workflow_revision_id=${revisionId} and package_checksum=${value.package.checksum}
    ${lock ? sql`for share` : sql``}`;
  const method = await readMethod(scope, value.package.manifest, sql, lock);
  let available =
    value.row.workflow_status === 'active' &&
    value.package.workflow.status === 'published' &&
    method.dto.available;
  try {
    await packageObjects(scope, value.package.manifest, sql, lock);
  } catch (error) {
    if (
      !(error instanceof WorkflowPackageError) ||
      error.code !== 'source_unavailable'
    )
      throw error;
    available = false;
  }
  return WorkflowPackageResolutionSchema.parse({
    package: value.package,
    binding: bound ? mapBinding(bound) : null,
    syncStatus: workflowPackageMethodSync(
      value.package.manifest,
      scope.references,
      available,
    ),
  });
}

/** Exact package reads retain immutable versions; only the current slot is enabled. */
export async function resolveWorkflowPackageForInstance(
  context: ContentIdentity,
  input: unknown,
  sql?: ContentSql,
  lock = false,
) {
  const request = WorkflowPackageSelectionSchema.parse(input);
  const run = async (transaction: ContentSql) => {
    const scope = await readScope(
      context,
      request,
      transaction,
      lock ? 'read' : false,
    );
    return resolution(scope, request.workflowRevisionId, transaction, lock);
  };
  if (sql) return run(sql);
  return lock
    ? getDatabase().begin((tx) => run(tx))
    : getDatabase().begin('isolation level repeatable read read only', (tx) =>
        run(tx),
      );
}

/** New Runs use the current exact pointer. Frozen Runs retain their original package. */
export async function assertWorkflowPackageExecution(
  context: ContentIdentity,
  input: unknown,
  sql?: ContentSql,
  lock = false,
) {
  const request = WorkflowPackageExecutionSelectionSchema.parse(input);
  const run = async (transaction: ContentSql) => {
    const scope = await readScope(
      context,
      request,
      transaction,
      lock ? 'read' : false,
      false,
      true,
    );
    const state = await resolution(
      scope,
      request.workflowRevisionId,
      transaction,
      lock,
    );
    if (
      state.syncStatus === 'source_unavailable' ||
      (request.frozenPackageDigest &&
        request.frozenPackageDigest !== state.package.checksum)
    )
      throw new WorkflowPackageError('source_unavailable');
    const [current] = await transaction<
      BindingRow[]
    >`select b.* from allrice_employee_workflow_bindings b
      join allrice_workflow_revisions current_revision on current_revision.id=b.workflow_revision_id
      where b.organization_id=${scope.context.organizationId} and b.workspace_id=${scope.context.workspaceId}
        and b.owner_id=${scope.context.actor.id} and b.assignment_id=${scope.instance.assignmentId}
        and b.employee_id=${scope.employeeId} and b.instance_id=${scope.instance.id}
        and b.scene_id is not distinct from ${state.package.sceneId}::uuid
        and b.workflow_id=${state.package.workflow.workflowId} and b.enabled and current_revision.status='published'
      ${lock ? transaction`for share of b,current_revision` : transaction``}`;
    if (
      !current ||
      (!request.frozenPackageDigest &&
        (current.workflow_revision_id !== state.package.workflow.id ||
          current.package_checksum !== state.package.checksum))
    )
      throw new WorkflowPackageError('source_unavailable');
    return WorkflowPackageResolutionSchema.parse({
      ...state,
      binding: mapBinding(current),
    });
  };
  if (sql) return run(sql);
  return lock
    ? getDatabase().begin((tx) => run(tx))
    : getDatabase().begin('isolation level repeatable read read only', (tx) =>
        run(tx),
      );
}

export async function listWorkflowPackages(
  context: ContentIdentity,
  input: {
    workspaceId: string;
    instanceId: string;
    sceneId?: string | null;
  },
) {
  const request = {
    workspaceId: UuidSchema.parse(input.workspaceId),
    instanceId: UuidSchema.parse(input.instanceId),
    sceneId:
      input.sceneId === undefined || input.sceneId === null
        ? null
        : UuidSchema.parse(input.sceneId),
  };
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      const scope = await readScope(context, request, tx, false);
      const rows = await tx<
        { workflow_revision_id: string }[]
      >`select p.workflow_revision_id
      from allrice_workflow_packages p join allrice_workflow_revisions r on r.id=p.workflow_revision_id
      where p.organization_id=${scope.context.organizationId} and p.workspace_id=${scope.context.workspaceId}
        and p.owner_id=${scope.context.actor.id} and p.assignment_id=${scope.instance.assignmentId}
        and p.instance_id=${scope.instance.id} and (p.scene_id is null or p.scene_id=${scope.sceneId})
      order by p.created_at desc,p.workflow_revision_id desc limit 100`;
      const packages = [];
      for (const row of rows)
        packages.push(
          await resolution(scope, row.workflow_revision_id, tx, false),
        );
      return packages;
    },
  );
}

/** Resolve original bytes again at use time, with current authority before and after IO. */
export async function readWorkflowPackageSourceForInstance(
  context: ContentIdentity,
  input: WorkflowPackageSelection,
  storage: StoragePort,
) {
  const state = await resolveWorkflowPackageForInstance(context, input);
  if (state.syncStatus === 'source_unavailable')
    throw new WorkflowPackageError('source_unavailable');
  const source = state.package.manifest.source;
  if (!source) return null;
  const prepared = await getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      const scope = await readScope(context, input, tx, false);
      const method = await readMethod(scope, state.package.manifest, tx, false);
      if (!method.dto.available || typeof method.dto.body !== 'string')
        throw new WorkflowPackageError('source_unavailable');
      const objects = await packageObjects(
        scope,
        state.package.manifest,
        tx,
        false,
      );
      return {
        methodBody: method.dto.body,
        object: objects.find((object) => object.id === source.objectId)!,
      };
    },
  );
  const bytes = await readWorkflowPackageObject(
    storage,
    prepared.object,
    512_000,
  );
  const decoded = validateWorkflowPackageSource(
    bytes,
    state.package.manifest,
    state.package.workflow.definition,
    prepared.methodBody,
  );
  const current = await resolveWorkflowPackageForInstance(context, input);
  if (
    current.syncStatus === 'source_unavailable' ||
    current.package.checksum !== state.package.checksum
  )
    throw new WorkflowPackageError('source_unavailable');
  return decoded;
}
