import { randomUUID } from 'node:crypto';

import {
  DeliverableVersionSchema,
  DeliveryFormatSchema,
  ObjectKeySchema,
  UuidSchema,
  authorizeExecution,
  makeObjectKey,
  type DeliveryFormat,
  type ExecutionContext,
  type RequestContext,
  type StorageObject,
  type Visibility,
} from '@allrice/contracts';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';

interface ResourceRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  visibility: Visibility;
}

const defaultWorkspaceQuotaBytes = 1024 * 1024 * 1024;

function authorizeRead(
  context: ExecutionContext,
  type: 'storage_object' | 'memory' | 'chat_session',
  row: ResourceRow,
) {
  const decision = authorizeExecution(
    {
      type,
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      archivedAt: null,
    },
    'resource:read',
    context,
  );
  if (!decision.allowed) throw new DataAccessError('authorization_denied');
}

export async function recordToolBrokerAudit(input: {
  context: ExecutionContext;
  toolName: string;
  resourceId?: string;
  decision?: 'allowed' | 'denied';
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.context.organizationId}, ${input.context.workspaceId},
      ${input.context.policySnapshot.subjectId}, 'tool.execute', 'tool_broker',
      ${input.resourceId ?? null}, ${input.decision ?? 'allowed'},
      ${input.reason ?? 'frozen_policy_authorized'}, null,
      ${sql.json({
        executionId: input.context.executionId,
        runId: input.context.runId,
        toolName: input.toolName,
        ...input.metadata,
      })}
    )
  `;
}

export async function listToolBrokerFiles(
  context: ExecutionContext,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const rows = await sql<
    (ResourceRow & {
      file_name: string;
      media_type: string;
      size_bytes: number | string;
      category: 'uploads' | 'exports';
      deliverable_version: number | null;
      created_at: Date;
    })[]
  >`
    select o.id, o.organization_id, o.workspace_id, o.owner_id, o.visibility,
      coalesce(deliverable.file_name, max(f.file_name), '未命名文件') as file_name,
      o.media_type, o.size_bytes, o.category,
      deliverable.version as deliverable_version, o.created_at
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    left join lateral (
      select version.file_name, version.version
      from allrice_deliverable_versions version
      where version.object_id = o.id
      order by version.version desc
      limit 1
    ) deliverable on true
    where o.organization_id = ${context.organizationId}
      and o.workspace_id = ${context.workspaceId}
      and o.category in ('uploads', 'exports') and o.state = 'ready'
      and (o.owner_id = ${context.policySnapshot.subjectId}
        or o.visibility <> 'private')
    group by o.id, deliverable.file_name, deliverable.version
    order by o.created_at desc
    limit ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'storage_object', row);
    return {
      id: row.id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      visibility: row.visibility,
      category: row.category,
      deliverableVersion: row.deliverable_version,
      createdAt: row.created_at.toISOString(),
    };
  });
}

