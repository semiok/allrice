import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CompanyAssetMutationSchema,
  CompanyAssetSchema,
  CompanyAssetRevisionSchema,
  StorageObjectSchema,
  UuidSchema,
  makeObjectKey,
  runtimeContractEqual,
  type CompanyAsset,
  type CompanyAssetContent,
  type CompanyAssetRevision,
  type RequestContext,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { DataAccessError } from './data.ts';
import { businessDeliverablePredicate } from './organization-dashboard.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  getWorkbenchArtifact,
  inspectCompanyDeliverable,
  readArtifactBytes,
} from './artifact-review.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';

type Db = ReturnType<typeof getDatabase>;
type Sql = Db | postgres.TransactionSql;
type Row = {
  id: string;
  organization_id: string;
  owner_id: string;
  owner_name: string;
  kind: 'rule' | 'template';
  state: CompanyAsset['state'];
  revision: number;
  latest_revision_id: string | null;
  published_revision_id: string | null;
  content: CompanyAssetContent;
  revision_id: string;
  number: number;
  digest: string;
  file_metadata: CompanyAssetRevision['file'];
  created_at: Date;
  usage: CompanyAsset['usage'];
};
export const companyRuleBudget = { maximumBytes: 16_000, maximumRules: 32 };
export class CompanyAssetError extends Error {
  constructor(
    readonly code:
      | 'version_conflict'
      | 'rule_budget_exceeded'
      | 'source_changed'
      | 'asset_unavailable'
      | 'source_required'
      | 'kind_conflict',
  ) {
    super(code);
  }
}

/** A company publication grants access to its snapshot, never its author's
 * Session or original files. The current reader remains the current principal. */
