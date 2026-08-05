import {
  AssignEmployeeVersionInputSchema,
  CodexExecutionSnapshotSchema,
  EmployeeHubAssignmentSchema,
  EmployeeManifestSchema,
  EmployeePromptSnapshotSchema,
  EmployeeVersionSnapshotSchema,
  FrozenEmployeeSkillBindingSchema,
  PublishEmployeeVersionInputSchema,
  SetDefaultEmployeeInputSchema,
  StorageObjectSchema,
  UuidSchema,
  type EmployeeManifest,
  type RequestContext,
  type SkillCapability,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import {
  employeeManifestChecksum,
  riceEmployeeKey,
  riceManifest,
} from './employee-config.ts';
import { getDatabase } from './index.ts';
import { ensureDefaultEmployee, resolveWorkspaceId } from './workspace.ts';

interface EmployeeVersionRow {
  id: string;
  employee_id: string;
  version: number;
  name: string;
  description: string;
  model: string;
  system_prompt: string;
  capabilities: unknown;
  manifest: unknown;
  provider_snapshot: unknown;
  skill_version_ids: unknown;
  config_checksum: string;
  published_at: Date;
}

interface EmployeeAssignmentRow extends EmployeeVersionRow {
  assignment_id: string;
  employee_key: string;
  user_id: string;
  organization_id: string;
  workspace_id: string;
  is_default: boolean;
  active: boolean;
}

interface SkillBindingRow {
  installation_id: string;
  skill_version_id: string;
  granted_capabilities: SkillCapability[];
}

export interface FrozenSkillBinding {
  installationId: string;
  skillVersionId: string;
  grantedCapabilities: SkillCapability[];
}

export interface EmployeeRunBinding {
  employeeAssignmentId: string;
  employeeVersionId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  providerSnapshot: ReturnType<typeof CodexExecutionSnapshotSchema.parse>;
  skillVersionIds: string[];
  skillBindings: FrozenSkillBinding[];
  promptSnapshot: {
    systemPrompt: string;
    conversation: { role: string; text: string }[];
    memories: { id: string; content: string }[];
    userRequest: string;
  };
}

export class EmployeeHubError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'version_conflict'
      | 'skill_not_installed'
      | 'provider_invalid',
  ) {
    super(code);
  }
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function requireAdmin(context: RequestContext, workspaceId: string) {
  const actorId = userId(context);
  const allowed = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actorId &&
      membership.organizationId === context.organizationId &&
      membership.role === 'admin' &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
  if (!allowed) throw new DataAccessError('authorization_denied');
  return actorId;
}

function legacyManifest(row: EmployeeVersionRow): EmployeeManifest {
  return EmployeeManifestSchema.parse({
    schemaVersion: 1,
    key: riceEmployeeKey,
    name: row.name,
    description: row.description || 'MET-50 同步基础员工版本（历史只读）。',
    systemPrompt: row.system_prompt,
    provider: {
      provider: 'basic',
      authMode: 'none',
      model: 'allrice/basic-assistant-v1',
      reasoningEffort: 'none',
      sandbox: 'none',
    },
    capabilities: [],
    skillVersionIds: [],
  });
}

function versionSnapshot(row: EmployeeVersionRow) {
  const parsed = EmployeeManifestSchema.safeParse(row.manifest);
  return EmployeeVersionSnapshotSchema.parse({
    id: row.id,
    employeeId: row.employee_id,
    version: row.version,
    manifest: parsed.success ? parsed.data : legacyManifest(row),
    configChecksum: row.config_checksum,
    publishedAt: row.published_at.toISOString(),
  });
}

