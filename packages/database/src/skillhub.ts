import {
  CodexProviderStatusSchema,
  CodexExecutionSnapshotSchema,
  ImportSkillInputSchema,
  InstallSkillInputSchema,
  SkillArtifactSchema,
  SkillInstallationSchema,
  SkillVersionSchema,
  StorageObjectSchema,
  UpdateSkillInstallationInputSchema,
  UuidSchema,
  type CodexProviderStatus,
  type ImportSkillInput,
  type RequestContext,
  type SkillCapability,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';
import { enqueueRun } from './queue.ts';
import { resolveWorkspaceId } from './workspace.ts';

interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  publisher: string;
  created_at: Date;
}

interface VersionRow {
  id: string;
  catalog_skill_id: string;
  version: string;
  status: 'draft' | 'published' | 'deprecated' | 'revoked';
  capabilities: SkillCapability[];
  compatibility: { api: 'v1' };
  artifact_object_id: string;
  source: ImportSkillInput['source'];
  published_at: Date | null;
  object_key: string;
  checksum: string;
  size_bytes: number | string;
  media_type: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  retention_until: Date | null;
  deleted_at: Date | null;
  immutable: boolean;
}

interface InstallationRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  catalog_skill_id: string;
  pinned_version_id: string;
  enabled: boolean;
  favorite: boolean;
  granted_capabilities: SkillCapability[];
  timeout_ms: number;
  budget_cents: number;
}

export class SkillHubError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'version_conflict'
      | 'capability_denied'
      | 'artifact_invalid',
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

function mapVersion(row: VersionRow) {
  return {
    version: SkillVersionSchema.parse({
      id: row.id,
      catalogSkillId: row.catalog_skill_id,
      version: row.version,
      status: row.status,
      capabilities: row.capabilities,
      compatibility: row.compatibility,
      publishedAt: row.published_at?.toISOString() ?? null,
    }),
    artifact: SkillArtifactSchema.parse({
      id: row.artifact_object_id,
      skillVersionId: row.id,
      checksum: row.checksum,
      objectKey: row.object_key,
      sizeBytes: Number(row.size_bytes),
      source: row.source,
    }),
  };
}

function mapInstallation(row: InstallationRow) {
  return SkillInstallationSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    catalogSkillId: row.catalog_skill_id,
    pinnedVersionId: row.pinned_version_id,
    enabled: row.enabled,
    favorite: row.favorite,
    grantedCapabilities: row.granted_capabilities,
    timeoutMs: row.timeout_ms,
    budgetCents: row.budget_cents,
  });
}