export async function getToolBrokerFile(
  context: ExecutionContext,
  objectIdInput: string,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const rows = await sql<
    (ResourceRow & {
      file_name: string;
      object_key: string;
      checksum: string;
      media_type: string;
      size_bytes: number | string;
      retention_until: Date | null;
      deleted_at: Date | null;
      immutable: boolean;
    })[]
  >`
    select o.id, o.organization_id, o.workspace_id, o.owner_id, o.visibility,
      coalesce(max(f.file_name), '未命名文件') as file_name,
      o.object_key, o.checksum, o.media_type, o.size_bytes,
      o.retention_until, o.deleted_at, o.immutable
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    where o.id = ${UuidSchema.parse(objectIdInput)}
      and o.organization_id = ${context.organizationId}
      and o.workspace_id = ${context.workspaceId} and o.state = 'ready'
    group by o.id
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  authorizeRead(context, 'storage_object', row);
  const object: StorageObject = {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: ObjectKeySchema.parse(row.object_key),
    checksum: row.checksum as StorageObject['checksum'],
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    immutable: row.immutable,
  };
  return { object, fileName: row.file_name, visibility: row.visibility };
}

export function createToolBrokerExportObject(input: {
  context: ExecutionContext;
  mediaType: string;
  sizeBytes: number;
  checksum: StorageObject['checksum'];
}) {
  if (!input.context.workspaceId) {
    throw new DataAccessError('authorization_denied');
  }
  const objectId = randomUUID();
  const ownerId = input.context.policySnapshot.subjectId;
  return {
    id: objectId,
    organizationId: input.context.organizationId,
    workspaceId: input.context.workspaceId,
    ownerId,
    key: makeObjectKey({
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId,
      ownerId,
      category: 'exports',
      objectId,
    }),
    checksum: input.checksum,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
    retentionUntil: null,
    deletedAt: null,
    immutable: false,
  } satisfies StorageObject;
}

export async function registerToolBrokerExport(input: {
  context: ExecutionContext;
  sessionId?: string;
  platformTestRunId?: string;
  parentObjectId?: string;
  fileName: string;
  format: DeliveryFormat;
  changeSummary?: string;
  object: StorageObject;
}) {
  if (!input.context.workspaceId) {
    throw new DataAccessError('authorization_denied');
  }
  const workspaceId = input.context.workspaceId;
  const ownerId = input.context.policySnapshot.subjectId;
  if (
    input.object.organizationId !== input.context.organizationId ||
    input.object.workspaceId !== workspaceId ||
    input.object.ownerId !== ownerId
  ) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const version = await sql.begin(async (transaction) => {
    if (input.sessionId) {
      const sessions = await transaction<{ id: string }[]>`
        select id from allrice_chat_sessions
        where id = ${UuidSchema.parse(input.sessionId)}
          and organization_id = ${input.context.organizationId}
          and workspace_id = ${workspaceId}
          and owner_id = ${ownerId}
          and archived_at is null
        for update
      `;
      if (!sessions[0]) throw new DataAccessError('authorization_denied');
    } else if (input.platformTestRunId) {
      const tests = await transaction<{ id: string }[]>`
        select test.id
        from allrice_platform_employee_test_runs test
        join allrice_platform_employee_revisions revision
          on revision.id = test.revision_id
        where test.id = ${UuidSchema.parse(input.platformTestRunId)}
          and test.status = 'running'
          and revision.status = 'testing'
          and test.input ->> 'workspaceId' = ${workspaceId}
        for update of test
      `;
      if (!tests[0]) throw new DataAccessError('authorization_denied');
    } else {
      throw new DataAccessError('authorization_denied');
    }
    const quotas = await transaction<
      { limit_bytes: number | string; used_bytes: number | string }[]
    >`
      select coalesce(q.limit_bytes, ${defaultWorkspaceQuotaBytes}) as limit_bytes,
        coalesce(sum(o.size_bytes) filter (where o.state <> 'deleted'), 0) as used_bytes
      from allrice_workspaces w
      left join allrice_storage_quotas q
        on q.organization_id = w.organization_id and q.workspace_id = w.id
      left join allrice_storage_objects o
        on o.organization_id = w.organization_id and o.workspace_id = w.id
      where w.organization_id = ${input.context.organizationId}
        and w.id = ${workspaceId}
      group by q.limit_bytes
    `;
    const quota = quotas[0];
    if (
      !quota ||
      Number(quota.used_bytes) + input.object.sizeBytes >
        Number(quota.limit_bytes)
    ) {
      throw new DataAccessError('quota_exceeded');
    }
    await transaction`
      insert into allrice_storage_objects (
        id, organization_id, workspace_id, owner_id, object_key, category,
        media_type, size_bytes, checksum, visibility, state, immutable
      ) values (
        ${input.object.id}, ${input.object.organizationId},
        ${input.object.workspaceId}, ${input.object.ownerId}, ${input.object.key},
        'exports', ${input.object.mediaType}, ${input.object.sizeBytes},
        ${input.object.checksum}, 'private', 'ready', ${input.object.immutable}
      )
    `;
    let seriesId: string = randomUUID();
    let versionNumber = 1;
    let parentVersionId: string | null = null;
    let parentObjectId: string | null = null;
    if (input.parentObjectId) {
      const parents = await transaction<
        { id: string; object_id: string; series_id: string }[]
      >`
        select version.id, version.object_id, version.series_id
        from allrice_deliverable_versions version
        join allrice_storage_objects object on object.id = version.object_id
        where version.object_id = ${UuidSchema.parse(input.parentObjectId)}
          and version.organization_id = ${input.context.organizationId}
          and version.workspace_id = ${workspaceId}
          and version.owner_id = ${ownerId}
          and object.state = 'ready'
        for update of version
      `;
      const parent = parents[0];
      if (!parent) throw new DataAccessError('not_found');
      seriesId = parent.series_id;
      parentVersionId = parent.id;
      parentObjectId = parent.object_id;
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${seriesId}, 0))
      `;
      const latest = await transaction<{ version: number }[]>`
        select max(version)::integer as version
        from allrice_deliverable_versions
        where series_id = ${seriesId}
      `;
      versionNumber = (latest[0]?.version ?? 0) + 1;
    }
    const versions = await transaction<
      {
        id: string;
        series_id: string;
        version: number;
        created_at: Date;
      }[]
    >`
      insert into allrice_deliverable_versions (
        organization_id, workspace_id, owner_id, object_id, series_id,
        version, parent_version_id, session_id, platform_test_run_id,
        file_name, format, change_summary
      ) values (
        ${input.context.organizationId}, ${workspaceId}, ${ownerId},
        ${input.object.id}, ${seriesId}, ${versionNumber}, ${parentVersionId},
        ${input.sessionId ?? null}, ${input.platformTestRunId ?? null},
        ${input.fileName}, ${DeliveryFormatSchema.parse(input.format)},
        ${input.changeSummary?.trim() || null}
      )
      returning id, series_id, version, created_at
    `;
    if (input.sessionId) {
      await transaction`
        insert into allrice_file_references (
          organization_id, workspace_id, object_id, session_id, owner_id, file_name
        ) values (
          ${input.context.organizationId}, ${workspaceId}, ${input.object.id},
          ${input.sessionId}, ${ownerId}, ${input.fileName}
        )
      `;
    }
    return {
      id: versions[0]!.id,
      seriesId: versions[0]!.series_id,
      version: versions[0]!.version,
      parentVersionId,
      parentObjectId,
      createdAt: versions[0]!.created_at.toISOString(),
    };
  });
  return {
    objectId: input.object.id,
    fileName: input.fileName,
    ...version,
  };
}

