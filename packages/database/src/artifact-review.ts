import { createHash } from 'node:crypto';
import {
  ChangesetDocumentSchema,
  WorkbenchArtifactSchema,
  WorkbenchArtifactKindSchema,
  ReviewDraftInputSchema,
  ReviewFeedbackSchema,
  ExecutionContextSchema,
  EmployeeExecutionSnapshotSchema,
  UuidSchema,
  runtimeContractEqual,
  WorkbenchCursorSchema,
  type WorkbenchArtifact,
  type ReviewDraftInput,
  type ExecutionContext,
  type RequestContext,
  type StorageObject,
  type StoragePort,
  type DeliveryFormat,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

type Database = ReturnType<typeof getDatabase>;
type Reader = Database | TransactionSql;
export type WorkbenchPrincipal = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId'
>;
export const workbenchEnabled = () =>
  process.env.ALLRICE_WORKBENCH_ENABLED === '1';
export class ArtifactReviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new ArtifactReviewError(code);
}
const hash = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Server DB identities, not cached memberships or a browser-supplied owner. */
export async function assertWorkbenchSession(
  db: Reader,
  context: WorkbenchPrincipal,
  sessionId: string,
  write = false,
) {
  UuidSchema.parse(sessionId);
  if (context.actor.type !== 'user' || !context.workspaceId)
    fail('identity_denied');
  const [session] = await db<
    { id: string }[]
  >`select id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and owner_id=${context.actor.id} and archived_at is null for update`;
  if (!session) fail('artifact_not_found');
  const users =
    await db`select id from allrice_users where id=${context.actor.id} and status='active' for share`;
  const organizations =
    await db`select id from allrice_organizations where id=${context.organizationId} and archived_at is null for share`;
  const workspaces =
    await db`select id from allrice_workspaces where id=${context.workspaceId} and organization_id=${context.organizationId} and archived_at is null for share`;
  const memberships = await db<
    { role: string }[]
  >`select role from allrice_memberships where organization_id=${context.organizationId} and user_id=${context.actor.id}
    and active and (workspace_id is null or workspace_id=${context.workspaceId}) for share`;
  if (
    !users.length ||
    !organizations.length ||
    !workspaces.length ||
    !memberships.some((m) => !write || ['admin', 'member'].includes(m.role))
  )
    fail('identity_denied');
}