export async function listEmployeeHub(
  context: RequestContext,
  workspaceIdInput?: string,
) {
  const defaultAssignment = await ensureDefaultEmployee(
    context,
    workspaceIdInput,
  );
  const workspaceId = defaultAssignment.workspaceId;
  const sql = getDatabase();
  const assignments = await sql<EmployeeAssignmentRow[]>`
    select
      a.id as assignment_id, a.user_id, a.organization_id, a.workspace_id,
      a.is_default, a.active, e.employee_key,
      v.*
    from allrice_employee_assignments a
    join allrice_employees e on e.id = a.employee_id
    join allrice_employee_versions v on v.id = a.employee_version_id
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.user_id = ${userId(context)}
      and a.active
    order by a.is_default desc, e.name, a.id
  `;
  const employeeIds = [...new Set(assignments.map((row) => row.employee_id))];
  const versions =
    employeeIds.length === 0
      ? []
      : await sql<EmployeeVersionRow[]>`
          select * from allrice_employee_versions
          where organization_id = ${context.organizationId}
            and workspace_id = ${workspaceId}
            and employee_id in ${sql(employeeIds)}
          order by employee_id, version desc
        `;
  const skills = await sql<
    {
      installation_id: string;
      skill_version_id: string;
      name: string;
      version: string;
      enabled: boolean;
    }[]
  >`
    select i.id as installation_id, v.id as skill_version_id,
      c.name, v.version, i.enabled
    from allrice_skill_installations i
    join allrice_skill_versions v on v.id = i.pinned_version_id
    join allrice_catalog_skills c on c.id = i.catalog_skill_id
    where i.organization_id = ${context.organizationId}
      and i.workspace_id = ${workspaceId}
      and i.owner_id = ${userId(context)}
      and v.status = 'published'
    order by c.name, v.version
  `;
  return {
    organizationId: context.organizationId,
    workspaceId,
    assignments: assignments.map((assignment) =>
      EmployeeHubAssignmentSchema.parse({
        id: assignment.assignment_id,
        employeeId: assignment.employee_id,
        employeeKey: assignment.employee_key,
        userId: assignment.user_id,
        organizationId: assignment.organization_id,
        workspaceId: assignment.workspace_id,
        isDefault: assignment.is_default,
        active: assignment.active,
        currentVersion: versionSnapshot(assignment),
        versions: versions
          .filter((version) => version.employee_id === assignment.employee_id)
          .map(versionSnapshot),
      }),
    ),
    availableSkills: skills.map((skill) => ({
      installationId: skill.installation_id,
      skillVersionId: skill.skill_version_id,
      name: skill.name,
      version: skill.version,
      enabled: skill.enabled,
    })),
  };
}

export async function publishEmployeeVersion(
  context: RequestContext,
  input: unknown,
) {
  const publication = PublishEmployeeVersionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(
    context,
    publication.workspaceId,
  );
  const actorId = requireAdmin(context, workspaceId);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string; employee_key: string }[]>`
      select id, employee_key from allrice_employees
      where id = ${publication.employeeId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and status = 'active'
      for update
    `;
    const employee = employees[0];
    if (!employee || employee.employee_key !== riceEmployeeKey) {
      throw new EmployeeHubError('not_found');
    }
    const skillVersionIds = [...new Set(publication.skillVersionIds)].sort();
    if (skillVersionIds.length > 0) {
      const installed = await transaction<{ id: string }[]>`
        select v.id
        from allrice_skill_versions v
        join allrice_skill_installations i
          on i.pinned_version_id = v.id
         and i.organization_id = v.organization_id
         and i.workspace_id = v.workspace_id
        where v.id in ${transaction(skillVersionIds)}
          and v.organization_id = ${context.organizationId}
          and v.workspace_id = ${workspaceId}
          and v.status = 'published'
          and i.owner_id = ${actorId} and i.enabled
      `;
      if (
        new Set(installed.map((row) => row.id)).size !== skillVersionIds.length
      ) {
        throw new EmployeeHubError('skill_not_installed');
      }
    }
    const manifest = riceManifest(skillVersionIds);
    const checksum = employeeManifestChecksum(manifest);
    const next = await transaction<{ version: number }[]>`
      select coalesce(max(version), 0)::integer + 1 as version
      from allrice_employee_versions where employee_id = ${employee.id}
    `;
    let versions;
    try {
      versions = await transaction<EmployeeVersionRow[]>`
        insert into allrice_employee_versions (
          organization_id, workspace_id, employee_id, version, name,
          description, model, system_prompt, capabilities, manifest,
          provider_snapshot, skill_version_ids, config_checksum
        ) values (
          ${context.organizationId}, ${workspaceId}, ${employee.id},
          ${next[0]?.version ?? 1}, ${manifest.name}, ${manifest.description},
          ${manifest.provider.model}, ${manifest.systemPrompt},
          ${transaction.json(manifest.capabilities)},
          ${transaction.json(manifest)},
          ${transaction.json(manifest.provider)},
          ${transaction.json(manifest.skillVersionIds)}, ${checksum}
        ) returning *
      `;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new EmployeeHubError('version_conflict');
      }
      throw error;
    }
    const version = versions[0];
    if (!version) throw new Error('employee version publication failed');
    await transaction`
      update allrice_employee_assignments
      set employee_version_id = ${version.id}, updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and employee_id = ${employee.id}
        and user_id = ${actorId} and active
    `;
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.version.publish', 'employee_version', ${version.id},
        'allowed', 'admin_published_immutable_manifest', ${context.requestId},
        ${transaction.json({ checksum, skillVersionIds })}
      )
    `;
    return versionSnapshot(version);
  });
}

export async function assignEmployeeVersion(
  context: RequestContext,
  assignmentIdInput: string,
  input: unknown,
) {
  const update = AssignEmployeeVersionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = userId(context);
  const assignmentId = UuidSchema.parse(assignmentIdInput);
  const sql = getDatabase();
  const rows = await sql<EmployeeAssignmentRow[]>`
    update allrice_employee_assignments a
    set employee_version_id = ${update.employeeVersionId}, updated_at = now()
    from allrice_employee_versions v, allrice_employees e
    where a.id = ${assignmentId}
      and a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.user_id = ${actorId} and a.active
      and v.id = ${update.employeeVersionId}
      and v.organization_id = a.organization_id
      and v.workspace_id = a.workspace_id
      and v.employee_id = a.employee_id
      and v.provider_snapshot ->> 'provider' = 'codex'
      and e.id = a.employee_id
    returning a.id as assignment_id, a.user_id, a.organization_id,
      a.workspace_id, a.is_default, a.active, e.employee_key, v.*
  `;
  const row = rows[0];
  if (!row) throw new EmployeeHubError('not_found');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actorId},
      'employee.assignment.version', 'employee_assignment', ${assignmentId},
      'allowed', 'owner_selected_published_version', ${context.requestId},
      ${sql.json({ employeeVersionId: update.employeeVersionId })}
    )
  `;
  return versionSnapshot(row);
}

