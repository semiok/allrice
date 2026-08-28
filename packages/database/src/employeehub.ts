import { randomUUID } from 'node:crypto';

import {
  AssignEmployeeVersionInputSchema,
  CreateEmployeeInputSchema,
  DshNativeSkillSnapshotSchema,
  EmployeeAdminDirectoryEntrySchema,
  EmployeeAdminMemberSchema,
  EmployeeExecutionSnapshotSchema,
  EmployeeHubAssignmentSchema,
  EmployeeManifestSchema,
  EmployeePromptSnapshotSchema,
  EmployeeRuntimePolicySchema,
  EmployeeUserProfileSchema,
  EmployeeUserProfilePolicySchema,
  EmployeeVersionSnapshotSchema,
  FrozenEmployeeSkillBindingSchema,
  HarnessExecutionSnapshotSchema,
  ManageEmployeeAssignmentsInputSchema,
  PublishEmployeeVersionInputSchema,
  SetDefaultEmployeeInputSchema,
  UpdateEmployeeStatusInputSchema,
  UuidSchema,
  type EmployeeManifest,
  type EmployeeExecutionSnapshot,
  type RequestContext,
  type SkillCapability,
  type StorageObjectSchema,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import {
  resolveEmployeeCapabilitiesForRun,
  synchronizeEmployeeSkillBindings,
} from './capability-registry.ts';
import {
  applyEmployeeUserProfilePolicy,
  employeeManifest,
  employeeManifestChecksum,
  riceEmployeeKey,
} from './employee-config.ts';
import { getDatabase } from './index.ts';
import { freezeSessionModelSnapshot } from './model-pool.ts';
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
  assigned_by: string | null;
  assigned_at: Date;
}

interface EmployeeDirectoryRow extends EmployeeVersionRow {
  employee_key: string;
  status: 'active' | 'archived';
  assigned_user_ids: string[];
}

export interface FrozenSkillBinding {
  installationId: string;
  skillVersionId: string;
  declaredCapabilities: SkillCapability[];
  grantedCapabilities: SkillCapability[];
}

const skillGatedCapabilities = new Set<SkillCapability>([
  'network:outbound',
  'storage:write',
  'secret:use',
]);

export function resolveEmployeeCapabilities(
  employeeCapabilities: SkillCapability[],
  skillBindings: FrozenSkillBinding[],
  deniedCapabilities: SkillCapability[] = [],
) {
  const denied = new Set(deniedCapabilities);
  const skillGranted = new Set(
    skillBindings.flatMap((binding) =>
      binding.grantedCapabilities.filter((capability) =>
        binding.declaredCapabilities.includes(capability),
      ),
    ),
  );
  return employeeCapabilities.filter(
    (capability) =>
      !denied.has(capability) &&
      (!skillGatedCapabilities.has(capability) || skillGranted.has(capability)),
  );
}