interface ArtifactRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_id: string;
  series_id: string;
  version: number;
  parent_version_id: string | null;
  parent_object_id: string | null;
  session_id: string;
  platform_test_run_id: null;
  file_name: string;
  format: DeliveryFormat;
  change_summary: string | null;
  created_at: Date;
  object_key: string;
  checksum: string;
  media_type: string;
  size_bytes: string;
  retention_until: Date | null;
  deleted_at: Date | null;
  immutable: boolean;
  kind: string | null;
  provenance: unknown;
  execution: unknown;
  latest_version_id: string;
}
function mapArtifact(row: ArtifactRow): WorkbenchArtifact {
  return WorkbenchArtifactSchema.parse({
    contractVersion: 1,
    id: row.id,
    kind: row.kind ?? 'document',
    version: {
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
      platformTestRunId: null,
      fileName: row.file_name,
      format: row.format,
      changeSummary: row.change_summary,
      createdAt: row.created_at.toISOString(),
    },
    object: {
      id: row.object_id,
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
    },
    provenance: row.provenance ?? {
      kind: 'legacy_deliverable',
      runId: null,
      operationId: null,
      stepId: null,
    },
    execution: row.execution ?? null,
    latestVersionId: row.latest_version_id,
    stale: row.latest_version_id !== row.id,
  });
}
async function artifactRows(
  db: Reader,
  context: WorkbenchPrincipal,
  sessionId: string,
  artifactId: string | null,
  limit: number,
  before?: { createdAt: string; id: string },
) {
  return db<
    ArtifactRow[]
  >`select v.*,parent.object_id as parent_object_id,o.object_key,o.checksum,o.media_type,o.size_bytes,o.retention_until,o.deleted_at,o.immutable,
    a.kind,a.provenance,a.execution,latest.id as latest_version_id
    from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
    left join allrice_deliverable_versions parent on parent.id=v.parent_version_id
    left join allrice_workbench_artifacts a on a.version_id=v.id and a.organization_id=v.organization_id and a.workspace_id=v.workspace_id and a.owner_id=v.owner_id
    join lateral (select id from allrice_deliverable_versions x where x.series_id=v.series_id and x.organization_id=v.organization_id and x.workspace_id=v.workspace_id and x.owner_id=v.owner_id order by version desc limit 1) latest on true
    where v.organization_id=${context.organizationId} and v.workspace_id=${context.workspaceId!} and v.owner_id=${context.actor.id}
      and v.session_id=${sessionId} and o.state='ready' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())
      and (${artifactId}::uuid is null or v.id=${artifactId}::uuid)
      and (${before?.createdAt ?? null}::timestamptz is null or (v.created_at,v.id)<(${before?.createdAt ?? null}::timestamptz,${before?.id ?? null}::uuid))
    order by v.created_at desc,v.id desc limit ${limit}`;
}
export async function listWorkbenchArtifacts(
  context: WorkbenchPrincipal,
  sessionId: string,
  before?: { createdAt: string; id: string },
  db: Database = getDatabase(),
) {
  if (before) WorkbenchCursorSchema.parse(before);
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    const rows = await artifactRows(tx, context, sessionId, null, 51, before);
    const page = rows.slice(0, 50).map(mapArtifact),
      last = page.at(-1);
    return {
      artifacts: page,
      nextCursor:
        rows.length > 50 && last
          ? { createdAt: last.version.createdAt, id: last.id }
          : null,
    };
  });
}
export async function readArtifact(
  db: Reader,
  context: WorkbenchPrincipal,
  sessionId: string,
  id: string,
) {
  UuidSchema.parse(id);
  const [row] = await artifactRows(db, context, sessionId, id, 1);
  if (!row) fail('artifact_not_found');
  return mapArtifact(row);
}
export async function getWorkbenchArtifact(
  context: WorkbenchPrincipal,
  sessionId: string,
  id: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    return readArtifact(tx, context, sessionId, id);
  });
}
export async function readArtifactBytes(
  storage: StoragePort,
  object: StorageObject,
  maximum = 512_000,
) {
  if (object.sizeBytes > maximum) fail('preview_too_large');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      void reader?.cancel().catch(() => undefined);
      reject(new ArtifactReviewError('preview_timeout'));
    }, 10_000);
    timer.unref();
  });
  const read = async () => {
    const stream = await storage.get(object);
    if (expired) {
      void stream.cancel().catch(() => undefined);
      fail('preview_timeout');
    }
    reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum || size > object.sizeBytes) {
          void reader.cancel().catch(() => undefined);
          fail('content_changed');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== object.sizeBytes || hash(bytes) !== object.checksum)
      fail('content_changed');
    return bytes;
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
export function parseChangesetBytes(bytes: Uint8Array) {
  if (bytes.byteLength > 512_000) fail('changeset_too_large');
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes),
    changeset = ChangesetDocumentSchema.parse(JSON.parse(text));
  for (const file of changeset.files)
    for (const side of [file.before, file.after])
      if (
        side &&
        (side.text.includes('\0') || hash(side.text) !== side.checksum)
      )
        fail('changeset_content_mismatch');
  return changeset;
}
async function assertArtifactExecution(
  tx: TransactionSql,
  context: ExecutionContext,
  bytes: Uint8Array,
) {
  const changeset = parseChangesetBytes(bytes),
    e = changeset.execution;
  // P06/P08 first execution target is one existing Bridge grant, not a cloud migration authorization.
  if (
    e.targetKind !== 'rice_bridge' ||
    !e.deviceId ||
    !e.grantId ||
    e.workCopy.kind !== 'in_place' ||
    e.workCopy.id !== e.grantId
  )
    fail('target_unavailable');
  const [target] = await tx`select t.id from allrice_execution_targets t
    join allrice_bridge_devices d on t.target_key='bridge.'||d.id::text and d.organization_id=t.organization_id and d.workspace_id=t.workspace_id
    join allrice_bridge_folder_grants g on g.device_id=d.id and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
    where t.id=${e.targetId} and t.kind='rice_bridge' and t.organization_id=${context.organizationId} and t.workspace_id=${context.workspaceId!}
      and d.id=${e.deviceId} and d.owner_id=${context.policySnapshot.subjectId} and d.revoked_at is null
      and g.id=${e.grantId} and g.revoked_at is null and g.runtime_generation=${e.grantVersion} and 'sha256:'||g.root_fingerprint=${e.scopeDigest}
    for share of t,d,g`;
  if (!target) fail('target_unavailable');
  return e;
}
async function assertPublishingRun(
  tx: TransactionSql,
  context: ExecutionContext,
  sessionId: string,
  requiredTool = 'workspace.export.create',
) {
  const [row] = await tx<
    { execution_snapshot: unknown }[]
  >`select e.execution_snapshot from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    join allrice_jobs j on j.id=${context.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    where r.id=${context.runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId!} and r.owner_id=${context.policySnapshot.subjectId}
      and r.policy_snapshot_id=${context.policySnapshot.id} and e.session_id=${sessionId} and r.state='running'
      and j.status='running' and j.worker_id=${context.worker.id} and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      for share of e,r,j`;
  const parsed = EmployeeExecutionSnapshotSchema.safeParse(
    row?.execution_snapshot,
  );
  if (
    !parsed.success ||
    parsed.data.tenantContext.organizationId !== context.organizationId ||
    parsed.data.tenantContext.workspaceId !== context.workspaceId ||
    parsed.data.tenantContext.actorId !== context.policySnapshot.subjectId ||
    parsed.data.tenantContext.policySnapshotId !== context.policySnapshot.id ||
    !parsed.data.capabilitySnapshot.grantedCapabilities.includes(
      'storage:write',
    ) ||
    !parsed.data.capabilitySnapshot.bindings.toolNames.includes(requiredTool)
  )
    fail('run_unavailable');
}