export async function publishSkillVersion(
  context: RequestContext,
  input: unknown,
  artifactObjectIdInput: string,
) {
  const skill = ImportSkillInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, skill.workspaceId);
  const actorId = requireAdmin(context, workspaceId);
  const artifactObjectId = UuidSchema.parse(artifactObjectIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const objects = await transaction<
      { id: string; checksum: string; immutable: boolean; state: string }[]
    >`
      select id, checksum, immutable, state from allrice_storage_objects
      where id = ${artifactObjectId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and owner_id = ${actorId}
      for update
    `;
    const object = objects[0];
    if (!object || object.state !== 'ready' || !object.immutable) {
      throw new SkillHubError('artifact_invalid');
    }
    const catalogs = await transaction<{ id: string }[]>`
      insert into allrice_catalog_skills (
        organization_id, workspace_id, slug, name, description, publisher,
        created_by
      ) values (
        ${context.organizationId}, ${workspaceId}, ${skill.slug}, ${skill.name},
        ${skill.description}, ${skill.publisher}, ${actorId}
      )
      on conflict (organization_id, slug) do update
      set name = excluded.name,
          description = excluded.description,
          publisher = excluded.publisher
      where allrice_catalog_skills.workspace_id = excluded.workspace_id
      returning id
    `;
    const catalog = catalogs[0];
    if (!catalog) throw new SkillHubError('version_conflict');
    let versions;
    try {
      versions = await transaction<VersionRow[]>`
        insert into allrice_skill_versions (
          organization_id, workspace_id, catalog_skill_id, version, status,
          capabilities, compatibility, artifact_object_id, source, published_at
        ) values (
          ${context.organizationId}, ${workspaceId}, ${catalog.id},
          ${skill.version}, 'published', ${transaction.json(skill.capabilities)},
          ${transaction.json({ api: 'v1' })}, ${artifactObjectId},
          ${transaction.json(skill.source)}, now()
        )
        returning *,
          (select object_key from allrice_storage_objects where id = artifact_object_id) as object_key,
          (select checksum from allrice_storage_objects where id = artifact_object_id) as checksum,
          (select size_bytes from allrice_storage_objects where id = artifact_object_id) as size_bytes,
          (select media_type from allrice_storage_objects where id = artifact_object_id) as media_type,
          ${actorId}::uuid as owner_id,
          null::timestamptz as retention_until,
          null::timestamptz as deleted_at,
          true as immutable
      `;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new SkillHubError('version_conflict');
      }
      throw error;
    }
    const version = versions[0];
    if (!version) throw new Error('skill version publication failed');
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'skill.publish', 'skill_version', ${version.id}, 'allowed',
        'admin_published_validated_immutable_artifact', ${context.requestId},
        ${transaction.json({
          slug: skill.slug,
          version: skill.version,
          checksum: object.checksum,
          source: skill.source,
        })}
      )
    `;
    return { catalogSkillId: catalog.id, ...mapVersion(version) };
  });
}

export async function listSkillHub(
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const actorId = userId(context);
  const sql = getDatabase();
  const catalogs = await sql<CatalogRow[]>`
    select * from allrice_catalog_skills
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
    order by name, id
  `;
  const versions = await sql<VersionRow[]>`
    select v.*, o.object_key, o.checksum, o.size_bytes, o.media_type,
      o.owner_id, o.retention_until, o.deleted_at, o.immutable
    from allrice_skill_versions v
    join allrice_storage_objects o on o.id = v.artifact_object_id
    where v.organization_id = ${context.organizationId}
      and v.workspace_id = ${workspaceId}
      and o.state = 'ready'
    order by v.published_at desc, v.id
  `;
  const installations = await sql<InstallationRow[]>`
    select * from allrice_skill_installations
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and owner_id = ${actorId}
    order by created_at
  `;
  return {
    catalog: catalogs.map((catalog) => ({
      id: catalog.id,
      slug: catalog.slug,
      name: catalog.name,
      description: catalog.description,
      publisher: catalog.publisher,
      createdAt: catalog.created_at.toISOString(),
      versions: versions
        .filter((version) => version.catalog_skill_id === catalog.id)
        .map(mapVersion),
    })),
    installations: installations.map(mapInstallation),
  };
}

export async function installSkill(context: RequestContext, input: unknown) {
  const installation = InstallSkillInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(
    context,
    installation.workspaceId,
  );
  const actorId = userId(context);
  const sql = getDatabase();
  const versions = await sql<
    { catalog_skill_id: string; capabilities: SkillCapability[] }[]
  >`
    select catalog_skill_id, capabilities from allrice_skill_versions
    where id = ${installation.skillVersionId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and status = 'published'
  `;
  const version = versions[0];
  if (!version) throw new SkillHubError('not_found');
  if (
    installation.grantedCapabilities.some(
      (capability) => !version.capabilities.includes(capability),
    )
  ) {
    throw new SkillHubError('capability_denied');
  }
  const rows = await sql<InstallationRow[]>`
    insert into allrice_skill_installations (
      organization_id, workspace_id, owner_id, catalog_skill_id,
      pinned_version_id, granted_capabilities, timeout_ms, budget_cents
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actorId},
      ${version.catalog_skill_id}, ${installation.skillVersionId},
      ${sql.json(installation.grantedCapabilities)}, ${installation.timeoutMs},
      ${installation.budgetCents}
    )
    on conflict (organization_id, workspace_id, owner_id, catalog_skill_id)
    do update set pinned_version_id = excluded.pinned_version_id,
      granted_capabilities = excluded.granted_capabilities,
      timeout_ms = excluded.timeout_ms, budget_cents = excluded.budget_cents,
      enabled = true, updated_at = now()
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error('skill installation failed');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actorId},
      'skill.install', 'skill_installation', ${row.id}, 'allowed',
      'owner_pinned_published_version', ${context.requestId},
      ${sql.json({
        skillVersionId: installation.skillVersionId,
        grantedCapabilities: installation.grantedCapabilities,
      })}
    )
  `;
  return mapInstallation(row);
}

export async function updateSkillInstallation(
  context: RequestContext,
  installationIdInput: string,
  input: unknown,
) {
  const update = UpdateSkillInstallationInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, update.workspaceId);
  const actorId = userId(context);
  const installationId = UuidSchema.parse(installationIdInput);
  const sql = getDatabase();
  const rows = await sql<InstallationRow[]>`
    update allrice_skill_installations
    set enabled = coalesce(${update.enabled ?? null}, enabled),
        favorite = coalesce(${update.favorite ?? null}, favorite),
        updated_at = now()
    where id = ${installationId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and owner_id = ${actorId}
    returning *
  `;
  const row = rows[0];
  if (!row) throw new SkillHubError('not_found');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actorId},
      'skill.installation.update', 'skill_installation', ${row.id},
      'allowed', 'owner_updated_personal_installation', ${context.requestId},
      ${sql.json({ enabled: update.enabled, favorite: update.favorite })}
    )
  `;
  return mapInstallation(row);
}