export interface EmployeeRunBinding {
  employeeAssignmentId: string;
  employeeVersionId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  providerSnapshot: ReturnType<typeof HarnessExecutionSnapshotSchema.parse>;
  skillVersionIds: string[];
  skillBindings: FrozenSkillBinding[];
  nativeSkills: ReturnType<typeof DshNativeSkillSnapshotSchema.parse>[];
  executionSnapshot: Omit<
    Extract<EmployeeExecutionSnapshot, { schemaVersion: 2 }>,
    'tenantContext' | 'createdAt'
  >;
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
      | 'provider_invalid'
      | 'default_protected'
      | 'assignment_invalid',
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

export function canAdministerEmployees(
  context: RequestContext,
  workspaceId: string,
) {
  const actorId = userId(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actorId &&
      membership.organizationId === context.organizationId &&
      membership.role === 'admin' &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function requireEmployeeAdmin(context: RequestContext, workspaceId: string) {
  const actorId = userId(context);
  if (!canAdministerEmployees(context, workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  return actorId;
}

function runtimePolicy(manifest: EmployeeManifest) {
  if (manifest.schemaVersion === 2) return manifest.runtimePolicy;
  return {
    harness: 'dsh' as const,
    provider: 'openai-codex' as const,
    model: manifest.provider.model,
    reasoningEffort: manifest.provider.reasoningEffort,
    timeoutMs: 300_000,
    fallbackModels: [],
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
  };
}

function capabilityBindings(manifest: EmployeeManifest) {
  return manifest.schemaVersion === 2
    ? manifest.capabilityBindings
    : {
        skillVersionIds: manifest.skillVersionIds,
        toolNames: [],
        knowledgeScopes: ['workspace' as const, 'user' as const],
        workflowIds: [],
      };
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

const privateEmployeeFields = new Set([
  'credentialReference',
  'credential_reference',
  'baseUrl',
  'base_url',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
]);

/**
 * EmployeeHub is a tenant surface. Provider credentials and deployment
 * endpoints are owned by the platform model pool and must never be serialized
 * into employee or workspace responses, even for a tenant administrator.
 */
export function redactEmployeeSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactEmployeeSecrets(item)) as T;
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !privateEmployeeFields.has(key))
      .map(([key, item]) => [key, redactEmployeeSecrets(item)]),
  ) as T;
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
  const canAdminister = canAdministerEmployees(context, workspaceId);
  const sql = getDatabase();
  const assignments = await sql<EmployeeAssignmentRow[]>`
    select
      a.id as assignment_id, a.user_id, a.organization_id, a.workspace_id,
      a.is_default, a.active, a.assigned_by, a.assigned_at, e.employee_key,
      v.*
    from allrice_employee_assignments a
    join allrice_employees e on e.id = a.employee_id
    join allrice_employee_versions v on v.id = a.employee_version_id
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.user_id = ${userId(context)}
      and a.active
      and e.status = 'active'
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
    select id as installation_id, id as skill_version_id,
      name, 'native'::text as version, enabled
    from allrice_dsh_skills
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
    order by name, id
  `;
  const memoryCounts = await sql<{ employee_id: string; count: number }[]>`
    select employee_id, count(*)::integer
    from allrice_memories
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and employee_id is not null
      and archived_at is null
    group by employee_id
  `;
  const memoryCountByEmployee = new Map(
    memoryCounts.map((row) => [row.employee_id, row.count]),
  );
  const directory = canAdminister
    ? await sql<EmployeeDirectoryRow[]>`
        select distinct on (e.id)
          v.*, e.employee_key, e.status,
          coalesce((
            select array_agg(a.user_id order by a.user_id)
            from allrice_employee_assignments a
            where a.organization_id = e.organization_id
              and a.workspace_id = e.workspace_id
              and a.employee_id = e.id and a.active
          ), array[]::uuid[]) as assigned_user_ids
        from allrice_employees e
        join allrice_employee_versions v on v.employee_id = e.id
        where e.organization_id = ${context.organizationId}
          and e.workspace_id = ${workspaceId}
        order by e.id, v.version desc
      `
    : [];
  const members = canAdminister
    ? await sql<
        {
          user_id: string;
          email: string;
          display_name: string;
          role: 'admin' | 'member' | 'viewer';
        }[]
      >`
        select distinct on (u.id)
          u.id as user_id, u.email, u.display_name, m.role
        from allrice_users u
        join allrice_memberships m on m.user_id = u.id
        where m.organization_id = ${context.organizationId}
          and (m.workspace_id is null or m.workspace_id = ${workspaceId})
          and m.active and u.status = 'active'
        order by u.id,
          case m.role when 'admin' then 0 when 'member' then 1 else 2 end
      `
    : [];
  return {
    organizationId: context.organizationId,
    workspaceId,
    canAdminister,
    assignments: assignments.map((assignment) =>
      redactEmployeeSecrets(
        EmployeeHubAssignmentSchema.parse({
          id: assignment.assignment_id,
          employeeId: assignment.employee_id,
          employeeKey: assignment.employee_key,
          userId: assignment.user_id,
          organizationId: assignment.organization_id,
          workspaceId: assignment.workspace_id,
          isDefault: assignment.is_default,
          active: assignment.active,
          assignedBy: assignment.assigned_by,
          assignedAt: assignment.assigned_at.toISOString(),
          memoryCount: memoryCountByEmployee.get(assignment.employee_id) ?? 0,
          currentVersion: versionSnapshot(assignment),
          versions: versions
            .filter((version) => version.employee_id === assignment.employee_id)
            .map(versionSnapshot),
        }),
      ),
    ),
    availableSkills: (canAdminister ? skills : []).map((skill) => ({
      installationId: skill.installation_id,
      skillVersionId: skill.skill_version_id,
      name: skill.name,
      version: skill.version,
      enabled: skill.enabled,
    })),
    directory: directory.map((entry) =>
      redactEmployeeSecrets(
        EmployeeAdminDirectoryEntrySchema.parse({
          employeeId: entry.employee_id,
          employeeKey: entry.employee_key,
          status: entry.status,
          currentVersion: versionSnapshot(entry),
          assignedUserIds: entry.assigned_user_ids,
        }),
      ),
    ),
    members: members.map((member) =>
      EmployeeAdminMemberSchema.parse({
        userId: member.user_id,
        email: member.email,
        displayName: member.display_name,
        role: member.role,
      }),
    ),
  };
}

export async function createEmployee(context: RequestContext, input: unknown) {
  const creation = CreateEmployeeInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, creation.workspaceId);
  const actorId = requireEmployeeAdmin(context, workspaceId);
  const employeeKey = `employee-${randomUUID().slice(0, 8)}`;
  const manifest = employeeManifest({
    key: employeeKey,
    name: creation.name,
    description: creation.description,
    skillVersionIds: creation.skillVersionIds,
    partnerProfile: creation.partnerProfile,
    appearance: creation.appearance,
    applicableScenarios: creation.applicableScenarios,
    behaviorRules: creation.behaviorRules,
    safetyBoundaries: creation.safetyBoundaries,
  });
  const checksum = employeeManifestChecksum(manifest);
  const sql = getDatabase();
  const employeeId = await sql.begin(async (transaction) => {
    if (creation.skillVersionIds.length > 0) {
      throw new EmployeeHubError('skill_not_installed');
    }
    const employees = await transaction<{ id: string }[]>`
      insert into allrice_employees (
        organization_id, workspace_id, employee_key, name
      ) values (
        ${context.organizationId}, ${workspaceId}, ${employeeKey}, ${creation.name}
      ) returning id
    `;
    const createdId = employees[0]?.id;
    if (!createdId) throw new Error('employee creation failed');
    const versions = await transaction<{ id: string }[]>`
      insert into allrice_employee_versions (
        organization_id, workspace_id, employee_id, version, name,
        description, model, system_prompt, capabilities, manifest,
        provider_snapshot, skill_version_ids, config_checksum
      ) values (
        ${context.organizationId}, ${workspaceId}, ${createdId}, 1,
        ${manifest.name}, ${manifest.description}, ${manifest.provider.model},
        ${manifest.systemPrompt}, ${transaction.json(manifest.capabilities)},
        ${transaction.json(manifest)}, ${transaction.json(manifest.provider)},
        ${transaction.json(manifest.skillVersionIds)}, ${checksum}
      ) returning id
    `;
    const versionId = versions[0]?.id;
    if (!versionId) throw new Error('employee version creation failed');
    await transaction`
      insert into allrice_employee_assignments (
        organization_id, workspace_id, employee_id, employee_version_id,
        user_id, is_default, active, assigned_by
      ) values (
        ${context.organizationId}, ${workspaceId}, ${createdId}, ${versionId},
        ${actorId}, false, true, ${actorId}
      )
    `;
    await synchronizeEmployeeSkillBindings(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      employeeId: createdId,
      skillVersionIds: manifest.skillVersionIds,
      actorId,
    });
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.create', 'employee', ${createdId}, 'allowed',
        'admin_created_employee_definition', ${context.requestId},
        ${transaction.json({ employeeKey, skillVersionIds: manifest.skillVersionIds })}
      )
    `;
    return createdId;
  });
  const hub = await listEmployeeHub(context, workspaceId);
  const assignment = hub.assignments.find(
    (item) => item.employeeId === employeeId,
  );
  if (!assignment) throw new Error('created employee assignment missing');
  return assignment;
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
  const actorId = requireEmployeeAdmin(context, workspaceId);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const employees = await transaction<
      { id: string; employee_key: string; name: string }[]
    >`
      select e.id, e.employee_key, e.name
      from allrice_employees e
      where e.id = ${publication.employeeId}
        and e.organization_id = ${context.organizationId}
        and e.workspace_id = ${workspaceId}
        and e.status = 'active'
      for update
    `;
    const employee = employees[0];
    if (!employee) {
      throw new EmployeeHubError('not_found');
    }
    const selectedSkillRows = (publication.skillVersionIds ?? []).map(
      (skillVersionId) => ({ skill_version_id: skillVersionId }),
    );
    const skillVersionIds = [
      ...new Set(selectedSkillRows.map((row) => row.skill_version_id)),
    ].sort();
    if (skillVersionIds.length > 0) {
      throw new EmployeeHubError('skill_not_installed');
    }
    const current = await transaction<{ manifest: unknown }[]>`
      select manifest from allrice_employee_versions
      where employee_id = ${employee.id}
      order by version desc
      limit 1
    `;
    const currentManifest = EmployeeManifestSchema.safeParse(
      current[0]?.manifest,
    );
    const manifest = employeeManifest({
      key: employee.employee_key,
      name: employee.name,
      description:
        currentManifest.success && currentManifest.data.description
          ? currentManifest.data.description
          : `${employee.name}，根据你的目标使用已授权 Skill 完成工作。`,
      skillVersionIds,
      partnerProfile:
        publication.partnerProfile ??
        (currentManifest.success
          ? currentManifest.data.partnerProfile
          : undefined),
      appearance:
        publication.appearance ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.appearance
          : undefined),
      applicableScenarios:
        publication.applicableScenarios ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.applicableScenarios
          : undefined),
      behaviorRules:
        publication.behaviorRules ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.identity.behaviorRules
          : undefined),
      safetyBoundaries:
        publication.safetyBoundaries ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.identity.safetyBoundaries
          : undefined),
      identity:
        publication.identity ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.identity
          : undefined),
      runtimePolicy:
        publication.runtimePolicy ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.runtimePolicy
          : undefined),
      securityPolicy:
        publication.securityPolicy ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.securityPolicy
          : undefined),
      userProfilePolicy:
        publication.userProfilePolicy ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.userProfilePolicy
          : undefined),
      toolNames:
        publication.toolNames ??
        (currentManifest.success && currentManifest.data.schemaVersion === 2
          ? currentManifest.data.capabilityBindings.toolNames
          : undefined),
    });
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
    const assignedVersions = await transaction<
      { employee_version_id: string }[]
    >`
      select employee_version_id from allrice_employee_assignments
      where organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and employee_id = ${employee.id} and active
      order by updated_at desc limit 1
    `;
    const stableVersionId =
      assignedVersions[0]?.employee_version_id ?? version.id;
    await transaction`
      insert into allrice_employee_releases (
        organization_id, workspace_id, employee_id, stable_version_id,
        candidate_version_id, stage, traffic_percentage, gate_status
      ) values (
        ${context.organizationId}, ${workspaceId}, ${employee.id},
        ${stableVersionId}, ${version.id}, 'draft', 0, 'pending'
      ) on conflict (organization_id, workspace_id, employee_id) do update set
        candidate_version_id = excluded.candidate_version_id,
        stage = 'draft', traffic_percentage = 0, gate_status = 'pending',
        approved_by = null, approved_at = null, updated_at = now()
    `;
    await synchronizeEmployeeSkillBindings(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      employeeId: employee.id,
      skillVersionIds: manifest.skillVersionIds,
      actorId,
    });
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.version.publish', 'employee_version', ${version.id},
        'allowed', 'admin_published_immutable_candidate', ${context.requestId},
        ${transaction.json({ checksum, skillVersionIds, partnerProfile: manifest.partnerProfile, stableVersionId })}
      )
    `;
    return versionSnapshot(version);
  });
}

