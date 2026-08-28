import { createHash } from 'node:crypto';

import {
  CapabilityCatalogSchema,
  CreateKnowledgeSourceInputSchema,
  CreateWorkflowInputSchema,
  EmployeeCapabilityDirectorySchema,
  FrozenKnowledgeBindingSchema,
  FrozenWorkflowBindingSchema,
  KnowledgeAclEntrySchema,
  KnowledgeRevisionSchema,
  ManageEmployeeCapabilitiesInputSchema,
  PublishKnowledgeRevisionInputSchema,
  PublishWorkflowRevisionInputSchema,
  UpdateCapabilityRevisionStatusInputSchema,
  UpdateCapabilityStatusInputSchema,
  UuidSchema,
  WorkflowRevisionSchema,
  type EmployeeCapabilityDirectory,
  type KnowledgeAclEntry,
  type RequestContext,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';
import { resolveWorkspaceId } from './workspace.ts';

type TransactionSql = postgres.TransactionSql;
type JsonValue = Parameters<TransactionSql['json']>[0];

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as JsonValue);
}

interface WorkflowRevisionRow {
  revision_id: string;
  workflow_id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  status: 'draft' | 'published' | 'deprecated' | 'revoked';
  checksum: string;
  definition: unknown;
  published_at: Date | null;
}

interface WorkflowBindingRow extends WorkflowRevisionRow {
  binding_id: string;
  binding_enabled: boolean;
  source_active: boolean;
  bound_by: string;
  bound_at: Date;
}

interface KnowledgeRevisionRow {
  revision_id: string;
  knowledge_source_id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  status: 'draft' | 'published' | 'deprecated' | 'revoked';
  checksum: string;
  definition: unknown;
  published_at: Date | null;
  principal_type: KnowledgeAclEntry['principalType'] | null;
  principal_id: string | null;
  permission: KnowledgeAclEntry['permission'] | null;
}

interface KnowledgeBindingRow extends KnowledgeRevisionRow {
  binding_id: string;
  binding_enabled: boolean;
  source_active: boolean;
  bound_by: string;
  bound_at: Date;
}