async function assertCloudDerivationLease(
  tx: TransactionSql,
  context: ExecutionContext,
  operationId: string,
) {
  // Derivation is another effect of the same originating cloud job. The same
  // Worker ID acquiring a new lease cannot resume the stale publication.
  const [current] =
    await tx`select i.operation_id from allrice_cloud_execution_inputs i
    join allrice_jobs j on j.id=i.job_id and j.run_id=i.run_id and j.organization_id=i.organization_id and j.workspace_id=i.workspace_id and j.owner_id=i.owner_id
      and j.worker_id=i.worker_id and j.lease_token=i.job_lease_token
    where i.operation_id=${operationId} and i.job_id=${context.jobId} and i.run_id=${context.runId}
      and i.organization_id=${context.organizationId} and i.workspace_id=${context.workspaceId!} and i.owner_id=${context.policySnapshot.subjectId}
      and j.worker_id=${context.worker.id} and j.status='running' and j.cancel_requested_at is null
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() for share of i,j`;
  if (!current) fail('run_unavailable');
}

/** Existing export generator calls this opt-in publisher; bytes/versions retain the existing StoragePort lineage. */
export async function publishWorkbenchArtifact(
  input: {
    context: ExecutionContext;
    sessionId: string;
    callId: string;
    kind: 'document' | 'plan' | 'changeset';
    fileName: string;
    format: DeliveryFormat;
    bytes: Uint8Array;
    mediaType: string;
    parentObjectId?: string;
    changeSummary?: string;
    /** Server-only deterministic renderer input; never accepted by generic export HTTP/tool arguments. */
    trustedCloudDerivation?: {
      sourceArtifactId: string;
      renderer: 'reconciliation-xlsx-v1';
    };
  },
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  if (!workbenchEnabled()) fail('feature_disabled');
  const context = ExecutionContextSchema.parse(input.context),
    owner = context.policySnapshot.subjectId;
  if (
    !context.workspaceId ||
    !input.callId ||
    input.callId.length > 255 ||
    input.bytes.byteLength > 8_000_000
  )
    fail('invalid_publication');
  WorkbenchArtifactKindSchema.parse(input.kind);
  if (!['document', 'plan', 'changeset'].includes(input.kind))
    fail('invalid_publication');
  if (
    input.kind === 'changeset' &&
    (input.format !== 'json' || input.mediaType !== 'application/json')
  )
    fail('invalid_publication');
  const principal: WorkbenchPrincipal = {
    actor: { type: 'user', id: owner },
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
  };
  const checksum = hash(input.bytes),
    requestDigest = runtimePolicyDigest({
      sessionId: input.sessionId,
      kind: input.kind,
      fileName: input.fileName,
      format: input.format,
      ...(input.trustedCloudDerivation
        ? { derivation: input.trustedCloudDerivation }
        : { checksum }),
      mediaType: input.mediaType,
      parentObjectId: input.parentObjectId ?? null,
      changeSummary: input.changeSummary ?? null,
    });
  // Cleanup only this newly generated object after a rolled-back registration, never a previous version.
  let created: StorageObject | undefined;
  try {
    return await db.begin(async (tx) => {
      await lockWorkspaceStorageQuota(
        tx,
        context.organizationId,
        context.workspaceId,
      );
      await assertWorkbenchSession(tx, principal, input.sessionId, true);
      let derivedSource: WorkbenchArtifact | null = null;
      if (input.trustedCloudDerivation) {
        if (
          input.trustedCloudDerivation.renderer !== 'reconciliation-xlsx-v1' ||
          input.kind !== 'document' ||
          input.format !== 'xlsx'
        )
          fail('invalid_publication');
        derivedSource = await readArtifact(
          tx,
          principal,
          input.sessionId,
          UuidSchema.parse(input.trustedCloudDerivation.sourceArtifactId),
        );
        if (
          derivedSource.provenance.kind !== 'tool_result' ||
          derivedSource.provenance.runId !== context.runId ||
          !derivedSource.provenance.operationId ||
          derivedSource.execution?.targetKind !== 'cloud_sandbox' ||
          derivedSource.object.mediaType !== 'application/json'
        )
          fail('invalid_publication');
        const [operation] =
          await tx`select id from allrice_runtime_operations where id=${derivedSource.provenance.operationId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and snapshot->>'status'='succeeded' and snapshot->'binding'->>'action'='cloud.process.execute' for share`;
        if (!operation) fail('invalid_publication');
      }
      await tx`select pg_advisory_xact_lock(hashtextextended(${`artifact:${context.runId}:${input.callId}`},0))`;
      const [existing] = await tx<
        { version_id: string; request_digest: string }[]
      >`select version_id,request_digest from allrice_workbench_artifacts
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and run_id=${context.runId} and request_id=${input.callId}`;
      if (existing) {
        if (existing.request_digest !== requestDigest)
          fail('idempotency_conflict');
        return readArtifact(
          tx,
          principal,
          input.sessionId,
          existing.version_id,
        );
      }
      const requiredTool = derivedSource
        ? 'workspace.reconciliation.export'
        : 'workspace.export.create';
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      if (derivedSource)
        await assertCloudDerivationLease(
          tx,
          context,
          derivedSource.provenance.operationId!,
        );
      let parent: WorkbenchArtifact | null = null;
      if (input.parentObjectId) {
        const [p] = await tx<
          { id: string }[]
        >`select id from allrice_deliverable_versions where object_id=${UuidSchema.parse(input.parentObjectId)} and session_id=${input.sessionId}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and owner_id=${owner}`;
        if (!p) fail('artifact_not_found');
        parent = await readArtifact(tx, principal, input.sessionId, p.id);
        if (parent.stale || parent.kind !== input.kind) fail('version_changed');
      }
      const execution =
        input.kind === 'changeset'
          ? await assertArtifactExecution(tx, context, input.bytes)
          : (derivedSource?.execution ?? null);
      // The entry's quota gate still covers this increment across all storage sources.
      created = {
        ...createToolBrokerExportObject({
          context,
          mediaType: input.mediaType,
          sizeBytes: input.bytes.byteLength,
          checksum,
        }),
        immutable: true,
      };
      await storage.put(
        created,
        new Blob([Uint8Array.from(input.bytes)]).stream(),
      );
      const version = await registerToolBrokerExport(
        {
          context,
          sessionId: input.sessionId,
          fileName: input.fileName,
          format: input.format,
          object: created,
          ...(input.parentObjectId
            ? { parentObjectId: input.parentObjectId }
            : {}),
          ...(input.changeSummary
            ? { changeSummary: input.changeSummary }
            : {}),
        },
        tx,
      );
      const provenance = {
        kind: derivedSource ? 'tool_result' : 'model_proposal',
        runId: context.runId,
        operationId: derivedSource?.provenance.operationId ?? null,
        stepId: null,
      };
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)
      values(${version.id},${context.organizationId},${context.workspaceId!},${owner},${context.runId},${input.kind},${tx.json(provenance)},${execution ? tx.json(execution) : null},${input.callId},${requestDigest})`;
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${context.organizationId},${context.workspaceId!},${owner},'artifact.published','deliverable_version',${version.id},'recorded','immutable_version',${tx.json({ runId: context.runId, sessionId: input.sessionId, checksum, kind: input.kind, ...(input.trustedCloudDerivation ? { derivation: input.trustedCloudDerivation, sourceChecksum: derivedSource!.object.checksum } : {}) })})`;
      const artifact = await readArtifact(
        tx,
        principal,
        input.sessionId,
        version.id,
      );
      // Audit insertion and projection reads may block. Recheck the authoritative
      // deadline after those waits, immediately before committing the new version.
      if (derivedSource)
        await assertCloudDerivationLease(
          tx,
          context,
          derivedSource.provenance.operationId!,
        );
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      return artifact;
    });
  } catch (error) {
    if (created) {
      // A lost commit acknowledgement is ambiguous. Query the same primary before
      // cleanup; if unavailable, retain the bounded orphan, never delete evidence.
      const known = await db<
        { id: string }[]
      >`select id from allrice_storage_objects where id=${created.id}`.catch(
        () => null,
      );
      if (known && known.length === 0)
        await storage
          .delete({ ...created, immutable: false })
          .catch(() => undefined);
    }
    throw error;
  }
}