export async function manageEmployeeAssignments(
  context: RequestContext,
  input: unknown,
) {
  const update = ManageEmployeeAssignmentsInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = requireEmployeeAdmin(context, workspaceId);
  const userIds = [...new Set(update.userIds)].sort();
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const employees = await transaction<
      {
        id: string;
        employee_key: string;
        status: 'active' | 'archived';
        version_id: string;
      }[]
    >`
      select e.id, e.employee_key, e.status, v.id as version_id
      from allrice_employees e
      join lateral (
        select id from allrice_employee_versions
        where employee_id = e.id
        order by version desc limit 1
      ) v on true
      where e.id = ${update.employeeId}
        and e.organization_id = ${context.organizationId}
        and e.workspace_id = ${workspaceId}
      for update of e
    `;
    const employee = employees[0];
    if (!employee || employee.status !== 'active') {
      throw new EmployeeHubError('not_found');
    }
    if (employee.employee_key === riceEmployeeKey) {
      throw new EmployeeHubError('default_protected');
    }
    if (userIds.length > 0) {
      const members = await transaction<{ user_id: string }[]>`
        select distinct user_id
        from allrice_memberships
        where organization_id = ${context.organizationId}
          and (workspace_id is null or workspace_id = ${workspaceId})
          and active and user_id in ${transaction(userIds)}
      `;
      if (
        new Set(members.map((member) => member.user_id)).size !== userIds.length
      ) {
        throw new EmployeeHubError('assignment_invalid');
      }
    }
    const removedDefaults =
      userIds.length === 0
        ? await transaction<{ user_id: string }[]>`
            update allrice_employee_assignments
            set active = false, is_default = false, updated_at = now()
            where organization_id = ${context.organizationId}
              and workspace_id = ${workspaceId}
              and employee_id = ${employee.id} and active
            returning user_id
          `
        : await transaction<{ user_id: string }[]>`
            update allrice_employee_assignments
            set active = false, is_default = false, updated_at = now()
            where organization_id = ${context.organizationId}
              and workspace_id = ${workspaceId}
              and employee_id = ${employee.id} and active
              and user_id not in ${transaction(userIds)}
            returning user_id
          `;
    for (const assignedUserId of userIds) {
      await transaction`
        insert into allrice_employee_assignments (
          organization_id, workspace_id, employee_id, employee_version_id,
          user_id, is_default, active, assigned_by, assigned_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${employee.id},
          ${employee.version_id}, ${assignedUserId}, false, true,
          ${actorId}, now()
        )
        on conflict (organization_id, workspace_id, user_id, employee_id)
        do update set employee_version_id = excluded.employee_version_id,
          active = true, assigned_by = excluded.assigned_by,
          assigned_at = excluded.assigned_at, updated_at = now()
      `;
    }
    for (const removed of removedDefaults) {
      await transaction`
        update allrice_employee_assignments rice
        set is_default = true, active = true, updated_at = now()
        from allrice_employees e
        where e.id = rice.employee_id
          and e.organization_id = rice.organization_id
          and e.workspace_id = rice.workspace_id
          and e.employee_key = ${riceEmployeeKey}
          and rice.organization_id = ${context.organizationId}
          and rice.workspace_id = ${workspaceId}
          and rice.user_id = ${removed.user_id}
          and not exists (
            select 1 from allrice_employee_assignments current_default
            where current_default.organization_id = rice.organization_id
              and current_default.workspace_id = rice.workspace_id
              and current_default.user_id = rice.user_id
              and current_default.active and current_default.is_default
          )
      `;
    }
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.assignment.manage', 'employee', ${employee.id}, 'allowed',
        'admin_managed_employee_assignments', ${context.requestId},
        ${transaction.json({ userIds })}
      )
    `;
  });
  return listEmployeeHub(context, workspaceId);
}

export async function updateEmployeeStatus(
  context: RequestContext,
  employeeIdInput: string,
  input: unknown,
) {
  const update = UpdateEmployeeStatusInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = requireEmployeeAdmin(context, workspaceId);
  const employeeId = UuidSchema.parse(employeeIdInput);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const employees = await transaction<{ id: string; employee_key: string }[]>`
      select id, employee_key from allrice_employees
      where id = ${employeeId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
      for update
    `;
    const employee = employees[0];
    if (!employee) throw new EmployeeHubError('not_found');
    if (
      employee.employee_key === riceEmployeeKey &&
      update.status !== 'active'
    ) {
      throw new EmployeeHubError('default_protected');
    }
    await transaction`
      update allrice_employees set status = ${update.status}, updated_at = now()
      where id = ${employee.id}
    `;
    const removed =
      update.status === 'archived'
        ? await transaction<{ user_id: string }[]>`
        update allrice_employee_assignments
        set active = false, is_default = false, updated_at = now()
        where organization_id = ${context.organizationId}
          and workspace_id = ${workspaceId}
          and employee_id = ${employee.id}
          and active
        returning user_id
      `
        : [];
    for (const assignment of removed) {
      await transaction`
        update allrice_employee_assignments rice
        set is_default = true, active = true, updated_at = now()
        from allrice_employees e
        where e.id = rice.employee_id
          and e.organization_id = rice.organization_id
          and e.workspace_id = rice.workspace_id
          and e.employee_key = ${riceEmployeeKey}
          and rice.organization_id = ${context.organizationId}
          and rice.workspace_id = ${workspaceId}
          and rice.user_id = ${assignment.user_id}
          and not exists (
            select 1 from allrice_employee_assignments current_default
            where current_default.organization_id = rice.organization_id
              and current_default.workspace_id = rice.workspace_id
              and current_default.user_id = rice.user_id
              and current_default.active and current_default.is_default
          )
      `;
    }
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'employee.status.update', 'employee', ${employee.id}, 'allowed',
        'admin_updated_employee_status', ${context.requestId},
        ${transaction.json({ status: update.status })}
      )
    `;
  });
}