export async function enqueueSkillRun(
  context: RequestContext,
  input: {
    workspaceId: string;
    installationId: string;
    prompt: string;
    idempotencyKey: string;
  },
) {
  const workspaceId = await resolveWorkspaceId(context, input.workspaceId);
  const actorId = userId(context);
  const sql = getDatabase();
  const installationId = UuidSchema.parse(input.installationId);
  const rows = await sql<InstallationRow[]>`
    select * from allrice_skill_installations
    where id = ${installationId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and owner_id = ${actorId}
      and enabled
  `;
  const installation = rows[0];
  if (!installation) {
    await sql`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'skill.execute', 'skill_installation', ${installationId}, 'denied',
        'owner_enabled_installation_required', ${context.requestId}
      )
    `;
    throw new SkillHubError('not_found');
  }
  if (!installation.granted_capabilities.includes('model:invoke')) {
    await sql`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actorId},
        'skill.execute', 'skill_installation', ${installation.id}, 'denied',
        'model_invoke_capability_not_granted', ${context.requestId}
      )
    `;
    throw new SkillHubError('capability_denied');
  }
  const providerSnapshot = CodexExecutionSnapshotSchema.parse({
    provider: 'codex',
    authMode: 'chatgpt_subscription',
    model: process.env.ALLRICE_CODEX_MODEL ?? 'gpt-5.6-luna',
    reasoningEffort: process.env.ALLRICE_CODEX_REASONING_EFFORT ?? 'high',
    sandbox: 'workspace-write',
  });
  return enqueueRun(
    context,
    {
      workspaceId,
      idempotencyKey: input.idempotencyKey,
      type: 'allrice.skill.run',
      input: {
        installationId: installation.id,
        skillVersionId: installation.pinned_version_id,
        prompt: input.prompt,
        providerSnapshot,
      },
      maxAttempts: 1,
      timeoutMs: installation.timeout_ms,
    },
    {
      skillBinding: {
        installationId: installation.id,
        skillVersionId: installation.pinned_version_id,
        providerSnapshot,
      },
    },
  );
}

export async function resolveSkillExecution(input: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  runId: string;
  installationId: string;
  skillVersionId: string;
}) {
  const sql = getDatabase();
  const rows = await sql<
    (VersionRow & {
      installation_id: string;
      granted_capabilities: SkillCapability[];
      provider_snapshot: unknown;
    })[]
  >`
    select v.*, i.id as installation_id, sr.provider_snapshot,
      i.granted_capabilities as granted_capabilities,
      o.object_key, o.checksum,
      o.size_bytes, o.media_type, o.owner_id, o.retention_until,
      o.deleted_at, o.immutable
    from allrice_skill_runs sr
    join allrice_skill_installations i on i.id = sr.installation_id
    join allrice_skill_versions v on v.id = sr.skill_version_id
    join allrice_storage_objects o on o.id = v.artifact_object_id
    where sr.run_id = ${UuidSchema.parse(input.runId)}
      and sr.organization_id = ${UuidSchema.parse(input.organizationId)}
      and sr.workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and sr.installation_id = ${UuidSchema.parse(input.installationId)}
      and sr.skill_version_id = ${UuidSchema.parse(input.skillVersionId)}
      and i.owner_id = ${UuidSchema.parse(input.ownerId)}
      and i.enabled and i.granted_capabilities ? 'model:invoke'
      and v.status = 'published' and o.state = 'ready'
  `;
  const row = rows[0];
  if (!row) throw new SkillHubError('not_found');
  if (!row.immutable) throw new SkillHubError('artifact_invalid');
  return {
    ...mapVersion(row),
    grantedCapabilities: row.granted_capabilities,
    providerSnapshot: CodexExecutionSnapshotSchema.parse(row.provider_snapshot),
    storageObject: StorageObjectSchema.parse({
      id: row.artifact_object_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      checksum: row.checksum,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      retentionUntil: row.retention_until?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      immutable: row.immutable,
    }),
  };
}

export async function recordCodexProviderStatus(
  statusInput: CodexProviderStatus,
) {
  const status = CodexProviderStatusSchema.parse(statusInput);
  const sql = getDatabase();
  await sql`
    insert into allrice_provider_status (
      provider, auth_mode, status, cli_version, detail_code, checked_at,
      updated_at
    ) values (
      'codex', 'chatgpt_subscription', ${status.status},
      ${status.cliVersion}, ${status.detailCode},
      ${status.checkedAt ? new Date(status.checkedAt) : new Date()}, now()
    ) on conflict (provider) do update set
      status = excluded.status, cli_version = excluded.cli_version,
      detail_code = excluded.detail_code, checked_at = excluded.checked_at,
      updated_at = now()
  `;
}

export async function getCodexProviderStatus() {
  const sql = getDatabase();
  const rows = await sql<
    {
      status: CodexProviderStatus['status'];
      cli_version: string | null;
      detail_code: string | null;
      checked_at: Date;
    }[]
  >`
    select status, cli_version, detail_code, checked_at
    from allrice_provider_status where provider = 'codex'
  `;
  const row = rows[0];
  return CodexProviderStatusSchema.parse({
    provider: 'codex',
    authMode: 'chatgpt_subscription',
    status: row?.status ?? 'unknown',
    cliVersion: row?.cli_version ?? null,
    detailCode: row?.detail_code ?? 'worker_not_checked',
    checkedAt: row?.checked_at.toISOString() ?? null,
  });
}