export async function publishReconciliationWorkbook(
  input: {
    context: ExecutionContext;
    sessionId: string;
    callId: string;
    sourceArtifactId: string;
    fileName: string;
    bytes: Uint8Array;
    parentObjectId?: string;
  },
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  return publishWorkbenchArtifact(
    {
      context: input.context,
      sessionId: input.sessionId,
      callId: input.callId,
      kind: 'document',
      fileName: input.fileName,
      format: 'xlsx',
      bytes: input.bytes,
      mediaType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      trustedCloudDerivation: {
        sourceArtifactId: input.sourceArtifactId,
        renderer: 'reconciliation-xlsx-v1',
      },
      ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
      changeSummary: '按已确认的云端整数分对账结果生成；未重新计算或改写金额',
    },
    storage,
    db,
  );
}

interface FeedbackRow {
  id: string;
  artifact_id: string;
  actor_id: string;
  revision: number;
  checksum: string;
  comments: unknown;
  state: string;
  result_artifact_id: string | null;
  resolution: string | null;
  created_at: Date;
  submitted_at: Date | null;
  updated_at: Date;
}
function mapFeedback(row: FeedbackRow, artifact: WorkbenchArtifact) {
  return ReviewFeedbackSchema.parse({
    id: row.id,
    artifactId: row.artifact_id,
    actorId: row.actor_id,
    revision: row.revision,
    checksum: row.checksum,
    comments: row.comments,
    state: row.state,
    stale: artifact.stale,
    resultArtifactId: row.result_artifact_id,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  });
}
export async function listArtifactFeedback(
  context: WorkbenchPrincipal,
  sessionId: string,
  artifactId: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    const artifact = await readArtifact(tx, context, sessionId, artifactId);
    const rows = await tx<
      FeedbackRow[]
    >`select * from allrice_artifact_feedback where organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}
      and artifact_id=${artifact.id} and actor_id=${context.actor.id} order by created_at limit 100`;
    return rows.map((r) => mapFeedback(r, artifact));
  });
}
async function validateAnchors(
  artifact: WorkbenchArtifact,
  draft: ReviewDraftInput,
  storage: StoragePort,
) {
  if (draft.checksum !== artifact.object.checksum) fail('version_changed');
  if (draft.comments.every((c) => c.anchor.kind === 'whole')) return;
  const bytes = await readArtifactBytes(storage, artifact.object),
    changeset =
      artifact.kind === 'changeset' ? parseChangesetBytes(bytes) : null;
  if (
    !changeset &&
    !['text/plain', 'text/markdown', 'application/json'].includes(
      artifact.object.mediaType,
    )
  )
    fail('whole_artifact_feedback_required');
  for (const c of draft.comments) {
    const a = c.anchor;
    if (a.kind === 'whole') continue;
    const side = changeset
      ? changeset.files.find((f) => f.path === a.path)?.[a.side]
      : a.path === null && a.side === 'after'
        ? {
            text: new TextDecoder('utf8', { fatal: true }).decode(bytes),
            checksum: artifact.object.checksum,
          }
        : null;
    if (
      !side ||
      side.checksum !== a.checksum ||
      a.endLine > side.text.split('\n').length
    )
      fail('anchor_changed');
  }
}
/** Draft/save and submit both carry the exact complete body plus optimistic revision. */
export async function saveArtifactFeedback(
  context: WorkbenchPrincipal,
  sessionId: string,
  input: unknown,
  submit: boolean,
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  if (!workbenchEnabled()) fail('feature_disabled');
  const draft = ReviewDraftInputSchema.parse(input);
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId, true);
    const artifact = await readArtifact(
      tx,
      context,
      sessionId,
      draft.artifactId,
    );
    const [old] = await tx<
      FeedbackRow[]
    >`select * from allrice_artifact_feedback where id=${draft.feedbackId} for update`;
    if (
      old &&
      (old.actor_id !== context.actor.id || old.artifact_id !== artifact.id)
    )
      fail('feedback_conflict');
    if (old?.state !== 'draft' && old) {
      if (
        submit &&
        old.checksum === draft.checksum &&
        runtimeContractEqual(old.comments, draft.comments)
      )
        return mapFeedback(old, artifact);
      fail('feedback_already_submitted');
    }
    if (artifact.stale) fail('version_changed');
    await validateAnchors(artifact, draft, storage);
    if (
      old &&
      old.revision === draft.expectedRevision + 1 &&
      old.checksum === draft.checksum &&
      runtimeContractEqual(old.comments, draft.comments) &&
      !submit
    )
      return mapFeedback(old, artifact);
    if ((old?.revision ?? 0) !== draft.expectedRevision)
      fail('revision_conflict');
    if (!old) {
      const [count] = await tx<
        { total: string }[]
      >`select count(*) as total from allrice_artifact_feedback where organization_id=${context.organizationId}
        and workspace_id=${context.workspaceId!} and artifact_id=${artifact.id} and actor_id=${context.actor.id}`;
      if (Number(count?.total ?? 0) >= 100) fail('feedback_limit');
    }
    if (!old)
      await tx`insert into allrice_artifact_feedback(id,organization_id,workspace_id,actor_id,artifact_id,checksum,revision,comments,state,submitted_at)
      values(${draft.feedbackId},${context.organizationId},${context.workspaceId!},${context.actor.id},${artifact.id},${draft.checksum},1,${tx.json(draft.comments)},${submit ? 'submitted' : 'draft'},${submit ? new Date() : null})`;
    else
      await tx`update allrice_artifact_feedback set revision=revision+1,comments=${tx.json(draft.comments)},state=${submit ? 'submitted' : 'draft'},
      submitted_at=${submit ? new Date() : null},updated_at=clock_timestamp() where id=${draft.feedbackId}`;
    if (submit)
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${context.organizationId},${context.workspaceId!},${context.actor.id},'artifact.feedback_submitted','artifact_feedback',${draft.feedbackId},'recorded','not_execution_authorization',${tx.json({ artifactId: artifact.id, sessionId, checksum: artifact.object.checksum })})`;
    const [row] = await tx<
      FeedbackRow[]
    >`select * from allrice_artifact_feedback where id=${draft.feedbackId}`;
    return mapFeedback(row!, artifact);
  });
}
/** An explicit response reference, not a claim that user feedback was semantically resolved. */
export async function addressArtifactFeedback(
  context: WorkbenchPrincipal,
  sessionId: string,
  input: { feedbackId: string; resultArtifactId: string; resolution: string },
  db: Database = getDatabase(),
) {
  if (!workbenchEnabled()) fail('feature_disabled');
  UuidSchema.parse(input.feedbackId);
  UuidSchema.parse(input.resultArtifactId);
  const resolution = input.resolution.trim();
  if (!resolution || resolution.length > 4000) fail('invalid_feedback');
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId, true);
    const [old] = await tx<
      FeedbackRow[]
    >`select * from allrice_artifact_feedback where id=${input.feedbackId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and actor_id=${context.actor.id} for update`;
    if (!old) fail('feedback_not_found');
    const artifact = await readArtifact(
        tx,
        context,
        sessionId,
        old.artifact_id,
      ),
      result = await readArtifact(
        tx,
        context,
        sessionId,
        input.resultArtifactId,
      );
    if (old.state === 'addressed') {
      if (old.result_artifact_id === result.id && old.resolution === resolution)
        return mapFeedback(old, artifact);
      fail('feedback_conflict');
    }
    if (
      old.state !== 'submitted' ||
      result.version.seriesId !== artifact.version.seriesId ||
      result.version.version <= artifact.version.version
    )
      fail('invalid_resolution');
    await tx`update allrice_artifact_feedback set state='addressed',result_artifact_id=${result.id},resolution=${resolution},updated_at=clock_timestamp() where id=${old.id}`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${context.organizationId},${context.workspaceId!},${context.actor.id},'artifact.feedback_addressed','artifact_feedback',${old.id},'recorded','response_linked_not_execution_authorization',${tx.json({ resultArtifactId: result.id })})`;
    const [updated] = await tx<
      FeedbackRow[]
    >`select * from allrice_artifact_feedback where id=${old.id}`;
    return mapFeedback(updated!, artifact);
  });
}