export async function assignEmployeeVersion(
  context: RequestContext,
  assignmentIdInput: string,
  input: unknown,
) {
  const update = AssignEmployeeVersionInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = requireEmployeeAdmin(context, workspaceId);
  const assignmentId = UuidSchema.parse(assignmentIdInput);
  const sql = getDatabase();
  const rows = await sql<EmployeeAssignmentRow[]>`
    update allrice_employee_assignments a
    set employee_version_id = ${update.employeeVersionId}, updated_at = now()
    from allrice_employee_versions v, allrice_employees e
    where a.id = ${assignmentId}
      and a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.active
      and v.id = ${update.employeeVersionId}
      and v.organization_id = a.organization_id
      and v.workspace_id = a.workspace_id
      and v.employee_id = a.employee_id
      and v.provider_snapshot ->> 'provider' in ('codex', 'dsh')
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
      'allowed', 'admin_selected_published_version', ${context.requestId},
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
  employeeVersionId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  promptSnapshot: EmployeeRunBinding['promptSnapshot'];
}): Promise<EmployeeRunBinding> {
  const actorId = userId(input.context);
  const sql = getDatabase();
  const rows = await sql<EmployeeAssignmentRow[]>`
    select a.id as assignment_id, a.user_id, a.organization_id,
      a.workspace_id, a.is_default, a.active, a.assigned_by, a.assigned_at,
      e.employee_key, v.*
    from allrice_employee_assignments a
    join allrice_employees e on e.id = a.employee_id
    join allrice_employee_versions v
      on v.id = ${UuidSchema.parse(input.employeeVersionId)}
     and v.employee_id = a.employee_id
     and v.organization_id = a.organization_id
     and v.workspace_id = a.workspace_id
    where a.id = ${UuidSchema.parse(input.assignmentId)}
      and a.organization_id = ${input.context.organizationId}
      and a.workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and a.user_id = ${actorId} and a.active
  `;
  const assignment = rows[0];
  if (!assignment) throw new EmployeeHubError('not_found');
  const manifest = EmployeeManifestSchema.safeParse(assignment.manifest);
  if (
    !manifest.success ||
    (manifest.data.provider.provider !== 'codex' &&
      manifest.data.provider.provider !== 'dsh')
  ) {
    throw new EmployeeHubError('provider_invalid');
  }
  const capabilityDirectory = await resolveEmployeeCapabilitiesForRun({
    organizationId: input.context.organizationId,
    workspaceId: input.workspaceId,
    employeeId: assignment.employee_id,
    actorId,
  });
  const skillBindings: EmployeeRunBinding['skillBindings'] = [];
  const skillVersionIds: string[] = [];
  const grantedCapabilities = resolveEmployeeCapabilities(
    manifest.data.capabilities,
    skillBindings,
    manifest.data.schemaVersion === 2
      ? manifest.data.securityPolicy.deniedCapabilities
      : [],
  );
  const profiles = await sql<{ profile: unknown; display_name: string }[]>`
    select coalesce(p.profile, jsonb_build_object(
        'schemaVersion', 1,
        'displayName', u.display_name,
        'preferences', '{}'::jsonb
      )) as profile,
      u.display_name
    from allrice_users u
    left join allrice_employee_user_profiles p
      on p.user_id = u.id
     and p.organization_id = ${input.context.organizationId}
     and p.workspace_id = ${input.workspaceId}
     and p.employee_id = ${assignment.employee_id}
    where u.id = ${actorId}
  `;
  const storedUserProfile = EmployeeUserProfileSchema.parse(
    profiles[0]?.profile ?? {
      schemaVersion: 1,
      displayName: null,
      preferences: {},
    },
  );
  const userProfilePolicy = EmployeeUserProfilePolicySchema.parse(
    manifest.data.schemaVersion === 2
      ? manifest.data.userProfilePolicy
      : {
          enabled: true,
          fields: ['displayName', 'preferences'],
          scope: 'employee_user',
        },
  );
  const userProfile = applyEmployeeUserProfilePolicy(
    storedUserProfile,
    userProfilePolicy,
  );
  const modelSnapshot = await freezeSessionModelSnapshot({
    organizationId: input.context.organizationId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
  const providerRoute =
    modelSnapshot.harness === 'codex' ||
    modelSnapshot.provider === 'codex' ||
    modelSnapshot.provider === 'openai-codex'
      ? 'openai-codex'
      : modelSnapshot.provider === 'deepseek' ||
          modelSnapshot.provider === 'deepseek-official'
        ? 'deepseek-official'
        : 'openai-compatible';
  const providerSnapshot = HarnessExecutionSnapshotSchema.parse({
    provider: 'dsh',
    authMode:
      providerRoute === 'openai-codex'
        ? 'platform_subscription'
        : 'allrice_credential',
    route: providerRoute,
    model: modelSnapshot.model,
    reasoningEffort:
      modelSnapshot.reasoningEffort === 'none'
        ? 'low'
        : modelSnapshot.reasoningEffort,
    credentialReference:
      modelSnapshot.credentialReference ?? 'deployment:codex-default',
    baseUrl: providerRoute === 'openai-codex' ? null : modelSnapshot.baseUrl,
  });
  const selectedRuntimePolicy = EmployeeRuntimePolicySchema.parse({
    ...runtimePolicy(manifest.data),
    harness: 'dsh',
    provider: providerRoute,
    model: modelSnapshot.model,
    reasoningEffort:
      modelSnapshot.reasoningEffort === 'none'
        ? 'low'
        : modelSnapshot.reasoningEffort,
    credentialReference:
      modelSnapshot.credentialReference ?? 'deployment:codex-default',
    baseUrl: providerRoute === 'openai-codex' ? null : modelSnapshot.baseUrl,
    fallbackModels: [],
    timeoutMs: modelSnapshot.runLimits.timeoutMs,
  });
  const nativeSkillRows = await sql<
    {
      id: string;
      name: string;
      description: string;
      content: string;
      checksum: string;
      model_invocable: boolean;
      user_invocable: boolean;
      required_tool_refs: unknown;
    }[]
  >`
    select skill.id, skill.name, skill.description, skill.content,
      skill.checksum, skill.model_invocable, skill.user_invocable,
      skill.required_tool_refs
    from allrice_employee_dsh_skill_bindings binding
    join allrice_dsh_skills skill
      on skill.organization_id = binding.organization_id
     and skill.workspace_id = binding.workspace_id
     and skill.id = binding.skill_id
    where binding.organization_id = ${input.context.organizationId}
      and binding.workspace_id = ${input.workspaceId}
      and binding.employee_id = ${assignment.employee_id}
      and binding.enabled and skill.enabled
    order by skill.name, skill.id
  `;
  const nativeSkills = nativeSkillRows.map((skill) =>
    DshNativeSkillSnapshotSchema.parse({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      checksum: skill.checksum,
      invocation: {
        modelInvocable: skill.model_invocable,
        userInvocable: skill.user_invocable,
      },
      requiredToolRefs: skill.required_tool_refs,
    }),
  );
  return {
    employeeAssignmentId: assignment.assignment_id,
    employeeVersionId: assignment.id,
    sessionId: UuidSchema.parse(input.sessionId),
    userMessageId: UuidSchema.parse(input.userMessageId),
    assistantMessageId: UuidSchema.parse(input.assistantMessageId),
    providerSnapshot,
    skillVersionIds,
    skillBindings,
    nativeSkills,
    executionSnapshot: {
      schemaVersion: 2,
      employee: {
        id: assignment.employee_id,
        key: assignment.employee_key,
        versionId: assignment.id,
        revision: assignment.version,
        definitionChecksum: assignment.config_checksum,
        definition: manifest.data,
      },
      assignment: {
        id: assignment.assignment_id,
        userId: assignment.user_id,
        assignedBy: assignment.assigned_by,
        assignedAt: assignment.assigned_at.toISOString(),
      },
      runtimePolicy: selectedRuntimePolicy,
      modelSnapshot,
      capabilitySnapshot: {
        declaredCapabilities: manifest.data.capabilities,
        grantedCapabilities,
        bindings: {
          ...capabilityBindings(manifest.data),
          skillVersionIds,
          knowledgeScopes: [
            ...new Set(
              capabilityDirectory.knowledge.flatMap(
                (binding) => binding.revision.definition.allowedScopes,
              ),
            ),
          ],
          workflowIds: capabilityDirectory.workflows.map(
            (binding) => binding.revision.id,
          ),
        },
        skillBindings:
          FrozenEmployeeSkillBindingSchema.array().parse(skillBindings),
        agentSkills: [],
        workflows: capabilityDirectory.workflows,
        knowledge: capabilityDirectory.knowledge,
        resolvedForActorId: actorId,
      },
      userProfile,
    },
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
      native_skills: unknown;
      execution_snapshot: unknown;
      system_prompt: string;
      manifest: unknown;
    }[]
  >`
    select er.provider_snapshot, er.skill_bindings, er.native_skills,
      er.prompt_snapshot,
      er.execution_snapshot,
      v.system_prompt, v.manifest
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
  const nativeSkills = DshNativeSkillSnapshotSchema.array().parse(
    row.native_skills,
  );
  const executionSnapshot = EmployeeExecutionSnapshotSchema.safeParse(
    row.execution_snapshot,
  );
  const manifest = EmployeeManifestSchema.parse(
    executionSnapshot.success
      ? executionSnapshot.data.employee.definition
      : row.manifest,
  );
  const artifacts: {
    skillVersionId: string;
    declaredCapabilities: SkillCapability[];
    grantedCapabilities: SkillCapability[];
    storageObject: ReturnType<typeof StorageObjectSchema.parse>;
  }[] = [];
  return {
    providerSnapshot: HarnessExecutionSnapshotSchema.parse(
      row.provider_snapshot,
    ),
    promptSnapshot,
    nativeSkills,
    executionSnapshot: executionSnapshot.success
      ? executionSnapshot.data
      : null,
    skillArtifacts: artifacts,
    grantedCapabilities: executionSnapshot.success
      ? executionSnapshot.data.capabilitySnapshot.grantedCapabilities
      : resolveEmployeeCapabilities(
          manifest.capabilities,
          skillBindings.map((binding) => ({
            installationId: binding.installationId,
            skillVersionId: binding.skillVersionId,
            declaredCapabilities:
              artifacts.find(
                (artifact) =>
                  artifact.skillVersionId === binding.skillVersionId,
              )?.declaredCapabilities ?? [],
            grantedCapabilities: binding.grantedCapabilities,
          })),
          manifest.schemaVersion === 2
            ? manifest.securityPolicy.deniedCapabilities
            : [],
        ),
  };
}