export class CapabilityRegistryError extends Error {
  constructor(
    public readonly code:
      'not_found' | 'version_conflict' | 'invalid_binding' | 'acl_denied',
  ) {
    super(code);
  }
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function requireCapabilityAdmin(context: RequestContext, workspaceId: string) {
  const userId = actorId(context);
  const allowed = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === userId &&
      membership.organizationId === context.organizationId &&
      membership.role === 'admin' &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
  if (!allowed) throw new DataAccessError('authorization_denied');
  return userId;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function capabilityChecksum(value: unknown) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function uniqueAcl(entries: KnowledgeAclEntry[]) {
  const sorted = [...entries].sort((left, right) =>
    `${left.principalType}:${left.principalId}:${left.permission}`.localeCompare(
      `${right.principalType}:${right.principalId}:${right.permission}`,
    ),
  );
  const keys = sorted.map(
    (entry) =>
      `${entry.principalType}:${entry.principalId}:${entry.permission}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new CapabilityRegistryError('invalid_binding');
  }
  return sorted;
}

async function validateKnowledgeAcl(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    acl: KnowledgeAclEntry[];
  },
) {
  const acl = uniqueAcl(input.acl);
  for (const entry of acl) {
    if (
      (entry.principalType === 'organization' &&
        entry.principalId !== input.organizationId) ||
      (entry.principalType === 'workspace' &&
        entry.principalId !== input.workspaceId)
    ) {
      throw new CapabilityRegistryError('invalid_binding');
    }
  }
  const employeeIds = acl
    .filter((entry) => entry.principalType === 'employee')
    .map((entry) => entry.principalId);
  if (employeeIds.length > 0) {
    const employees = await transaction<{ id: string }[]>`
      select id from allrice_employees
      where organization_id = ${input.organizationId}
        and workspace_id = ${input.workspaceId}
        and id in ${transaction(employeeIds)}
    `;
    if (
      new Set(employees.map((employee) => employee.id)).size !==
      employeeIds.length
    ) {
      throw new CapabilityRegistryError('invalid_binding');
    }
  }
  const userIds = acl
    .filter((entry) => entry.principalType === 'user')
    .map((entry) => entry.principalId);
  if (userIds.length > 0) {
    const users = await transaction<{ user_id: string }[]>`
      select distinct user_id from allrice_memberships
      where organization_id = ${input.organizationId}
        and (workspace_id is null or workspace_id = ${input.workspaceId})
        and active and user_id in ${transaction(userIds)}
    `;
    if (new Set(users.map((user) => user.user_id)).size !== userIds.length) {
      throw new CapabilityRegistryError('invalid_binding');
    }
  }
  return acl;
}

async function audit(
  transaction: TransactionSql,
  input: {
    context: RequestContext;
    workspaceId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    reason: string;
    metadata?: Record<string, unknown>;
  },
) {
  await transaction`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.context.organizationId}, ${input.workspaceId},
      ${actorId(input.context)}, ${input.action}, ${input.resourceType},
      ${input.resourceId}, 'allowed', ${input.reason},
      ${input.context.requestId},
      ${transaction.json(toJsonValue(input.metadata ?? {}))}
    )
  `;
}

function mapWorkflowRevision(row: WorkflowRevisionRow) {
  return WorkflowRevisionSchema.parse({
    kind: 'workflow',
    id: row.revision_id,
    workflowId: row.workflow_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    revision: row.revision,
    status: row.status,
    checksum: row.checksum,
    definition: row.definition,
    publishedAt: row.published_at?.toISOString() ?? null,
  });
}

function mapWorkflow(row: WorkflowBindingRow) {
  const disabledReason = !row.binding_enabled
    ? 'binding_disabled'
    : !row.source_active || row.status !== 'published'
      ? 'revision_unavailable'
      : null;
  return FrozenWorkflowBindingSchema.parse({
    bindingId: row.binding_id,
    revision: mapWorkflowRevision(row),
    effective: disabledReason === null,
    disabledReason,
    boundBy: row.bound_by,
    boundAt: row.bound_at.toISOString(),
  });
}

export function resolveEffectiveKnowledgeAcl(
  acl: KnowledgeAclEntry[],
  input: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    actorId: string;
  },
) {
  return acl.filter(
    (entry) =>
      (entry.principalType === 'organization' &&
        entry.principalId === input.organizationId) ||
      (entry.principalType === 'workspace' &&
        entry.principalId === input.workspaceId) ||
      (entry.principalType === 'employee' &&
        entry.principalId === input.employeeId) ||
      (entry.principalType === 'user' && entry.principalId === input.actorId),
  );
}

function mapKnowledge(
  rows: KnowledgeBindingRow[],
  input: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    actorId: string;
    adminView: boolean;
  },
) {
  const first = rows[0];
  if (!first) throw new CapabilityRegistryError('not_found');
  const acl = rows
    .filter((row) => row.principal_type && row.principal_id && row.permission)
    .map((row) =>
      KnowledgeAclEntrySchema.parse({
        principalType: row.principal_type,
        principalId: row.principal_id,
        permission: row.permission,
      }),
    );
  const effectiveAcl = resolveEffectiveKnowledgeAcl(acl, input);
  if (!input.adminView && effectiveAcl.length === 0) return null;
  const disabledReason = !first.binding_enabled
    ? 'binding_disabled'
    : !first.source_active || first.status !== 'published'
      ? 'revision_unavailable'
      : !input.adminView && effectiveAcl.length === 0
        ? 'acl_denied'
        : null;
  return FrozenKnowledgeBindingSchema.parse({
    bindingId: first.binding_id,
    revision: mapKnowledgeRevision(rows),
    effectiveAcl: input.adminView ? acl : effectiveAcl,
    effective: disabledReason === null,
    disabledReason,
    boundBy: first.bound_by,
    boundAt: first.bound_at.toISOString(),
  });
}

function mapKnowledgeRevision(rows: KnowledgeRevisionRow[]) {
  const first = rows[0];
  if (!first) throw new CapabilityRegistryError('not_found');
  const acl = rows
    .filter((row) => row.principal_type && row.principal_id && row.permission)
    .map((row) =>
      KnowledgeAclEntrySchema.parse({
        principalType: row.principal_type,
        principalId: row.principal_id,
        permission: row.permission,
      }),
    );
  return KnowledgeRevisionSchema.parse({
    kind: 'knowledge',
    id: first.revision_id,
    knowledgeSourceId: first.knowledge_source_id,
    slug: first.slug,
    name: first.name,
    description: first.description,
    revision: first.revision,
    status: first.status,
    checksum: first.checksum,
    definition: first.definition,
    acl,
    publishedAt: first.published_at?.toISOString() ?? null,
  });
}

async function loadEmployeeCapabilityDirectory(input: {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  actorId: string;
  adminView: boolean;
}): Promise<EmployeeCapabilityDirectory> {
  const sql = getDatabase();
  const [workflowRows, knowledgeRows] = await Promise.all([
    sql<WorkflowBindingRow[]>`
      select b.id as binding_id, b.bound_by, b.bound_at,
        b.enabled as binding_enabled, (w.status = 'active') as source_active,
        r.id as revision_id, w.id as workflow_id, w.slug,
        r.name, r.description, r.revision, r.status, r.checksum,
        r.definition, r.published_at
      from allrice_employee_workflow_bindings b
      join allrice_workflow_revisions r on r.id = b.workflow_revision_id
      join allrice_workflows w on w.id = r.workflow_id
      where b.organization_id = ${input.organizationId}
        and b.workspace_id = ${input.workspaceId}
        and b.employee_id = ${input.employeeId}
        and b.enabled
        and (${input.adminView} or (
          w.status = 'active' and r.status = 'published'
        ))
      order by w.name, r.revision, b.id
    `,
    sql<KnowledgeBindingRow[]>`
      select b.id as binding_id, b.bound_by, b.bound_at,
        b.enabled as binding_enabled, (s.status = 'active') as source_active,
        r.id as revision_id, s.id as knowledge_source_id, s.slug,
        r.name, r.description, r.revision, r.status, r.checksum,
        r.definition, r.published_at,
        a.principal_type, a.principal_id, a.permission
      from allrice_employee_knowledge_bindings b
      join allrice_knowledge_revisions r on r.id = b.knowledge_revision_id
      join allrice_knowledge_sources s on s.id = r.knowledge_source_id
      left join allrice_knowledge_acl_entries a
        on a.knowledge_revision_id = r.id
      where b.organization_id = ${input.organizationId}
        and b.workspace_id = ${input.workspaceId}
        and b.employee_id = ${input.employeeId}
        and b.enabled
        and (${input.adminView} or (
          s.status = 'active' and r.status = 'published'
        ))
      order by s.name, r.revision, b.id, a.principal_type, a.principal_id
    `,
  ]);
  const groupedKnowledge = new Map<string, KnowledgeBindingRow[]>();
  for (const row of knowledgeRows) {
    const current = groupedKnowledge.get(row.binding_id) ?? [];
    current.push(row);
    groupedKnowledge.set(row.binding_id, current);
  }
  const knowledge = [...groupedKnowledge.values()]
    .map((rows) => mapKnowledge(rows, input))
    .filter((binding) => binding !== null);
  return EmployeeCapabilityDirectorySchema.parse({
    employeeId: input.employeeId,
    agentSkills: [],
    workflows: workflowRows.map(mapWorkflow),
    knowledge,
  });
}

export async function listCapabilityCatalog(
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  requireCapabilityAdmin(context, workspaceId);
  const sql = getDatabase();
  const [workflowRows, knowledgeRows] = await Promise.all([
    sql<WorkflowRevisionRow[]>`
      select distinct on (w.id)
        r.id as revision_id, w.id as workflow_id, w.slug,
        r.name, r.description, r.revision, r.status, r.checksum,
        r.definition, r.published_at
      from allrice_workflows w
      join allrice_workflow_revisions r on r.workflow_id = w.id
      where w.organization_id = ${context.organizationId}
        and w.workspace_id = ${workspaceId}
        and w.status = 'active' and r.status = 'published'
      order by w.id, r.revision desc
    `,
    sql<KnowledgeRevisionRow[]>`
      with latest as (
        select distinct on (s.id)
          r.id as revision_id, s.id as knowledge_source_id, s.slug,
          r.name, r.description, r.revision, r.status, r.checksum,
          r.definition, r.published_at
        from allrice_knowledge_sources s
        join allrice_knowledge_revisions r on r.knowledge_source_id = s.id
        where s.organization_id = ${context.organizationId}
          and s.workspace_id = ${workspaceId}
          and s.status = 'active' and r.status = 'published'
        order by s.id, r.revision desc
      )
      select latest.*, a.principal_type, a.principal_id, a.permission
      from latest
      left join allrice_knowledge_acl_entries a
        on a.knowledge_revision_id = latest.revision_id
      order by latest.name, latest.revision, latest.revision_id,
        a.principal_type, a.principal_id
    `,
  ]);
  const groupedKnowledge = new Map<string, KnowledgeRevisionRow[]>();
  for (const row of knowledgeRows) {
    const current = groupedKnowledge.get(row.revision_id) ?? [];
    current.push(row);
    groupedKnowledge.set(row.revision_id, current);
  }
  return CapabilityCatalogSchema.parse({
    agentSkills: [],
    workflows: workflowRows.map(mapWorkflowRevision),
    knowledge: [...groupedKnowledge.values()].map(mapKnowledgeRevision),
  });
}

export async function updateCapabilityStatus(
  context: RequestContext,
  capabilityIdInput: string,
  input: unknown,
) {
  const update = UpdateCapabilityStatusInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  requireCapabilityAdmin(context, workspaceId);
  const capabilityId = UuidSchema.parse(capabilityIdInput);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const rows =
      update.kind === 'workflow'
        ? await transaction<{ id: string }[]>`
            update allrice_workflows set status = ${update.status},
              updated_at = now()
            where id = ${capabilityId}
              and organization_id = ${context.organizationId}
              and workspace_id = ${workspaceId}
            returning id
          `
        : await transaction<{ id: string }[]>`
            update allrice_knowledge_sources set status = ${update.status},
              updated_at = now()
            where id = ${capabilityId}
              and organization_id = ${context.organizationId}
              and workspace_id = ${workspaceId}
            returning id
          `;
    if (!rows[0]) throw new CapabilityRegistryError('not_found');
    await audit(transaction, {
      context,
      workspaceId,
      action: `${update.kind}.status.update`,
      resourceType: update.kind,
      resourceId: capabilityId,
      reason: 'admin_updated_capability_status',
      metadata: { status: update.status },
    });
  });
  return { id: capabilityId, kind: update.kind, status: update.status };
}

export async function updateCapabilityRevisionStatus(
  context: RequestContext,
  revisionIdInput: string,
  input: unknown,
) {
  const update = UpdateCapabilityRevisionStatusInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  requireCapabilityAdmin(context, workspaceId);
  const revisionId = UuidSchema.parse(revisionIdInput);
  if (update.kind === 'agent_skill') {
    throw new CapabilityRegistryError('invalid_binding');
  }
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const rows =
      update.kind === 'workflow'
        ? await transaction<{ id: string }[]>`
              update allrice_workflow_revisions set status = ${update.status}
              where id = ${revisionId}
                and organization_id = ${context.organizationId}
                and workspace_id = ${workspaceId}
                and status in ('published', 'deprecated')
              returning id
            `
        : await transaction<{ id: string }[]>`
              update allrice_knowledge_revisions set status = ${update.status}
              where id = ${revisionId}
                and organization_id = ${context.organizationId}
                and workspace_id = ${workspaceId}
                and status in ('published', 'deprecated')
              returning id
            `;
    if (!rows[0]) throw new CapabilityRegistryError('not_found');
    await audit(transaction, {
      context,
      workspaceId,
      action: `${update.kind}.revision.status.update`,
      resourceType: `${update.kind}_revision`,
      resourceId: revisionId,
      reason: 'admin_updated_capability_revision_status',
      metadata: { status: update.status },
    });
  });
  return { id: revisionId, kind: update.kind, status: update.status };
}

export async function listEmployeeCapabilities(
  context: RequestContext,
  workspaceIdInput: string,
  employeeIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const userId = requireCapabilityAdmin(context, workspaceId);
  const employeeId = UuidSchema.parse(employeeIdInput);
  const sql = getDatabase();
  const employees = await sql<{ id: string }[]>`
    select id from allrice_employees
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId} and id = ${employeeId}
  `;
  if (!employees[0]) throw new CapabilityRegistryError('not_found');
  return loadEmployeeCapabilityDirectory({
    organizationId: context.organizationId,
    workspaceId,
    employeeId,
    actorId: userId,
    adminView: true,
  });
}

export async function resolveEmployeeCapabilitiesForRun(input: {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  actorId: string;
}) {
  return loadEmployeeCapabilityDirectory({
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    employeeId: UuidSchema.parse(input.employeeId),
    actorId: UuidSchema.parse(input.actorId),
    adminView: false,
  });
}

export async function createWorkflow(context: RequestContext, input: unknown) {
  const creation = CreateWorkflowInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, creation.workspaceId);
  const userId = requireCapabilityAdmin(context, workspaceId);
  const checksum = capabilityChecksum({
    name: creation.name,
    description: creation.description,
    definition: creation.definition,
  });
  const sql = getDatabase();
  try {
    return await sql.begin(async (transaction) => {
      const workflows = await transaction<{ id: string }[]>`
        insert into allrice_workflows (
          organization_id, workspace_id, slug, name, description, created_by
        ) values (
          ${context.organizationId}, ${workspaceId}, ${creation.slug},
          ${creation.name}, ${creation.description}, ${userId}
        ) returning id
      `;
      const workflowId = workflows[0]?.id;
      if (!workflowId) throw new Error('workflow creation failed');
      const revisions = await transaction<WorkflowBindingRow[]>`
        insert into allrice_workflow_revisions (
          organization_id, workspace_id, workflow_id, revision,
          name, description, status, definition, checksum,
          created_by, published_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${workflowId}, 1,
          ${creation.name}, ${creation.description}, 'published',
          ${transaction.json(toJsonValue(creation.definition))}, ${checksum},
          ${userId}, now()
        ) returning id as revision_id, workflow_id, name, description,
          revision, status, checksum, definition, published_at,
          ${creation.slug}::text as slug,
          ${userId}::uuid as bound_by, now() as bound_at,
          gen_random_uuid() as binding_id
      `;
      const revision = revisions[0];
      if (!revision) throw new Error('workflow revision creation failed');
      await audit(transaction, {
        context,
        workspaceId,
        action: 'workflow.create',
        resourceType: 'workflow',
        resourceId: workflowId,
        reason: 'admin_created_immutable_workflow_revision',
        metadata: { revisionId: revision.revision_id, checksum },
      });
      return mapWorkflow(revision).revision;
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new CapabilityRegistryError('version_conflict');
    }
    throw error;
  }
}

export async function publishWorkflowRevision(
  context: RequestContext,
  workflowIdInput: string,
  input: unknown,
) {
  const publication = PublishWorkflowRevisionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(
    context,
    publication.workspaceId,
  );
  const userId = requireCapabilityAdmin(context, workspaceId);
  const workflowId = UuidSchema.parse(workflowIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const workflows = await transaction<
      { id: string; slug: string; name: string; description: string }[]
    >`
      select id, slug, name, description from allrice_workflows
      where id = ${workflowId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and status = 'active'
      for update
    `;
    const workflow = workflows[0];
    if (!workflow) throw new CapabilityRegistryError('not_found');
    const nextRows = await transaction<{ revision: number }[]>`
      select coalesce(max(revision), 0)::integer + 1 as revision
      from allrice_workflow_revisions where workflow_id = ${workflow.id}
    `;
    const name = publication.name ?? workflow.name;
    const description = publication.description ?? workflow.description;
    const checksum = capabilityChecksum({
      name,
      description,
      definition: publication.definition,
    });
    const revisions = await transaction<WorkflowBindingRow[]>`
      insert into allrice_workflow_revisions (
        organization_id, workspace_id, workflow_id, revision,
        name, description, status, definition, checksum,
        created_by, published_at
      ) values (
        ${context.organizationId}, ${workspaceId}, ${workflow.id},
        ${nextRows[0]?.revision ?? 1}, ${name}, ${description}, 'published',
        ${transaction.json(toJsonValue(publication.definition))}, ${checksum},
        ${userId}, now()
      ) returning id as revision_id, workflow_id, name, description,
        revision, status, checksum, definition, published_at,
        ${workflow.slug}::text as slug,
        ${userId}::uuid as bound_by, now() as bound_at,
        gen_random_uuid() as binding_id
    `;
    const revision = revisions[0];
    if (!revision) throw new Error('workflow revision publication failed');
    await transaction`
      update allrice_workflows set name = ${name}, description = ${description},
        updated_at = now() where id = ${workflow.id}
    `;
    await audit(transaction, {
      context,
      workspaceId,
      action: 'workflow.revision.publish',
      resourceType: 'workflow_revision',
      resourceId: revision.revision_id,
      reason: 'admin_published_immutable_workflow_revision',
      metadata: { workflowId: workflow.id, checksum },
    });
    return mapWorkflow(revision).revision;
  });
}

export async function createKnowledgeSource(
  context: RequestContext,
  input: unknown,
) {
  const creation = CreateKnowledgeSourceInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, creation.workspaceId);
  const userId = requireCapabilityAdmin(context, workspaceId);
  const sql = getDatabase();
  try {
    return await sql.begin(async (transaction) => {
      const acl = await validateKnowledgeAcl(transaction, {
        organizationId: context.organizationId,
        workspaceId,
        acl: creation.acl,
      });
      const checksum = capabilityChecksum({
        name: creation.name,
        description: creation.description,
        definition: creation.definition,
        acl,
      });
      const sources = await transaction<{ id: string }[]>`
        insert into allrice_knowledge_sources (
          organization_id, workspace_id, slug, name, description, created_by
        ) values (
          ${context.organizationId}, ${workspaceId}, ${creation.slug},
          ${creation.name}, ${creation.description}, ${userId}
        ) returning id
      `;
      const sourceId = sources[0]?.id;
      if (!sourceId) throw new Error('knowledge source creation failed');
      const revisions = await transaction<{ id: string }[]>`
        insert into allrice_knowledge_revisions (
          organization_id, workspace_id, knowledge_source_id, revision,
          name, description, status, definition, checksum,
          created_by, published_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${sourceId}, 1,
          ${creation.name}, ${creation.description}, 'draft',
          ${transaction.json(toJsonValue(creation.definition))}, ${checksum},
          ${userId}, null
        ) returning id
      `;
      const revision = revisions[0];
      if (!revision) throw new Error('knowledge revision creation failed');
      for (const entry of acl) {
        await transaction`
          insert into allrice_knowledge_acl_entries (
            organization_id, workspace_id, knowledge_revision_id,
            principal_type, principal_id, permission
          ) values (
            ${context.organizationId}, ${workspaceId}, ${revision.id},
            ${entry.principalType}, ${entry.principalId}, ${entry.permission}
          )
        `;
      }
      const published = await transaction<{ published_at: Date }[]>`
        update allrice_knowledge_revisions
        set status = 'published', published_at = now()
        where id = ${revision.id} and status = 'draft'
        returning published_at
      `;
      const publishedAt = published[0]?.published_at;
      if (!publishedAt)
        throw new Error('knowledge revision publication failed');
      await audit(transaction, {
        context,
        workspaceId,
        action: 'knowledge.create',
        resourceType: 'knowledge_source',
        resourceId: sourceId,
        reason: 'admin_created_immutable_knowledge_revision',
        metadata: { revisionId: revision.id, checksum },
      });
      return KnowledgeRevisionSchema.parse({
        kind: 'knowledge',
        id: revision.id,
        knowledgeSourceId: sourceId,
        slug: creation.slug,
        name: creation.name,
        description: creation.description,
        revision: 1,
        status: 'published',
        checksum,
        definition: creation.definition,
        acl,
        publishedAt: publishedAt.toISOString(),
      });
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new CapabilityRegistryError('version_conflict');
    }
    throw error;
  }
}

export async function publishKnowledgeRevision(
  context: RequestContext,
  sourceIdInput: string,
  input: unknown,
) {
  const publication = PublishKnowledgeRevisionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(
    context,
    publication.workspaceId,
  );
  const userId = requireCapabilityAdmin(context, workspaceId);
  const sourceId = UuidSchema.parse(sourceIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const sources = await transaction<
      { id: string; slug: string; name: string; description: string }[]
    >`
      select id, slug, name, description from allrice_knowledge_sources
      where id = ${sourceId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and status = 'active'
      for update
    `;
    const source = sources[0];
    if (!source) throw new CapabilityRegistryError('not_found');
    const acl = await validateKnowledgeAcl(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      acl: publication.acl,
    });
    const nextRows = await transaction<{ revision: number }[]>`
      select coalesce(max(revision), 0)::integer + 1 as revision
      from allrice_knowledge_revisions
      where knowledge_source_id = ${source.id}
    `;
    const revisionNumber = nextRows[0]?.revision ?? 1;
    const name = publication.name ?? source.name;
    const description = publication.description ?? source.description;
    const checksum = capabilityChecksum({
      name,
      description,
      definition: publication.definition,
      acl,
    });
    const revisions = await transaction<{ id: string }[]>`
      insert into allrice_knowledge_revisions (
        organization_id, workspace_id, knowledge_source_id, revision,
        name, description, status, definition, checksum,
        created_by, published_at
      ) values (
        ${context.organizationId}, ${workspaceId}, ${source.id},
        ${revisionNumber}, ${name}, ${description}, 'draft',
        ${transaction.json(toJsonValue(publication.definition))}, ${checksum},
        ${userId}, null
      ) returning id
    `;
    const revision = revisions[0];
    if (!revision) throw new Error('knowledge revision publication failed');
    for (const entry of acl) {
      await transaction`
        insert into allrice_knowledge_acl_entries (
          organization_id, workspace_id, knowledge_revision_id,
          principal_type, principal_id, permission
        ) values (
          ${context.organizationId}, ${workspaceId}, ${revision.id},
          ${entry.principalType}, ${entry.principalId}, ${entry.permission}
        )
      `;
    }
    const published = await transaction<{ published_at: Date }[]>`
      update allrice_knowledge_revisions
      set status = 'published', published_at = now()
      where id = ${revision.id} and status = 'draft'
      returning published_at
    `;
    const publishedAt = published[0]?.published_at;
    if (!publishedAt) throw new Error('knowledge revision publication failed');
    await transaction`
      update allrice_knowledge_sources set name = ${name},
        description = ${description}, updated_at = now()
      where id = ${source.id}
    `;
    await audit(transaction, {
      context,
      workspaceId,
      action: 'knowledge.revision.publish',
      resourceType: 'knowledge_revision',
      resourceId: revision.id,
      reason: 'admin_published_immutable_knowledge_revision',
      metadata: { knowledgeSourceId: source.id, checksum },
    });
    return KnowledgeRevisionSchema.parse({
      kind: 'knowledge',
      id: revision.id,
      knowledgeSourceId: source.id,
      slug: source.slug,
      name,
      description,
      revision: revisionNumber,
      status: 'published',
      checksum,
      definition: publication.definition,
      acl,
      publishedAt: publishedAt.toISOString(),
    });
  });
}

export async function manageEmployeeCapabilities(
  context: RequestContext,
  input: unknown,
) {
  const update = ManageEmployeeCapabilitiesInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const userId = requireCapabilityAdmin(context, workspaceId);
  const employeeId = UuidSchema.parse(update.employeeId);
  const skillVersionIds: string[] = [];
  const workflowRevisionIds = [...new Set(update.workflowRevisionIds)].sort();
  const knowledgeRevisionIds = [...new Set(update.knowledgeRevisionIds)].sort();
  if (
    update.agentSkills.length > 0 ||
    workflowRevisionIds.length !== update.workflowRevisionIds.length ||
    knowledgeRevisionIds.length !== update.knowledgeRevisionIds.length
  ) {
    throw new CapabilityRegistryError('invalid_binding');
  }
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string }[]>`
      select id from allrice_employees
      where id = ${employeeId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and status = 'active'
      for update
    `;
    if (!employees[0]) throw new CapabilityRegistryError('not_found');

    if (workflowRevisionIds.length > 0) {
      const rows = await transaction<{ id: string }[]>`
        select r.id from allrice_workflow_revisions r
        join allrice_workflows w on w.id = r.workflow_id
        where r.organization_id = ${context.organizationId}
          and r.workspace_id = ${workspaceId}
          and r.id in ${transaction(workflowRevisionIds)}
          and r.status = 'published' and w.status = 'active'
      `;
      if (
        new Set(rows.map((row) => row.id)).size !== workflowRevisionIds.length
      ) {
        throw new CapabilityRegistryError('invalid_binding');
      }
    }

    if (knowledgeRevisionIds.length > 0) {
      const rows = await transaction<{ id: string }[]>`
        select r.id from allrice_knowledge_revisions r
        join allrice_knowledge_sources s on s.id = r.knowledge_source_id
        where r.organization_id = ${context.organizationId}
          and r.workspace_id = ${workspaceId}
          and r.id in ${transaction(knowledgeRevisionIds)}
          and r.status = 'published' and s.status = 'active'
      `;
      if (
        new Set(rows.map((row) => row.id)).size !== knowledgeRevisionIds.length
      ) {
        throw new CapabilityRegistryError('invalid_binding');
      }
    }

    await transaction`
      update allrice_employee_workflow_bindings set enabled = false,
        updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and employee_id = ${employeeId}
    `;
    await transaction`
      update allrice_employee_knowledge_bindings set enabled = false,
        updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and employee_id = ${employeeId}
    `;

    for (const revisionId of workflowRevisionIds) {
      await transaction`
        insert into allrice_employee_workflow_bindings (
          organization_id, workspace_id, employee_id,
          workflow_revision_id, enabled, bound_by, bound_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${employeeId},
          ${revisionId}, true, ${userId}, now()
        )
        on conflict (organization_id, workspace_id, employee_id, workflow_revision_id)
        do update set enabled = true, bound_by = excluded.bound_by,
          bound_at = excluded.bound_at, updated_at = now()
      `;
    }
    for (const revisionId of knowledgeRevisionIds) {
      await transaction`
        insert into allrice_employee_knowledge_bindings (
          organization_id, workspace_id, employee_id,
          knowledge_revision_id, enabled, bound_by, bound_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${employeeId},
          ${revisionId}, true, ${userId}, now()
        )
        on conflict (organization_id, workspace_id, employee_id, knowledge_revision_id)
        do update set enabled = true, bound_by = excluded.bound_by,
          bound_at = excluded.bound_at, updated_at = now()
      `;
    }
    await transaction`
      update allrice_employees
      set skill_bindings_managed_at = now(), updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and id = ${employeeId}
    `;
    await audit(transaction, {
      context,
      workspaceId,
      action: 'employee.capabilities.manage',
      resourceType: 'employee',
      resourceId: employeeId,
      reason: 'admin_replaced_employee_capability_bindings',
      metadata: {
        skillVersionIds,
        workflowRevisionIds,
        knowledgeRevisionIds,
      },
    });
  });
  return listEmployeeCapabilities(context, workspaceId, employeeId);
}

export async function synchronizeEmployeeSkillBindings(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    skillVersionIds: string[];
    actorId: string;
  },
) {
  const skillVersionIds = [...new Set(input.skillVersionIds)].sort();
  if (skillVersionIds.length > 0) {
    throw new CapabilityRegistryError('invalid_binding');
  }
  await transaction`
    update allrice_employees
    set skill_bindings_managed_at = now(), updated_at = now()
    where organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId} and id = ${input.employeeId}
  `;
}