export async function requireCompanyAssetReader(
  context: RequestContext,
  org: string,
  sql: Sql,
  administration = false,
) {
  UuidSchema.parse(org);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (administration) {
    await requireTenantAdministrationAuthority(context, sql);
    await requireTenantAdministrationTarget(sql, org, null);
    return;
  }
  if (context.organizationId !== org) throw new DataAccessError('not_found');
  const [allowed] =
    await sql`select u.id from allrice_users u join allrice_organizations o on o.id=${org} and o.archived_at is null
    where u.id=${context.actor.id} and u.status='active'
      and exists(select 1 from allrice_memberships m where m.organization_id=o.id and m.user_id=u.id and m.active and (m.workspace_id is null or m.workspace_id=${context.workspaceId}))
      and (${context.workspaceId}::uuid is null or exists(select 1 from allrice_workspaces w where w.id=${context.workspaceId} and w.organization_id=o.id and w.archived_at is null))
      and (${context.sessionId ?? null}::uuid is null or exists(select 1 from allrice_sessions s where s.id=${context.sessionId ?? null} and s.user_id=u.id and s.revoked_at is null and s.expires_at>clock_timestamp()))`;
  if (!allowed) throw new DataAccessError('authorization_denied');
}
function revision(row: Row): CompanyAssetRevision {
  return CompanyAssetRevisionSchema.parse({
    id: row.revision_id,
    number: row.number,
    digest: row.digest,
    content: row.content,
    file: row.file_metadata,
    createdAt: row.created_at.toISOString(),
  });
}
function asset(
  row: Row,
  context: RequestContext,
  administration: boolean,
): CompanyAsset {
  return CompanyAssetSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    kind: row.kind,
    state: row.state,
    revision: row.revision,
    publishedRevisionId: row.published_revision_id,
    latest: revision(row),
    usage: row.usage,
    canEdit:
      administration ||
      (row.kind === 'template' && row.owner_id === context.actor.id),
  });
}
async function rows(
  sql: Sql,
  org: string,
  viewer: string,
  administration: boolean,
  id: string | null = null,
  after: string | null = null,
) {
  return sql<
    Row[]
  >`select a.*,u.display_name as owner_name,r.id as revision_id,r.number,r.content,r.digest,r.file_metadata,r.created_at,
      (select jsonb_build_object('selectedRuns',count(*)filter(where f.selected_at is not null),
        'loadedRuns',count(*)filter(where f.loaded_at is not null),
        'readRuns',count(*)filter(where f.read_at is not null),
        'derivedRuns',count(*)filter(where exists(select 1 from allrice_company_asset_derivations d where d.run_id=f.run_id and d.asset_id=f.asset_id)))
       from allrice_company_run_assets f where f.organization_id=a.organization_id and f.asset_id=a.id) as usage
    from allrice_company_assets a join allrice_users u on u.id=a.owner_id join allrice_company_asset_revisions r on r.id=case when ${administration} or a.owner_id=${viewer} then a.latest_revision_id else a.published_revision_id end and r.asset_id=a.id
    where a.organization_id=${org} and (${id}::uuid is null or a.id=${id}) and (${after}::uuid is null or a.id>${after})
      and (${administration} or (a.owner_id=${viewer} and a.kind='template') or a.state='published') order by a.id limit 51`;
}
export async function listCompanyAssets(
  context: RequestContext,
  org: string,
  options: { administration?: boolean; after?: string } = {},
  db: Db = getDatabase(),
) {
  if (options.after) UuidSchema.parse(options.after);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    await requireCompanyAssetReader(context, org, tx, options.administration);
    const result = await rows(
      tx,
      org,
      context.actor.id,
      !!options.administration,
      null,
      options.after ?? null,
    );
    const [budget] = await tx<
      { bytes: number }[]
    >`select coalesce(sum(octet_length(r.content->>'body')),0)::int as bytes from allrice_company_assets a join allrice_company_asset_revisions r on r.id=a.published_revision_id where a.organization_id=${org} and a.kind='rule' and a.state='published'`;
    return {
      assets: result
        .slice(0, 50)
        .map((row) => asset(row, context, !!options.administration)),
      nextCursor: result.length > 50 ? result[49]!.id : null,
      ruleBudget: { ...companyRuleBudget, publishedBytes: budget?.bytes ?? 0 },
    };
  });
}
export async function getCompanyAsset(
  context: RequestContext,
  org: string,
  id: string,
  administration = false,
  db: Db = getDatabase(),
) {
  UuidSchema.parse(id);
  await requireCompanyAssetReader(context, org, db, administration);
  const [row] = await rows(db, org, context.actor.id, administration, id);
  if (!row) throw new DataAccessError('not_found');
  return asset(row, context, administration);
}
export async function listCompanyAssetRevisions(
  context: RequestContext,
  org: string,
  id: string,
  administration = false,
  db: Db = getDatabase(),
) {
  const current = await getCompanyAsset(context, org, id, administration, db);
  const revisions = await db<
    Row[]
  >`select r.*,r.id as revision_id from allrice_company_asset_revisions r where r.asset_id=${current.id} and r.organization_id=${org}
    and (${current.canEdit} or exists(select 1 from allrice_company_asset_publications p where p.asset_id=r.asset_id and p.revision_id=r.id)) order by r.number desc limit 50`;
  await requireCompanyAssetReader(context, org, db, administration);
  const publications = await db<
    { revision_id: string }[]
  >`select revision_id from allrice_company_asset_publications where asset_id=${current.id}`;
  return {
    asset: current,
    revisions: revisions.map(revision),
    publishedRevisionIds: publications.map((p) => p.revision_id),
  };
}
export async function getCompanyAssetFile(
  context: RequestContext,
  org: string,
  id: string,
  revisionId: string,
  administration = false,
  db: Db = getDatabase(),
) {
  UuidSchema.parse(id);
  UuidSchema.parse(revisionId);
  await requireCompanyAssetReader(context, org, db, administration);
  const [row] = await db<
    {
      content: CompanyAssetContent;
      digest: string;
      file_metadata: NonNullable<CompanyAssetRevision['file']>;
      object_key: string;
      workspace_id: string;
      owner_id: string;
      media_type: string;
      size_bytes: string | number;
      checksum: string;
    }[]
  >`select r.content,r.digest,r.file_metadata,o.object_key,o.workspace_id,o.owner_id,o.media_type,o.size_bytes,o.checksum
    from allrice_company_assets a join allrice_company_asset_revisions r on r.asset_id=a.id and r.id=${revisionId} join allrice_company_asset_publications p on p.asset_id=a.id and p.revision_id=r.id
    join allrice_storage_objects o on o.id=r.snapshot_object_id and o.organization_id=a.organization_id and o.state='ready' and o.deleted_at is null and o.retention_until is null
    where a.id=${id} and a.organization_id=${org} and a.state='published'`;
  if (!row) throw new CompanyAssetError('asset_unavailable');
  const file = row.file_metadata,
    object = StorageObjectSchema.parse({
      id: file.objectId,
      organizationId: org,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      checksum: row.checksum,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      immutable: true,
      retentionUntil: null,
      deletedAt: null,
    });
  if (
    object.checksum !== file.checksum ||
    object.sizeBytes !== file.sizeBytes ||
    object.mediaType !== file.mediaType
  )
    throw new CompanyAssetError('source_changed');
  return { object, file, digest: row.digest, content: row.content };
}
export async function listCompanyRuleSources(
  context: RequestContext,
  org: string,
  db: Db = getDatabase(),
) {
  await requireCompanyAssetReader(context, org, db, true);
  const sources = await db<
    { id: string; revisionId: string; revision: number; content: string }[]
  >`select m.id,r.id as "revisionId",r.revision,left(r.content,4000) as content from allrice_memories m join allrice_memory_revisions r on r.memory_id=m.id and r.organization_id=m.organization_id and r.workspace_id=m.workspace_id and r.revision=m.revision where m.organization_id=${org} and m.archived_at is null order by m.created_at desc,m.id desc limit 50`;
  const employees = await db<
    { id: string; name: string }[]
  >`select distinct p.id,p.name from allrice_platform_employees p join allrice_platform_employee_tenant_assignments a on a.employee_id=p.id and a.organization_id=${org} and a.active where p.status='published' order by p.name,p.id`;
  return { sources, employees };
}
async function source(
  context: RequestContext,
  org: string,
  id: string,
  administration: boolean,
  db: Db,
) {
  const [v] = await db<
    { session_id: string }[]
  >`select dv.session_id from allrice_deliverable_versions dv join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
    left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
    where dv.id=${id} and dv.organization_id=${org} and dv.platform_test_run_id is null and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
      and ${businessDeliverablePredicate(db)}
      and exists(select 1 from allrice_employee_runs er where er.organization_id=dv.organization_id and er.workspace_id=dv.workspace_id and er.owner_id=dv.owner_id and er.session_id=dv.session_id and (a.run_id is null or a.run_id=er.run_id) and not exists(select 1 from allrice_assistant_instances ai where ai.run_id=er.run_id and ai.run_id<>ai.root_run_id))
      and (${administration} or(dv.owner_id=${context.actor.id} and dv.workspace_id=${context.workspaceId}))`;
  if (!v) throw new CompanyAssetError('source_changed');
  return administration
    ? inspectCompanyDeliverable(context, org, id, db)
    : getWorkbenchArtifact(context, v.session_id, id, db);
}
async function audit(
  tx: postgres.TransactionSql,
  context: RequestContext,
  org: string,
  id: string,
  operation: string,
  revisionId: string | null,
) {
  await tx`insert into allrice_audit_events(organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata) values(${org},${context.actor.id},${'company.asset.' + operation},'company_asset',${id},'recorded','explicit_company_publication',${context.requestId},${tx.json({ revisionId })})`;
}