export async function setDefaultEmployee(
  context: RequestContext,
  assignmentIdInput: string,
  input: unknown,
) {
  const update = SetDefaultEmployeeInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = userId(context);
  const assignmentId = UuidSchema.parse(assignmentIdInput);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const target = await transaction<{ id: string }[]>`
      select id from allrice_employee_assignments
      where id = ${assignmentId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and user_id = ${actorId} and active
      for update
    `;
    if (!target[0]) throw new EmployeeHubError('not_found');
    await transaction`
      update allrice_employee_assignments set is_default = false,
        updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and user_id = ${actorId}
        and active and is_default
    `;
    await transaction`
      update allrice_employee_assignments set is_default = true,
        updated_at = now() where id = ${assignmentId}
    `;
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.assignment.default', 'employee_assignment', ${assignmentId},
        'allowed', 'owner_explicit_default', ${context.requestId}
      )
    `;
  });
}

export async function prepareEmployeeRunBinding(input: {
  context: RequestContext;
  workspaceId: string;
  assignmentId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  promptSnapshot: EmployeeRunBinding['promptSnapshot'];
}): Promise<EmployeeRunBinding> {
  const actorId = userId(input.context);
  const sql = getDatabase();
  const rows = await sql<EmployeeAssignmentRow[]>`
    select a.id as assignment_id, a.user_id, a.organization_id,
      a.workspace_id, a.is_default, a.active, e.employee_key, v.*
    from allrice_employee_assignments a
    join allrice_employees e on e.id = a.employee_id
    join allrice_employee_versions v on v.id = a.employee_version_id
    where a.id = ${UuidSchema.parse(input.assignmentId)}
      and a.organization_id = ${input.context.organizationId}
      and a.workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and a.user_id = ${actorId} and a.active
  `;
  const assignment = rows[0];
  if (!assignment) throw new EmployeeHubError('not_found');
  const manifest = EmployeeManifestSchema.safeParse(assignment.manifest);
  if (!manifest.success || manifest.data.provider.provider !== 'codex') {
    throw new EmployeeHubError('provider_invalid');
  }
  const skillVersionIds = manifest.data.skillVersionIds;
  const bindings =
    skillVersionIds.length === 0
      ? []
      : await sql<SkillBindingRow[]>`
          select i.id as installation_id, v.id as skill_version_id,
            i.granted_capabilities
          from allrice_skill_versions v
          join allrice_skill_installations i
            on i.pinned_version_id = v.id
           and i.organization_id = v.organization_id
           and i.workspace_id = v.workspace_id
          join allrice_storage_objects o on o.id = v.artifact_object_id
          where v.id in ${sql(skillVersionIds)}
            and v.organization_id = ${input.context.organizationId}
            and v.workspace_id = ${input.workspaceId}
            and v.status = 'published' and o.state = 'ready' and o.immutable
            and i.owner_id = ${actorId} and i.enabled
        `;
  if (
    new Set(bindings.map((binding) => binding.skill_version_id)).size !==
    skillVersionIds.length
  ) {
    throw new EmployeeHubError('skill_not_installed');
  }
  return {
    employeeAssignmentId: assignment.assignment_id,
    employeeVersionId: assignment.id,
    sessionId: UuidSchema.parse(input.sessionId),
    userMessageId: UuidSchema.parse(input.userMessageId),
    assistantMessageId: UuidSchema.parse(input.assistantMessageId),
    providerSnapshot: CodexExecutionSnapshotSchema.parse(
      manifest.data.provider,
    ),
    skillVersionIds,
    skillBindings: bindings.map((binding) => ({
      installationId: binding.installation_id,
      skillVersionId: binding.skill_version_id,
      grantedCapabilities: binding.granted_capabilities,
    })),
    promptSnapshot: EmployeePromptSnapshotSchema.parse({
      ...input.promptSnapshot,
      systemPrompt: manifest.data.systemPrompt,
    }),
  };
}

export async function resolveEmployeeExecution(input: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  runId: string;
}) {
  const sql = getDatabase();
  const rows = await sql<
    {
      provider_snapshot: unknown;
      skill_bindings: unknown;
      prompt_snapshot: unknown;
      system_prompt: string;
    }[]
  >`
    select er.provider_snapshot, er.skill_bindings, er.prompt_snapshot,
      v.system_prompt
    from allrice_employee_runs er
    join allrice_employee_versions v on v.id = er.employee_version_id
    where er.run_id = ${UuidSchema.parse(input.runId)}
      and er.organization_id = ${UuidSchema.parse(input.organizationId)}
      and er.workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and er.owner_id = ${UuidSchema.parse(input.ownerId)}
  `;
  const row = rows[0];
  if (!row) throw new EmployeeHubError('not_found');
  const skillBindings = FrozenEmployeeSkillBindingSchema.array().parse(
    row.skill_bindings,
  );
  const promptSnapshot = EmployeePromptSnapshotSchema.parse(
    row.prompt_snapshot,
  );
  const artifacts = [];
  for (const binding of skillBindings) {
    const objects = await sql<
      {
        id: string;
        organization_id: string;
        workspace_id: string;
        owner_id: string;
        object_key: string;
        checksum: string;
        media_type: string;
        size_bytes: number | string;
        retention_until: Date | null;
        deleted_at: Date | null;
        immutable: boolean;
      }[]
    >`
      select o.*
      from allrice_skill_versions v
      join allrice_storage_objects o on o.id = v.artifact_object_id
      where v.id = ${UuidSchema.parse(binding.skillVersionId)}
        and v.organization_id = ${input.organizationId}
        and v.workspace_id = ${input.workspaceId}
        and o.state = 'ready' and o.immutable
    `;
    const object = objects[0];
    if (!object) throw new EmployeeHubError('not_found');
    artifacts.push({
      skillVersionId: binding.skillVersionId,
      grantedCapabilities: binding.grantedCapabilities,
      storageObject: StorageObjectSchema.parse({
        id: object.id,
        organizationId: object.organization_id,
        workspaceId: object.workspace_id,
        ownerId: object.owner_id,
        key: object.object_key,
        checksum: object.checksum,
        mediaType: object.media_type,
        sizeBytes: Number(object.size_bytes),
        retentionUntil: object.retention_until?.toISOString() ?? null,
        deletedAt: object.deleted_at?.toISOString() ?? null,
        immutable: object.immutable,
      }),
    });
  }
  return {
    providerSnapshot: CodexExecutionSnapshotSchema.parse(row.provider_snapshot),
    promptSnapshot,
    skillArtifacts: artifacts,
    grantedCapabilities: [
      ...new Set(
        skillBindings.flatMap((binding) => binding.grantedCapabilities),
      ),
    ],
  };
}