interface DeliverableVersionRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_id: string;
  series_id: string;
  version: number;
  parent_version_id: string | null;
  parent_object_id: string | null;
  session_id: string | null;
  platform_test_run_id: string | null;
  file_name: string;
  format: string;
  change_summary: string | null;
  created_at: Date;
}

function mapDeliverableVersion(row: DeliverableVersionRow) {
  return DeliverableVersionSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    objectId: row.object_id,
    seriesId: row.series_id,
    version: row.version,
    parentVersionId: row.parent_version_id,
    parentObjectId: row.parent_object_id,
    sessionId: row.session_id,
    platformTestRunId: row.platform_test_run_id,
    fileName: row.file_name,
    format: row.format,
    changeSummary: row.change_summary,
    createdAt: row.created_at.toISOString(),
  });
}

export async function listDeliverableVersions(input: {
  context: RequestContext;
  workspaceId: string;
  objectId: string;
}) {
  if (input.context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  const workspaceId = await resolveWorkspaceId(
    input.context,
    input.workspaceId,
  );
  const objectId = UuidSchema.parse(input.objectId);
  const sql = getDatabase();
  const anchors = await sql<
    { series_id: string; owner_id: string; visibility: Visibility }[]
  >`
    select version.series_id, version.owner_id, object.visibility
    from allrice_deliverable_versions version
    join allrice_storage_objects object on object.id = version.object_id
    where version.object_id = ${objectId}
      and version.organization_id = ${input.context.organizationId}
      and version.workspace_id = ${workspaceId}
      and object.state = 'ready'
  `;
  const anchor = anchors[0];
  if (!anchor) throw new DataAccessError('not_found');
  if (
    anchor.owner_id !== input.context.actor.id &&
    anchor.visibility === 'private'
  ) {
    throw new DataAccessError('authorization_denied');
  }
  const rows = await sql<DeliverableVersionRow[]>`
    select version.*,
      parent.object_id as parent_object_id
    from allrice_deliverable_versions version
    join allrice_storage_objects object on object.id = version.object_id
    left join allrice_deliverable_versions parent
      on parent.id = version.parent_version_id
    where version.organization_id = ${input.context.organizationId}
      and version.workspace_id = ${workspaceId}
      and version.series_id = ${anchor.series_id}
      and object.state = 'ready'
      and (
        version.owner_id = ${input.context.actor.id}
        or object.visibility <> 'private'
      )
    order by version.version desc
  `;
  return rows.map(mapDeliverableVersion);
}

export async function searchToolBrokerMemories(
  context: ExecutionContext,
  query: string,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const pattern = `%${query.trim().slice(0, 500)}%`;
  const rows = await sql<
    (ResourceRow & {
      content: string;
      updated_at: Date;
      trust_level: string;
      confidence: number | string;
      source_label: string;
    })[]
  >`
    select id, organization_id, workspace_id, owner_id, visibility,
      content, updated_at, trust_level, confidence, source_label
    from allrice_memories
    where organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId} and archived_at is null
      and (owner_id = ${context.policySnapshot.subjectId}
        or visibility <> 'private')
      and (expires_at is null or expires_at > now())
      and content ilike ${pattern}
    order by updated_at desc
    limit ${Math.min(Math.max(limit, 1), 20)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'memory', row);
    return {
      id: row.id,
      content: row.content.slice(0, 4_000),
      provenance: {
        trust: row.trust_level,
        confidence: Number(row.confidence),
        sourceLabel: row.source_label,
      },
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function searchToolBrokerSessions(
  context: ExecutionContext,
  query: string,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const pattern = `%${query.trim().slice(0, 500)}%`;
  const rows = await sql<(ResourceRow & { title: string; updated_at: Date })[]>`
    select id, organization_id, workspace_id, owner_id, visibility,
      title, updated_at
    from allrice_chat_sessions
    where organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId} and archived_at is null
      and (owner_id = ${context.policySnapshot.subjectId}
        or visibility <> 'private')
      and title ilike ${pattern}
    order by updated_at desc
    limit ${Math.min(Math.max(limit, 1), 20)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'chat_session', row);
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at.toISOString(),
    };
  });
}