/** Snapshot bytes are copied only from the selected authorized version. A new
 * company revision never points at private originals or modifies old evidence. */
export async function mutateCompanyAsset(
  context: RequestContext,
  org: string,
  raw: unknown,
  storage: StoragePort,
  administration = false,
  db: Db = getDatabase(),
) {
  const input = CompanyAssetMutationSchema.parse(raw);
  await requireCompanyAssetReader(context, org, db, administration);
  const existing = await db<
    { owner_id: string; kind: string; latest_revision_id: string }[]
  >`select owner_id,kind,latest_revision_id from allrice_company_assets where id=${input.assetId} and organization_id=${org}`;
  if (
    existing[0] &&
    !administration &&
    (existing[0].owner_id !== context.actor.id ||
      existing[0].kind !== 'template')
  )
    throw new DataAccessError('authorization_denied');
  if (
    !administration &&
    input.operation === 'save' &&
    input.content.kind !== 'template'
  )
    throw new DataAccessError('authorization_denied');
  const previous = existing[0]
    ? await db<
        {
          source_version_id: string | null;
          snapshot_object_id: string | null;
          file_metadata: CompanyAssetRevision['file'];
        }[]
      >`select source_version_id,snapshot_object_id,file_metadata from allrice_company_asset_revisions where id=${existing[0].latest_revision_id}`
    : [];
  const sourceId =
    input.operation === 'save' ? input.content.sourceVersionId : undefined;
  const reused =
    sourceId &&
    previous[0]?.source_version_id === sourceId &&
    previous[0].snapshot_object_id
      ? previous[0]
      : null;
  const selected =
    sourceId && !reused
      ? await source(context, org, sourceId, administration, db)
      : null;
  const bytes = selected
    ? await readArtifactBytes(storage, selected.object, 64_000_000)
    : null;
  const [organization] = await db<
    { default_workspace_id: string | null }[]
  >`select coalesce(default_workspace_id,(select id from allrice_workspaces where organization_id=${org} and archived_at is null order by id limit 1)) as default_workspace_id from allrice_organizations where id=${org}`;
  const quotaWorkspace =
    selected?.object.workspaceId ??
    (context.organizationId === org ? context.workspaceId : null) ??
    organization?.default_workspace_id;
  if (!quotaWorkspace) throw new DataAccessError('not_found');
  let copied: StorageObject | undefined;
  try {
    await db.begin(async (tx) => {
      await lockWorkspaceStorageQuota(tx, org, quotaWorkspace);
      await requireCompanyAssetReader(context, org, tx, administration);
      const [current] = await tx<
        {
          owner_id: string;
          kind: string;
          revision: number;
          latest_revision_id: string | null;
          published_revision_id: string | null;
          state: string;
        }[]
      >`select * from allrice_company_assets where id=${input.assetId} and organization_id=${org} for update`;
      if (
        current &&
        !administration &&
        (current.owner_id !== context.actor.id || current.kind !== 'template')
      )
        throw new DataAccessError('authorization_denied');
      if (!current && input.expectedRevision !== 0)
        throw new DataAccessError('not_found');
      if (current && current.revision !== input.expectedRevision) {
        if (
          input.operation !== 'save' &&
          current.revision === input.expectedRevision + 1 &&
          current.state ===
            (
              {
                publish: 'published',
                resume: 'published',
                pause: 'paused',
                withdraw: 'withdrawn',
                archive: 'archived',
              } as const
            )[input.operation] &&
          (input.operation !== 'publish' ||
            current.latest_revision_id === current.published_revision_id)
        )
          return;
        const [same] =
          input.operation === 'save' &&
          current.revision === input.expectedRevision + 1
            ? await tx<
                { content: unknown }[]
              >`select content from allrice_company_asset_revisions where id=${current.latest_revision_id} and base_asset_revision=${input.expectedRevision} and created_by=${context.actor.id}`
            : [];
        if (
          input.operation === 'save' &&
          same &&
          runtimeContractEqual(same.content, input.content)
        )
          return;
        throw new CompanyAssetError('version_conflict');
      }
      if (input.operation === 'save') {
        if (current && current.kind !== input.content.kind)
          throw new CompanyAssetError('kind_conflict');
        if (input.content.kind === 'template' && !sourceId)
          throw new CompanyAssetError('source_required');
        if (input.content.sourceMemoryId) {
          const [memory] =
            await tx`select r.id from allrice_memories m join allrice_memory_revisions r on r.memory_id=m.id and r.organization_id=m.organization_id and r.workspace_id=m.workspace_id where m.id=${input.content.sourceMemoryId} and m.organization_id=${org} and m.archived_at is null and r.id=${input.content.sourceMemoryRevisionId!} for share of m,r`;
          if (!memory) throw new CompanyAssetError('source_changed');
        }
        if (input.content.appliesToEmployeeIds.length) {
          const employees =
            await tx`select id from allrice_platform_employees where id in ${tx(input.content.appliesToEmployeeIds)} and status<>'archived'`;
          if (
            employees.length !==
            new Set(input.content.appliesToEmployeeIds).size
          )
            throw new DataAccessError('not_found');
        }
        let file: CompanyAssetRevision['file'] = reused?.file_metadata ?? null;
        if (selected && bytes) {
          const [valid] =
            await tx`select o.id from allrice_storage_objects o join allrice_deliverable_versions v on v.object_id=o.id where v.id=${sourceId!} and v.organization_id=${org} and o.id=${selected.object.id} and o.checksum=${selected.object.checksum} and o.size_bytes=${selected.object.sizeBytes} and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp()) for share of o`;
          if (!valid) throw new CompanyAssetError('source_changed');
          const [quota] = await tx<
            {
              limit_bytes: number | string | null;
              used_bytes: number | string;
            }[]
          >`select q.limit_bytes,coalesce(sum(o.size_bytes)filter(where o.state<>'deleted'),0) as used_bytes from allrice_workspaces w left join allrice_storage_quotas q on q.organization_id=w.organization_id and q.workspace_id=w.id left join allrice_storage_objects o on o.organization_id=w.organization_id and o.workspace_id=w.id where w.organization_id=${org} and w.id=${quotaWorkspace} group by q.limit_bytes`;
          if (
            !quota ||
            (quota.limit_bytes !== null &&
              Number(quota.used_bytes) + bytes.length >
                Number(quota.limit_bytes))
          )
            throw new DataAccessError('quota_exceeded');
          const objectId = randomUUID();
          copied = {
            ...selected.object,
            id: objectId,
            ownerId: context.actor.id,
            key: makeObjectKey({
              organizationId: org,
              workspaceId: quotaWorkspace,
              ownerId: context.actor.id,
              category: 'exports',
              objectId,
            }),
            retentionUntil: null,
            deletedAt: null,
            immutable: true,
          };
          await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,visibility,state,immutable) values(${copied.id},${org},${quotaWorkspace},${context.actor.id},${copied.key},'exports',${copied.mediaType},${copied.sizeBytes},${copied.checksum},'private','pending',true)`;
          await storage.put(
            copied,
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          );
          await tx`update allrice_storage_objects set state='ready',updated_at=clock_timestamp() where id=${copied.id} and state='pending'`;
          file = {
            objectId: copied.id,
            checksum: copied.checksum,
            sizeBytes: copied.sizeBytes,
            mediaType: copied.mediaType,
            fileName: selected.version.fileName,
            format: selected.version.format,
          };
        }
        if (reused) {
          const [valid] =
            await tx`select o.id from allrice_company_asset_revisions r join allrice_storage_objects o on o.id=r.snapshot_object_id and o.state='ready' and o.deleted_at is null where r.id=${current!.latest_revision_id} and r.snapshot_object_id=${reused.snapshot_object_id!} for share of o`;
          if (!valid) throw new CompanyAssetError('source_changed');
        }
        if (!current)
          await tx`insert into allrice_company_assets(id,organization_id,owner_id,kind) values(${input.assetId},${org},${context.actor.id},${input.content.kind})`;
        const revisionId = randomUUID(),
          [latest] = await tx<
            { number: number }[]
          >`select coalesce(max(number),0)::int as number from allrice_company_asset_revisions where asset_id=${input.assetId}`;
        const digest = runtimePolicyDigest({ content: input.content, file });
        await tx`insert into allrice_company_asset_revisions(id,organization_id,asset_id,number,content,digest,snapshot_object_id,file_metadata,source_version_id,source_memory_id,source_memory_revision_id,base_asset_revision,created_by) values(${revisionId},${org},${input.assetId},${(latest?.number ?? 0) + 1},${tx.json(input.content)},${digest},${file?.objectId ?? null},${file ? tx.json(file) : null},${sourceId ?? null},${input.content.sourceMemoryId ?? null},${input.content.sourceMemoryRevisionId ?? null},${input.expectedRevision},${context.actor.id})`;
        await tx`update allrice_company_assets set latest_revision_id=${revisionId},revision=${current ? current.revision + 1 : 1},updated_at=clock_timestamp() where id=${input.assetId}`;
        await audit(tx, context, org, input.assetId, 'saved', revisionId);
      } else {
        if (!current) throw new DataAccessError('not_found');
        const publishing =
          input.operation === 'publish' || input.operation === 'resume';
        const publishedId =
          input.operation === 'publish'
            ? current.latest_revision_id
            : current.published_revision_id;
        if (publishing && !publishedId)
          throw new CompanyAssetError('asset_unavailable');
        if (publishing && current.kind === 'rule') {
          await tx`select pg_advisory_xact_lock(hashtextextended(${org},73))`;
          const [budget] = await tx<
            { bytes: number; count: number }[]
          >`select coalesce(sum(octet_length(r.content->>'body')),0)::int as bytes,count(*)::int as count from allrice_company_assets a join allrice_company_asset_revisions r on r.id=a.published_revision_id where a.organization_id=${org} and a.kind='rule' and a.state='published' and a.id<>${input.assetId}`;
          const [newRule] = await tx<
            { bytes: number }[]
          >`select octet_length(content->>'body')::int as bytes from allrice_company_asset_revisions where id=${publishedId!}`;
          if (
            (budget?.count ?? 0) + 1 > companyRuleBudget.maximumRules ||
            (budget?.bytes ?? 0) + (newRule?.bytes ?? 0) >
              companyRuleBudget.maximumBytes
          )
            throw new CompanyAssetError('rule_budget_exceeded');
        }
        const state = publishing
          ? 'published'
          : input.operation === 'pause'
            ? 'paused'
            : input.operation === 'withdraw'
              ? 'withdrawn'
              : 'archived';
        if (publishing)
          await tx`insert into allrice_company_asset_publications(asset_id,revision_id,published_by) values(${input.assetId},${publishedId!},${context.actor.id}) on conflict do nothing`;
        await tx`update allrice_company_assets set state=${state},published_revision_id=${publishing ? publishedId : current.published_revision_id},revision=revision+1,updated_at=clock_timestamp() where id=${input.assetId}`;
        await audit(
          tx,
          context,
          org,
          input.assetId,
          input.operation,
          publishedId,
        );
      }
    });
  } catch (error) {
    // Only this failed transaction's newly allocated object may be removed.
    // It never became a committed revision or an externally readable grant.
    if (copied)
      await storage
        .delete({ ...copied, immutable: false })
        .catch(() => undefined);
    throw error;
  }
  return getCompanyAsset(context, org, input.assetId, administration, db);
}
