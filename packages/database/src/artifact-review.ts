import { finalDeliveryRootIsLocked } from './final-delivery-commit.ts';
import { nativeContextExecutionRetired } from './conversation/native-context-retirement.ts';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import { assertProjectOutputParent } from './project-output-parent.ts';
import { createHash } from 'node:crypto';
import {
  RuntimeTaskRefSchema,
  ChecksumSchema,
  type RuntimeTaskRef,
  ChangesetDocumentSchema,
  ChangesetProposalSchema,
  WorkbenchArtifactSchema,
  WorkbenchArtifactKindSchema,
  ReviewDraftInputSchema,
  ReviewFeedbackSchema,
  ExecutionContextSchema,
  EmployeeExecutionSnapshotSchema,
  UuidSchema,
  runtimeContractEqual,
  WorkbenchCursorSchema,
  ArtifactSourceFileSchema,
  type ArtifactSourceFile,
  type OfficeDeliveryReceipt,
  OfficeExportProducerSchema,
  assessOfficeFormulaCaches,
  officeMediaTypes,
  type OfficeExportProducer,
  type WorkbenchArtifact,
  type ReviewDraftInput,
  type ExecutionContext,
  type RequestContext,
  type StorageObject,
  type StoragePort,
  type DeliveryFormat,
  type RuntimeExecutionScope,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { businessDeliverablePredicate } from './organization-dashboard.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
  assertToolBrokerSourceFile,
} from './execution/tool-broker.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { workbenchFileAccess } from './workbench-file-access.ts';
import { recordTransactionRetry } from './core/transaction-retries.ts';
import {
  parseOfficeDeliveryReceiptForObject,
  readBoundOfficeDeliveryReceipt,
} from './office-delivery-receipt.ts';
import {
  requireTenantInspectionScope,
  type TenantManagementTarget,
} from './tenant-management-scope.ts';

type Database = ReturnType<typeof getDatabase>;
type Reader = Database | TransactionSql;
export type WorkbenchPrincipal = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId'
>;
export const workbenchEnabled = () =>
  runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED');
export class ArtifactReviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** A parent was rejected inside publication, before any new storage write or
 * version registration. This is not a transport/commit failure receipt. */
export class ArtifactPublicationParentError extends ArtifactReviewError {
  constructor(
    readonly runId: string,
    readonly callId: string,
    code: 'artifact_not_found' | 'version_changed',
  ) {
    super(code);
  }
}
/** Issued only after PostgreSQL aborted publication and any private blob was
 * confirmed removed. A lost commit acknowledgement must never create this. */
export class ArtifactPublicationRollbackError extends Error {
  constructor(
    readonly runId: string,
    readonly callId: string,
    readonly sqlState: '40P01' | '40001',
    cause: unknown,
  ) {
    super('artifact_publication_rolled_back', { cause });
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
  /** `false` on read paths: same checks as plain snapshot reads (MET-210 #4). */
  lock: 'update' | 'share' | false = 'update',
) {
  UuidSchema.parse(sessionId);
  if (context.actor.type !== 'user' || !context.workspaceId)
    fail('identity_denied');
  // Identity precedes Session locks, matching task admission and maintenance
  // writes. Taking Session first can deadlock with an enqueue that has locked
  // the user to allocate its policy version.
  const organizations =
    await db`select id from allrice_organizations where id=${context.organizationId} and archived_at is null ${lock ? db`for share` : db``}`;
  const workspaces =
    await db`select id from allrice_workspaces where id=${context.workspaceId} and organization_id=${context.organizationId} and archived_at is null ${lock ? db`for share` : db``}`;
  const users =
    await db`select id from allrice_users where id=${context.actor.id} and status='active' ${lock ? db`for share` : db``}`;
  const memberships = await db<
    { role: string }[]
  >`select role from allrice_memberships where organization_id=${context.organizationId} and user_id=${context.actor.id}
    and active and (workspace_id is null or workspace_id=${context.workspaceId}) order by id ${lock ? db`for share` : db``}`;
  const [session] = await db<
    { id: string }[]
  >`select id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and owner_id=${context.actor.id} and (${!write} or archived_at is null)
      ${lock === 'update' ? db`for update` : lock === 'share' ? db`for share` : db``}`;
  if (!session) fail('artifact_not_found');
  if (write && (await nativeContextExecutionRetired(db, 'chat', sessionId)))
    fail('artifact_not_found');
  // Preserve the existing not-found boundary for a foreign Session/owner.
  // Only the lock acquisition order changed; identity checks still gate access.
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
  cursor_created_at: string;
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
  origin_run_id: string | null;
  object_state: string;
  publication_call_id: string | null;
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
  scope: { organizationId: string; workspaceId: string; ownerId: string },
  sessionId: string,
  artifactId: string | null,
  limit: number,
  before?: { createdAt: string; id: string },
  runId: string | null = null,
  includeToolResults = true,
  delivery?: {
    ownedRunIds?: readonly string[];
    includeUnavailable?: boolean;
    businessOnly?: boolean;
    lockObjects?: boolean;
  },
) {
  return db<
    ArtifactRow[]
  >`select v.*,to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,
    parent.object_id as parent_object_id,o.object_key,o.checksum,o.media_type,o.size_bytes,o.retention_until,o.deleted_at,o.immutable,
    a.kind,a.provenance,a.execution,a.run_id as origin_run_id,a.request_id as publication_call_id,o.state as object_state,latest.id as latest_version_id
    from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
    left join allrice_deliverable_versions parent on parent.id=v.parent_version_id
    left join allrice_workbench_artifacts a on a.version_id=v.id and a.organization_id=v.organization_id and a.workspace_id=v.workspace_id and a.owner_id=v.owner_id
    join lateral (select id from allrice_deliverable_versions x where x.series_id=v.series_id and x.organization_id=v.organization_id and x.workspace_id=v.workspace_id and x.owner_id=v.owner_id order by version desc limit 1) latest on true
    where v.organization_id=${scope.organizationId} and v.workspace_id=${scope.workspaceId} and v.owner_id=${scope.ownerId}
      and v.session_id=${sessionId}
      and (${delivery?.includeUnavailable ?? false} or (o.state='ready' and o.deleted_at is null
        and (o.retention_until is null or o.retention_until>clock_timestamp())))
      and (${!delivery?.ownedRunIds} or a.run_id=any(${[...(delivery?.ownedRunIds ?? [])]}::uuid[]))
      and (${!delivery?.businessOnly} or a.version_id is null or a.kind in ('document','plan','file'))
      and (${artifactId}::uuid is null or v.id=${artifactId}::uuid)
      and (${runId}::uuid is null or a.run_id=${runId}::uuid)
      and (${includeToolResults} or coalesce(a.provenance->>'kind','') <> 'project_snapshot')
      -- Oversized tool responses are stored for model paging, not delivered
      -- files. Match both writer metadata and its exact object-bound filename.
      -- Keep explicit reads and administrator inspection available.
      and (${includeToolResults} or not (
        a.version_id is null
        and coalesce(v.change_summary, '') like 'Tool result %; Run %; call %'
        and v.file_name = 'tool-result-' || replace(replace(split_part(v.change_summary, ';', 1), 'Tool result ', ''), '.', '-') || '-' || v.object_id::text || '.txt'
      ))
      -- Bind text before casting: the driver's timestamptz serializer uses
      -- JavaScript Date and would truncate the cursor's microseconds again.
      and (${before?.createdAt ?? null}::text::timestamptz is null or (v.created_at,v.id)<(${before?.createdAt ?? null}::text::timestamptz,${before?.id ?? null}::uuid))
    order by v.created_at desc,v.id desc limit ${limit}
    ${delivery?.lockObjects ? db`for share of v,o` : db``}`;
}
/** Internal fact type, exported only for the database declaration boundary. */
export interface WorkerDeliveryIdentity {
  objectId: string;
  versionId: string;
  checksum: string;
}
interface WorkerDeliveryAuthority {
  task: RuntimeTaskRef;
  /** Run-only delivery never discovers ownership from the retired assistant tree. */
  ownership?: 'root_run';
  /** Bound by the trusted frozen request/method reader, never candidate text. */
  explicitReferences: readonly WorkerDeliveryIdentity[];
}
export interface WorkerDeliveryCheck extends WorkerDeliveryIdentity {
  scope: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
  };
  originRunId: string | null;
  checkId:
    | 'office.rendered'
    | 'office.formula_errors'
    | 'office.saved_values'
    | 'office.visual';
  status: 'passed' | 'failed' | 'unavailable' | 'not_checked';
}

export interface OfficeFirstDeliveryVersion extends WorkerDeliveryIdentity {
  seriesId: string;
  version: number;
  latestVersionId: string;
  originRunId: string | null;
  kind: string | null;
  provenanceKind: string;
  format: string;
  mediaType: string;
  publicationCallId: string | null;
  producerAuditId: string | null;
  receipts: readonly (OfficeDeliveryReceipt | null)[];
}

/** @internal Pure binding check after the same-Tx reader has authorized rows.
 * A quality receipt is not a producer identity; failed/missing quality is retained. */
export function readCanonicalOfficeExportProducer(
  metadata: unknown,
  output: Pick<
    OfficeFirstDeliveryVersion,
    | 'objectId'
    | 'checksum'
    | 'originRunId'
    | 'publicationCallId'
    | 'kind'
    | 'provenanceKind'
    | 'format'
    | 'mediaType'
  > & { sessionId: string },
): OfficeExportProducer | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return null;
  const value = metadata as Record<string, unknown>;
  if (!Object.hasOwn(value, 'officeExport')) return null;
  const parsed = OfficeExportProducerSchema.safeParse(value.officeExport);
  if (
    !parsed.success ||
    !output.originRunId ||
    output.kind !== 'document' ||
    output.provenanceKind !== 'model_proposal' ||
    !Object.hasOwn(officeMediaTypes, output.format) ||
    officeMediaTypes[output.format as keyof typeof officeMediaTypes] !==
      output.mediaType ||
    parsed.data.objectId !== output.objectId ||
    parsed.data.callId !== output.publicationCallId ||
    value.runId !== output.originRunId ||
    value.sessionId !== output.sessionId ||
    value.checksum !== output.checksum ||
    value.kind !== 'document'
  )
    return fail('final_delivery_evidence_unavailable');
  return parsed.data;
}

/** @internal Technical obligations for exact, authorized current-Run Office
 * versions. This neither discovers a user's expected outputs nor grants access. */
export function buildOfficeFirstDeliveryRequirements(
  versions: readonly OfficeFirstDeliveryVersion[],
  ownedRunIds: readonly string[],
) {
  const owned = versions.filter(
    (version) =>
      version.originRunId !== null && ownedRunIds.includes(version.originRunId),
  );
  const shape = (version: OfficeFirstDeliveryVersion) =>
    version.kind === 'document' &&
    version.provenanceKind === 'model_proposal' &&
    version.format === 'xlsx' &&
    version.mediaType === officeMediaTypes.xlsx;
  const groups = new Map<string, OfficeFirstDeliveryVersion[]>();
  for (const version of owned) {
    if (!shape(version)) continue;
    if (
      !version.producerAuditId ||
      !UuidSchema.safeParse(version.producerAuditId).success ||
      !version.publicationCallId
    )
      return fail('final_delivery_evidence_unavailable');
    if (
      !UuidSchema.safeParse(version.seriesId).success ||
      !UuidSchema.safeParse(version.versionId).success ||
      !UuidSchema.safeParse(version.objectId).success ||
      !ChecksumSchema.safeParse(version.checksum).success ||
      !Number.isSafeInteger(version.version) ||
      version.version < 1
    )
      return fail('final_delivery_evidence_unavailable');
    if (
      new Set(
        version.receipts.map((receipt) =>
          receipt?.savedValues
            ? runtimePolicyDigest(receipt.savedValues)
            : 'missing',
        ),
      ).size > 1
    )
      return fail('final_delivery_evidence_unavailable');
    const group = groups.get(version.seriesId) ?? [];
    group.push(version);
    groups.set(version.seriesId, group);
  }
  const requirements: {
    id: string;
    expected: WorkerDeliveryIdentity | null;
    source: 'current_run';
    requireLink: boolean;
    requiredChecks: string[];
    whenLinked?: true;
  }[] = [];
  const identity = (
    version: OfficeFirstDeliveryVersion,
  ): WorkerDeliveryIdentity => ({
    objectId: version.objectId,
    versionId: version.versionId,
    checksum: version.checksum,
  });
  for (const [seriesId, group] of groups) {
    const latest = group[0]!.latestVersionId;
    if (
      !UuidSchema.safeParse(latest).success ||
      group.some((version) => version.latestVersionId !== latest)
    )
      return fail('final_delivery_evidence_unavailable');
    const head = owned.find(
      (version) =>
        version.seriesId === seriesId && version.versionId === latest,
    );
    const hasFormulas = group.some((version) =>
      version.receipts.some(
        (receipt) => assessOfficeFormulaCaches(receipt).hasFormulas,
      ),
    );
    const assessments = (version: OfficeFirstDeliveryVersion) =>
      (version.receipts.length ? version.receipts : [null]).map((receipt) =>
        assessOfficeFormulaCaches(receipt, hasFormulas),
      );
    const headIncomplete =
      !head ||
      !shape(head) ||
      !head.producerAuditId ||
      assessments(head).some(
        (assessment) => assessment.status === 'incomplete',
      );
    if (hasFormulas || headIncomplete)
      requirements.push({
        id: `office-cache:v1:${seriesId}:${latest}`,
        expected:
          head && shape(head) && head.producerAuditId ? identity(head) : null,
        source: 'current_run',
        requireLink: true,
        requiredChecks: ['office.saved_values', 'office.formula_errors'],
      });
    for (const version of group) {
      if (version.versionId === head?.versionId) continue;
      if (
        !assessments(version).some(
          (assessment) =>
            assessment.hasFormulas || assessment.status === 'incomplete',
        )
      )
        continue;
      requirements.push({
        id: `office-cache:v1:${seriesId}:${version.versionId}`,
        expected: identity(version),
        source: 'current_run',
        requireLink: false,
        requiredChecks: ['office.saved_values', 'office.formula_errors'],
        whenLinked: true,
      });
    }
    if (requirements.length > 1000)
      return fail('final_delivery_evidence_unavailable');
  }
  return requirements;
}

/** @internal Worker-only transaction reader; no HTTP/model input or admin principal.
 * The host must supply the SAME transaction's root/job/lease/current-authority
 * closure. It locks root -> job, authorizes phase:evidence/tools:[], rechecks the
 * live incarnation, and returns the DB-bound task and frozen exact references.
 * Bound by createAssistantRuntime.readFinalDeliveryEvidence for an existing
 * assistant root, current Worker Job and generation/fence. The closure reacquires
 * that root before each head/tail check; authorize resolves its owner/session.
 * Ordinary non-assistant Worker routes require their own existing Job authority.
 * An independently committed assertCurrentAuthority() call is insufficient.
 * This reader does not acquire/consume a native completion fence or finish a Run.
 */
export async function readWorkerFinalDeliveryEvidenceTransaction(
  tx: TransactionSql,
  assertCurrent: (
    transaction: TransactionSql,
  ) => Promise<WorkerDeliveryAuthority>,
) {
  function unavailable(): never {
    return fail('final_delivery_evidence_unavailable');
  }
  const first = structuredClone(await assertCurrent(tx));
  const [isolation] = await tx<
    { transaction_isolation: string }[]
  >`show transaction_isolation`;
  if (!(
    ['repeatable read', 'serializable'].includes(
      isolation?.transaction_isolation ?? '',
    ) ||
    (isolation?.transaction_isolation === 'read committed' &&
      finalDeliveryRootIsLocked(tx, first.task.rootRunId))
  ))
    unavailable();
  const task = RuntimeTaskRefSchema.parse(first.task);
  if (task.runId !== task.rootRunId || !task.chatSessionId) unavailable();
  const references = first.explicitReferences.map((identity) => ({
    objectId: UuidSchema.parse(identity.objectId),
    versionId: UuidSchema.parse(identity.versionId),
    checksum: ChecksumSchema.parse(identity.checksum),
  }));
  if (
    references.length > 1000 ||
    new Set(references.map((r) => r.versionId)).size !== references.length
  )
    unavailable();
  const [root] = await tx<
    { owner_id: string; session_id: string; execution_snapshot: unknown }[]
  >`
    select r.owner_id,e.session_id,e.execution_snapshot from allrice_runs r
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id
      and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    where r.id=${task.rootRunId} and r.organization_id=${task.scope.organizationId}
      and r.workspace_id=${task.scope.workspaceId} and r.state='running'
      and e.session_id=${task.chatSessionId} for share of r,e`;
  if (!root) unavailable();
  const frozen = EmployeeExecutionSnapshotSchema.safeParse(
    root.execution_snapshot,
  );
  if (!frozen.success) unavailable();
  const officePolicy =
    frozen.data.schemaVersion === 2
      ? frozen.data.officeFirstDeliveryPolicy
      : undefined;
  const principal = {
    actor: { type: 'user' as const, id: root.owner_id },
    organizationId: task.scope.organizationId,
    workspaceId: task.scope.workspaceId,
  };
  await assertWorkbenchSession(tx, principal, root.session_id, true, 'share');
  const scope = {
    organizationId: principal.organizationId,
    workspaceId: principal.workspaceId,
    ownerId: root.owner_id,
    sessionId: root.session_id,
  };
  // Discover the tree from durable links, never an input list or all Session runs.
  const children =
    first.ownership === 'root_run'
      ? []
      : await tx<
          {
            run_id: string;
            parent_run_id: string | null;
            task: unknown;
            organization_id: string;
            workspace_id: string;
            owner_id: string;
          }[]
        >`select l.run_id,l.parent_run_id,l.task,r.organization_id,r.workspace_id,r.owner_id
    from allrice_runtime_run_links l join allrice_runs r on r.id=l.run_id
    where l.root_run_id=${task.rootRunId} and l.run_id<>${task.rootRunId}
    order by l.run_id limit 200 for share of l,r`;
  if (children.length >= 200) unavailable();
  const ownedRunIds = [task.rootRunId, ...children.map((row) => row.run_id)];
  if (new Set(ownedRunIds).size !== ownedRunIds.length) unavailable();
  const reachable = new Set([task.rootRunId]);
  for (const row of children) {
    const child = RuntimeTaskRefSchema.parse(row.task);
    if (
      child.runId !== row.run_id ||
      child.rootRunId !== task.rootRunId ||
      child.parentRunId !== row.parent_run_id ||
      child.chatSessionId !== root.session_id ||
      !runtimeContractEqual(child.scope, task.scope) ||
      row.organization_id !== scope.organizationId ||
      row.workspace_id !== scope.workspaceId ||
      row.owner_id !== scope.ownerId
    )
      unavailable();
  }
  for (let pass = 0; pass < children.length; pass++)
    for (const row of children)
      if (row.parent_run_id && reachable.has(row.parent_run_id))
        reachable.add(row.run_id);
  if (reachable.size !== ownedRunIds.length) unavailable();

  const rows: ArtifactRow[] = [];
  let before: { createdAt: string; id: string } | undefined;
  const seenVersions = new Set<string>();
  const seenObjects = new Set<string>();
  const push = (row: ArtifactRow) => {
    if (
      seenVersions.has(row.id) ||
      seenObjects.has(row.object_id) ||
      rows.length >= 1000
    )
      unavailable();
    seenVersions.add(row.id);
    seenObjects.add(row.object_id);
    rows.push(row);
  };
  // includeUnavailable prevents a deleted/expired current output disappearing
  // from a supposedly complete list; validation below fails the whole read.
  for (;;) {
    const page = await artifactRows(
      tx,
      scope,
      root.session_id,
      null,
      51,
      before,
      null,
      false,
      {
        ownedRunIds,
        includeUnavailable: true,
        businessOnly: true,
        lockObjects: true,
      },
    );
    if (page.length > 51) unavailable();
    const items = page.slice(0, 50);
    for (const row of items) {
      if (!row.origin_run_id || !ownedRunIds.includes(row.origin_run_id))
        unavailable();
      const cursor = WorkbenchCursorSchema.parse({
        createdAt: row.cursor_created_at,
        id: row.id,
      });
      if (
        before &&
        !(
          cursor.createdAt < before.createdAt ||
          (cursor.createdAt === before.createdAt && cursor.id < before.id)
        )
      )
        unavailable();
      push(row);
      before = cursor;
    }
    if (page.length <= 50) break;
    if (!items.length || rows.length >= 1000) unavailable();
  }
  for (const reference of references) {
    const existing = rows.find((row) => row.id === reference.versionId);
    const [row] = existing
      ? [existing]
      : await artifactRows(
          tx,
          scope,
          root.session_id,
          reference.versionId,
          1,
          undefined,
          null,
          false,
          { includeUnavailable: true, businessOnly: true, lockObjects: true },
        );
    if (
      !row ||
      row.object_id !== reference.objectId ||
      row.checksum !== reference.checksum
    )
      unavailable();
    if (!existing) push(row);
  }
  const artifacts = rows.map((row) => {
    const artifact = mapArtifact(row);
    if (
      artifact.provenance.runId !== row.origin_run_id ||
      artifact.object.organizationId !== scope.organizationId ||
      artifact.object.workspaceId !== scope.workspaceId ||
      artifact.object.ownerId !== scope.ownerId ||
      artifact.version.sessionId !== scope.sessionId
    )
      unavailable();
    return {
      objectId: artifact.object.id,
      versionId: artifact.version.id,
      checksum: artifact.object.checksum,
      scope,
      originRunId: row.origin_run_id,
      fileName: artifact.version.fileName,
      state: row.object_state as 'ready',
      immutable: artifact.object.immutable,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      retentionUntil: artifact.object.retentionUntil,
    };
  });
  const checks: WorkerDeliveryCheck[] = [];
  const qualityReceipts: {
    objectId: string;
    versionId: string;
    checksum: string;
    originRunId: string | null;
    auditId: string;
    receipt: OfficeDeliveryReceipt | null;
    producer?: OfficeExportProducer;
  }[] = [];
  const producers = new Map<
    string,
    { auditId: string; producer: OfficeExportProducer }
  >();
  const receiptsByVersion = new Map<string, (OfficeDeliveryReceipt | null)[]>();
  const audited = new Set<string>();
  const auditIds = new Set<string>();
  let auditBytes = 0;
  let auditBefore: { at: string; id: string } | undefined;
  const addChecks = (
    artifact: (typeof artifacts)[number],
    receipt: OfficeDeliveryReceipt | null,
  ) => {
    const quality = receipt?.quality;
    const checked = quality?.status === 'checked' ? quality : null;
    const saved = receipt?.savedValues;
    const counts =
      saved?.inspection === 'complete' ? saved.counts : saved?.observed;
    const observedFormulaError =
      (checked?.formulaErrorCount ?? 0) > 0 ||
      (counts?.errorCacheCount ?? 0) > 0;
    const savedValuesComplete =
      saved?.inspection === 'complete' &&
      saved.counts.missingCacheCount === 0 &&
      saved.counts.invalidCacheCount === 0 &&
      (!checked || checked.formulaCount === saved.counts.formulaCount);
    const statuses = {
      'office.rendered': checked ? 'passed' : 'unavailable',
      // A renderer's zero error count does not certify missing saved values.
      // Presence of cached values still proves neither freshness nor business correctness.
      'office.formula_errors': observedFormulaError
        ? 'failed'
        : !savedValuesComplete
          ? 'unavailable'
          : (counts?.formulaCount ?? 0) > 0
            ? 'passed'
            : 'not_checked',
      'office.saved_values':
        saved?.inspection !== 'complete'
          ? 'unavailable'
          : saved.counts.missingCacheCount > 0 ||
              saved.counts.invalidCacheCount > 0 ||
              saved.counts.errorCacheCount > 0
            ? 'failed'
            : saved.counts.formulaCount > 0
              ? 'passed'
              : 'not_checked',
      'office.visual': checked ? 'not_checked' : 'unavailable',
    } as const;
    for (const checkId of Object.keys(statuses) as (keyof typeof statuses)[])
      checks.push({
        objectId: artifact.objectId,
        versionId: artifact.versionId,
        checksum: artifact.checksum,
        scope,
        originRunId: artifact.originRunId,
        checkId,
        status: statuses[checkId],
      });
    if (checks.length > 10000) unavailable();
  };
  if (artifacts.length)
    for (;;) {
      const page = await tx<
        {
          id: string;
          resource_id: string;
          metadata: unknown;
          cursor_at: string;
          action: string;
        }[]
      >`
      select id,resource_id,metadata,action,to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
      from allrice_audit_events where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and actor_id=${scope.ownerId} and resource_type='deliverable_version'
        and resource_id=any(${artifacts.map((artifact) => artifact.versionId)}::uuid[])
        and decision='recorded' and ((action='artifact.office-quality' and reason='actual_exporter_receipt')
          or (${!!officePolicy} and action='artifact.published' and reason='immutable_version'))
        and (${auditBefore?.at ?? null}::text::timestamptz is null
          or (occurred_at,id)<(${auditBefore?.at ?? null}::text::timestamptz,${auditBefore?.id ?? null}::uuid))
      order by occurred_at desc,id desc limit 101`;
      if (page.length > 101) unavailable();
      const items = page.slice(0, 100);
      for (const row of items) {
        auditBytes += Buffer.byteLength(JSON.stringify(row.metadata), 'utf8');
        if (auditBytes > 4_000_000) unavailable();
        if (auditIds.has(row.id) || auditIds.size >= 10000) unavailable();
        if (
          auditBefore &&
          !(
            row.cursor_at < auditBefore.at ||
            (row.cursor_at === auditBefore.at && row.id < auditBefore.id)
          )
        )
          unavailable();
        UuidSchema.parse(row.id);
        auditIds.add(row.id);
        auditBefore = { at: row.cursor_at, id: row.id };
        const artifact = artifacts.find(
          (value) => value.versionId === row.resource_id,
        );
        if (!artifact) unavailable();
        const metadata = row.metadata as {
          objectId?: unknown;
          checksum?: unknown;
          runId?: unknown;
          receipt?: unknown;
        } | null;
        const outputRow = rows.find(
          (value) => value.id === artifact.versionId,
        )!;
        if (row.action === 'artifact.published') {
          const producer = readCanonicalOfficeExportProducer(row.metadata, {
            ...artifact,
            sessionId: scope.sessionId,
            kind: outputRow.kind,
            provenanceKind: mapArtifact(outputRow).provenance.kind,
            format: outputRow.format,
            mediaType: outputRow.media_type,
            publicationCallId: outputRow.publication_call_id,
          });
          if (producer) {
            if (producers.has(artifact.versionId)) unavailable();
            producers.set(artifact.versionId, { auditId: row.id, producer });
            qualityReceipts.push({
              objectId: artifact.objectId,
              versionId: artifact.versionId,
              checksum: artifact.checksum,
              originRunId: artifact.originRunId,
              auditId: row.id,
              receipt: null,
              producer,
            });
          }
          continue;
        }
        audited.add(artifact.versionId);
        const bound = readBoundOfficeDeliveryReceipt(metadata, {
          objectId: artifact.objectId,
          checksum: artifact.checksum,
          runId: artifact.originRunId,
          format: outputRow.format,
          mediaType: outputRow.media_type,
        });
        const receipt =
          bound &&
          (bound.quality.status !== 'checked' ||
            bound.quality.format === outputRow.format)
            ? bound
            : null;
        qualityReceipts.push({
          objectId: artifact.objectId,
          versionId: artifact.versionId,
          checksum: artifact.checksum,
          originRunId: artifact.originRunId,
          auditId: row.id,
          receipt,
        });
        addChecks(artifact, receipt);
        const receipts = receiptsByVersion.get(artifact.versionId) ?? [];
        receipts.push(receipt);
        receiptsByVersion.set(artifact.versionId, receipts);
      }
      if (page.length <= 100) break;
      if (!items.length) unavailable();
    }
  for (const artifact of artifacts)
    if (!audited.has(artifact.versionId)) addChecks(artifact, null);
  const last = await assertCurrent(tx);
  if (!runtimeContractEqual(first, last)) unavailable();
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime()))
    unavailable();
  for (const row of rows)
    if (
      row.object_state !== 'ready' ||
      !row.immutable ||
      row.deleted_at ||
      (row.retention_until && row.retention_until <= clock.now)
    )
      unavailable();
  return {
    scope: { ...scope, runId: task.rootRunId },
    complete: true as const,
    authorization: 'current' as const,
    now: clock.now.toISOString(),
    ownedRunIds,
    explicitReferenceVersionIds: references.map(
      (reference) => reference.versionId,
    ),
    artifacts,
    checks,
    qualityReceipts,
    requirements: officePolicy
      ? buildOfficeFirstDeliveryRequirements(
          rows.map((row) => ({
            objectId: row.object_id,
            versionId: row.id,
            checksum: row.checksum,
            seriesId: row.series_id,
            version: row.version,
            latestVersionId: row.latest_version_id,
            originRunId: row.origin_run_id,
            kind: row.kind,
            provenanceKind: mapArtifact(row).provenance.kind,
            format: row.format,
            mediaType: row.media_type,
            publicationCallId: row.publication_call_id,
            producerAuditId: producers.get(row.id)?.auditId ?? null,
            receipts: receiptsByVersion.get(row.id) ?? [],
          })),
          ownedRunIds,
        )
      : [],
  };
}

export async function listWorkbenchArtifacts(
  context: WorkbenchPrincipal,
  sessionId: string,
  before?: { createdAt: string; id: string },
  db: Database = getDatabase(),
) {
  if (before) WorkbenchCursorSchema.parse(before);
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId, false, false);
    const rows = await artifactRows(
      tx,
      {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId!,
        ownerId: context.actor.id,
      },
      sessionId,
      null,
      51,
      before,
      null,
      false,
    );
    const pageRows = rows.slice(0, 50),
      last = pageRows.at(-1);
    return {
      artifacts: pageRows.map(mapArtifact),
      nextCursor:
        rows.length > 50 && last
          ? { createdAt: last.cursor_created_at, id: last.id }
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
  const [row] = await artifactRows(
    db,
    {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId!,
      ownerId: context.actor.id,
    },
    sessionId,
    id,
    1,
  );
  if (!row) fail('artifact_not_found');
  const artifact = mapArtifact(row);
  const fileAccess = await workbenchFileAccess(context, artifact.object.id, db);
  if (fileAccess && !fileAccess.canRead) fail('artifact_not_found');
  return artifact;
}
export async function getWorkbenchArtifact(
  context: WorkbenchPrincipal,
  sessionId: string,
  id: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId, false, false);
    return readArtifact(tx, context, sessionId, id);
  });
}
/** Platform inspection only. The issuer remains the real administrator; this
 * explicit subject scope cannot be passed to publishing, feedback or execution. */
export async function inspectTenantRunArtifacts(
  issuer: RequestContext,
  target: TenantManagementTarget,
  runInput: string,
  artifactInput: string | null = null,
  db: Database = getDatabase(),
) {
  const runId = UuidSchema.parse(runInput),
    artifactId =
      artifactInput === null ? null : UuidSchema.parse(artifactInput);
  return db.begin(async (tx) => {
    await requireTenantInspectionScope(issuer, target, tx);
    const [run] = await tx<
      { session_id: string }[]
    >`select e.session_id from allrice_employee_runs e
      join allrice_chat_sessions s on s.id=e.session_id and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id and s.owner_id=e.owner_id
      where e.run_id=${runId} and e.organization_id=${target.organizationId} and e.workspace_id=${target.workspaceId} and e.owner_id=${target.subjectId}`;
    if (!run) fail('artifact_not_found');
    const rows = await artifactRows(
      tx,
      {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        ownerId: target.subjectId,
      },
      run.session_id,
      artifactId,
      51,
      undefined,
      runId,
    );
    if (artifactId && !rows.length) fail('artifact_not_found');
    if (artifactId)
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${target.organizationId},${target.workspaceId},${issuer.actor.id},'tenant.artifact.access_checked','artifact',${artifactId},'recorded','read_only_preview_authorization',${tx.json({ subjectId: target.subjectId, runId, readOnly: true })})`;
    return {
      artifacts: rows.slice(0, 50).map(mapArtifact),
      truncated: rows.length > 50,
    };
  });
}
/** Company file inspection keeps the issuer's own identity. Unlike Run-specific
 * inspection, legacy files may have no recorded originating Run. */
export async function inspectCompanyDeliverable(
  issuer: RequestContext,
  organizationInput: string,
  artifactInput: string,
  db: Database = getDatabase(),
) {
  const organizationId = UuidSchema.parse(organizationInput),
    artifactId = UuidSchema.parse(artifactInput);
  return db.begin(async (tx) => {
    await requireTenantAdministrationAuthority(issuer, tx);
    await requireTenantAdministrationTarget(tx, organizationId, null);
    const [row] = await tx<
      { workspace_id: string; owner_id: string; session_id: string }[]
    >`
      select dv.workspace_id,dv.owner_id,dv.session_id from allrice_deliverable_versions dv
      left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
      where dv.id=${artifactId} and dv.organization_id=${organizationId} and dv.session_id is not null and dv.platform_test_run_id is null
        and exists(select 1 from allrice_employee_runs er where er.organization_id=dv.organization_id and er.workspace_id=dv.workspace_id and er.owner_id=dv.owner_id and er.session_id=dv.session_id
          and (a.run_id is null or a.run_id=er.run_id) and not exists(select 1 from allrice_assistant_instances ai where ai.run_id=er.run_id and ai.run_id<>ai.root_run_id))
        and ${businessDeliverablePredicate(tx)}`;
    if (!row) fail('artifact_not_found');
    await requireTenantInspectionScope(
      issuer,
      {
        organizationId,
        workspaceId: row.workspace_id,
        subjectId: row.owner_id,
      },
      tx,
    );
    const [artifactRow] = await artifactRows(
      tx,
      { organizationId, workspaceId: row.workspace_id, ownerId: row.owner_id },
      row.session_id,
      artifactId,
      1,
    );
    if (!artifactRow) fail('artifact_not_found');
    const artifact = mapArtifact(artifactRow);
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${row.workspace_id},${issuer.actor.id},'company.deliverable.inspected','artifact',${artifactId},'recorded','read_only_company_delivery',${tx.json({ subjectId: row.owner_id, sessionId: row.session_id, readOnly: true })})`;
    const sourceRows =
      await tx`select action,metadata from allrice_audit_events where organization_id=${organizationId} and workspace_id=${row.workspace_id}
      and actor_id=${row.owner_id} and resource_type='deliverable_version' and resource_id=${artifactId} and action in ('artifact.source','artifact.office-quality') order by occurred_at desc,id desc limit 10`;
    const source = ArtifactSourceFileSchema.safeParse(
      sourceRows.find((r) => r.action === 'artifact.source')?.metadata
        ?.sourceFile,
    );
    const receiptRow = sourceRows.find(
      (r) =>
        r.action === 'artifact.office-quality' &&
        r.metadata?.objectId === artifact.object.id &&
        r.metadata?.checksum === artifact.object.checksum,
    );
    const output = {
      objectId: artifact.object.id,
      checksum: artifact.object.checksum,
      mediaType: artifact.object.mediaType,
      format: artifact.version.format,
      runId: artifact.provenance.runId,
    };
    const office =
      artifact.provenance.kind === 'legacy_deliverable' && !output.runId
        ? (() => {
            // Read-only historical display already binds the owner, version,
            // object and checksum above. Preserve its original receipt without
            // inventing a Run. This is never final-delivery authority evidence.
            try {
              return parseOfficeDeliveryReceiptForObject(
                receiptRow?.metadata?.receipt,
                output,
              );
            } catch {
              return null;
            }
          })()
        : readBoundOfficeDeliveryReceipt(receiptRow?.metadata, output);
    // This is the exporter source fact for this exact output, not a claim
    // inferred from task text or a later version of the company directory.
    const [companyTemplate] = await tx`
      select ra.asset_id as "assetId",ra.revision_id as "revisionId",
        ra.digest,r.content->>'title' as title,r.number as revision,
        r.file_metadata->>'checksum' as "sourceChecksum"
      from allrice_company_asset_derivations d
      join allrice_company_run_assets ra on ra.run_id=d.run_id and ra.asset_id=d.asset_id
      join allrice_company_asset_revisions r on r.id=ra.revision_id and r.asset_id=ra.asset_id
      where d.deliverable_version_id=${artifactId} and ra.organization_id=${organizationId}
        and ra.workspace_id=${row.workspace_id} and ra.owner_id=${row.owner_id}
        and ra.kind='template' and ra.material_object_id=${source.success ? source.data.objectId : null}
        and r.file_metadata->>'checksum'=${source.success ? source.data.checksum : null}
      order by d.created_at,d.asset_id limit 1
    `;
    return {
      ...artifact,
      companyEvidence: {
        objectId: artifact.object.id,
        checksum: artifact.object.checksum,
        sourceFile: source.success ? source.data : null,
        ...(companyTemplate ? { companyTemplate } : {}),
        office,
      },
    };
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
  assignedCopy = false,
) {
  const changeset = parseChangesetBytes(bytes),
    e = changeset.execution;
  // P06/P08 first execution target is one existing Bridge grant, not a cloud migration authorization.
  if (
    e.targetKind !== 'rice_bridge' ||
    !e.deviceId ||
    !e.grantId ||
    (!(assignedCopy && e.workCopy.kind === 'local_copy') &&
      (e.workCopy.kind !== 'in_place' || e.workCopy.id !== e.grantId))
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
export async function assertPublishingRun(
  tx: TransactionSql,
  context: ExecutionContext,
  sessionId: string,
  requiredTool = 'workspace.export.create',
  lock = true,
) {
  const [row] = await tx<
    { execution_snapshot: unknown }[]
  >`select e.execution_snapshot from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    join allrice_jobs j on j.id=${context.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    where r.id=${context.runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId!} and r.owner_id=${context.policySnapshot.subjectId}
      and r.policy_snapshot_id=${context.policySnapshot.id} and e.session_id=${sessionId} and r.state='running'
      and j.status='running' and j.worker_id=${context.worker.id} and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      ${lock ? tx`for share of e,r,j` : tx``}`;
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
    (['workspace.project', 'browser.workspace'].includes(requiredTool) &&
      !parsed.data.capabilitySnapshot.grantedCapabilities.includes(
        'storage:read',
      )) ||
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

async function assertOfficePdfLease(
  tx: TransactionSql,
  context: ExecutionContext,
  lease: { jobAttempt: number; jobLeaseToken: string },
) {
  if (
    !Number.isSafeInteger(lease.jobAttempt) ||
    lease.jobAttempt < 0 ||
    !UuidSchema.safeParse(lease.jobLeaseToken).success
  )
    fail('run_unavailable');
  const [current] = await tx`select id from allrice_jobs
    where id=${context.jobId} and run_id=${context.runId}
      and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}
      and owner_id=${context.policySnapshot.subjectId} and worker_id=${context.worker.id}
      and attempt=${lease.jobAttempt} and lease_token=${lease.jobLeaseToken}
      and status='running' and cancel_requested_at is null
      and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp()
    for update`;
  if (!current) fail('run_unavailable');
}

/** Publish a reviewable proposal, never enqueue a file write or create approval.
 * The model cannot supply a device, grant, scope digest, checksum or authority.
 * Before-text is an untrusted proposal baseline; application still checks its
 * exact SHA against actual files and requires the existing single-use approval. */
export async function publishWorkbenchChangesetProposal(
  input: {
    context: ExecutionContext;
    sessionId: string;
    callId: string;
    fileName: string;
    proposal: unknown;
    parentObjectId?: string;
    changeSummary?: string;
  },
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  if (
    !workbenchEnabled() ||
    !runtimeFeatureEnabled('ALLRICE_CHANGESET_ENABLED')
  )
    fail('feature_disabled');
  const ctx = ExecutionContextSchema.parse(input.context);
  const proposal = ChangesetProposalSchema.parse(input.proposal);
  const [target] = await db<
    {
      target_id: string;
      device_id: string;
      grant_id: string;
      runtime_generation: number;
      root_fingerprint: string;
    }[]
  >`select t.id target_id,d.id device_id,g.id grant_id,g.runtime_generation,g.root_fingerprint
    from allrice_execution_targets t
    join allrice_bridge_devices d on t.target_key='bridge.'||d.id::text
      and d.organization_id=t.organization_id and d.workspace_id=t.workspace_id
    join allrice_bridge_folder_grants g on g.device_id=d.id
      and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
    where t.organization_id=${ctx.organizationId} and t.workspace_id=${ctx.workspaceId!}
      and t.kind='rice_bridge' and t.state='online' and d.owner_id=${ctx.policySnapshot.subjectId}
      and d.revoked_at is null and g.revoked_at is null
      and d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp()
      and (${!('operations' in proposal)} or t.metadata->'environment'->>'fileOrganizationVersion'='1')
    order by g.created_at desc,g.id limit 1`;
  if (!target) fail('target_unavailable');
  const side = (text: string | null) =>
    text === null ? null : { text, checksum: hash(text) };
  const changeset = ChangesetDocumentSchema.parse({
    contractVersion: 1,
    comparisonScope:
      'operations' in proposal ? 'file_organization' : 'changeset',
    execution: {
      targetId: target.target_id,
      targetKind: 'rice_bridge',
      deviceId: target.device_id,
      grantId: target.grant_id,
      grantVersion: target.runtime_generation,
      scopeDigest: `sha256:${target.root_fingerprint}`,
      workCopy: { id: target.grant_id, kind: 'in_place' },
    },
    files:
      'operations' in proposal
        ? proposal.operations.map((f) => ({
            path: f.path,
            before: null,
            after: null,
            organization: f,
          }))
        : proposal.files.map((f) => ({
            path: f.path,
            before: side(f.before),
            after: side(f.after),
          })),
  });
  const bytes = Buffer.from(JSON.stringify(changeset), 'utf8');
  parseChangesetBytes(bytes);
  return publishWorkbenchArtifact(
    {
      context: ctx,
      sessionId: input.sessionId,
      callId: input.callId,
      fileName: input.fileName,
      kind: 'changeset',
      format: 'json',
      mediaType: 'application/json',
      bytes,
      ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
      ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
    },
    storage,
    db,
  );
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
    sourceFile?: ArtifactSourceFile;
    officeReceipt?: OfficeDeliveryReceipt;
    /** Server publisher identity, never an export/model argument or quality verdict. */
    trustedOfficeExport?: true;
    changeSummary?: string;
    /** Server-only provider receipt and exact worker lease, never model arguments. */
    trustedImageOperation?: { id: string; leaseToken: string };
    /** Server-only originating converter lease; never parsed from tool args. */
    trustedOfficePdfLease?: { jobAttempt: number; jobLeaseToken: string };
    /** Server-only deterministic renderer input; never accepted by generic export HTTP/tool arguments. */
    trustedCloudDerivation?: {
      sourceArtifactId: string;
      renderer: 'reconciliation-xlsx-v1';
    };
  },
  storage: StoragePort,
  db: Database = getDatabase(),
  /** Internal composition only, NEVER parsed from export/model arguments.
   * Admission takes root locks before the session lock and validates the exact
   * assignment/version each time. Storage still uses the real root job. */
  development?: {
    requiredTool?:
      | 'workspace.export.create'
      | 'assistant.development'
      | 'workspace.project'
      | 'browser.workspace'
      | 'workspace.brand_content.step';
    /** Server-only finite saved-document verification result. */
    browserVerification?: { execution: RuntimeExecutionScope };
    /** Server-only private QA browser capture. Its managed task must already
     * have durable evidence and the caller supplies the current QA lease guard. */
    qualityLiveCapture?: { browserTaskId: string };
    /** Internal verified project output/source delivery, never model input. */
    projectDelivery?: {
      operationId: string | null;
      execution: RuntimeExecutionScope | null;
    };
    runId: string;
    admit: (tx: TransactionSql) => Promise<void>;
    registered?: (tx: TransactionSql, artifactId: string) => Promise<void>;
    /** Reconcile a business receipt in the cached artifact's transaction. */
    replayed?: (tx: TransactionSql, artifactId: string) => Promise<void>;
  },
) {
  if (!workbenchEnabled()) fail('feature_disabled');
  if (
    Object.hasOwn(input, 'trustedOfficeExport') &&
    (input.trustedOfficeExport !== true ||
      development ||
      input.kind !== 'document' ||
      !Object.hasOwn(officeMediaTypes, input.format) ||
      officeMediaTypes[input.format as keyof typeof officeMediaTypes] !==
        input.mediaType)
  )
    fail('invalid_publication');
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
  if (
    input.sourceFile &&
    (input.kind !== 'document' || input.trustedCloudDerivation)
  )
    fail('invalid_publication');
  if (
    development?.requiredTool === 'workspace.project' &&
    !development.projectDelivery &&
    (input.kind !== 'document' ||
      input.format !== 'json' ||
      input.mediaType !== 'application/json')
  )
    fail('invalid_publication');
  if (
    development?.projectDelivery &&
    (development.requiredTool !== 'workspace.project' ||
      input.kind !== 'document' ||
      !['zip', 'json', 'text', 'html'].includes(input.format))
  )
    fail('invalid_publication');
  if (
    input.trustedOfficePdfLease &&
    (input.kind !== 'document' ||
      input.format !== 'pdf' ||
      input.mediaType !== 'application/pdf' ||
      !input.sourceFile)
  )
    fail('invalid_publication');
  const principal: WorkbenchPrincipal = {
    actor: { type: 'user', id: owner },
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
  };
  const checksum = hash(input.bytes),
    officeReceipt = input.officeReceipt
      ? parseOfficeDeliveryReceiptForObject(input.officeReceipt, {
          format: input.format,
          checksum,
          mediaType: input.mediaType,
        })
      : undefined,
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
      ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
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
      // Same order as assistant admission/clock maintenance: root before job
      // and session. Holding session first can deadlock with an assistant check
      // which refreshes the job deadline before SHARE-locking the session.
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${context.runId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} for update`;
      if (input.trustedOfficePdfLease)
        await assertOfficePdfLease(tx, context, input.trustedOfficePdfLease);
      await development?.admit(tx);
      if (development?.qualityLiveCapture) {
        if (
          development.requiredTool !== 'browser.workspace' ||
          input.kind !== 'document' ||
          !['json', 'png'].includes(input.format)
        )
          fail('invalid_publication');
        const [capture] =
          await tx`select o.id from allrice_managed_browser_tasks t
          join allrice_managed_browser_evidence_artifacts a on a.task_id=t.id
          join allrice_storage_objects o on o.id=a.object_id and o.state='ready' and o.deleted_at is null
          where t.id=${development.qualityLiveCapture.browserTaskId} and t.run_id=${context.runId}
            and t.job_id=${context.jobId} and t.organization_id=${context.organizationId} and t.workspace_id=${context.workspaceId!}
            and t.status='succeeded' and o.owner_id=${owner} and o.checksum=${checksum} and o.size_bytes=${input.bytes.byteLength}`;
        if (!capture) fail('invalid_publication');
      }
      await assertWorkbenchSession(tx, principal, input.sessionId, true);
      // Parent liveness/kind also apply to cached receipts. Staleness caused
      // by this call's own child is handled by the new-publication check below.
      const projectParent =
        development?.requiredTool === 'workspace.project' &&
        development.projectDelivery &&
        input.parentObjectId
          ? await assertProjectOutputParent(
              {
                context,
                sessionId: input.sessionId,
                parentObjectId: input.parentObjectId,
                format: input.format,
              },
              tx,
              true,
            )
          : null;
      const source = input.sourceFile
        ? await assertToolBrokerSourceFile(
            tx,
            context,
            input.sourceFile,
            input.sessionId,
            input.parentObjectId,
            input.format,
          )
        : undefined;
      if (
        source &&
        !source.derivation &&
        input.parentObjectId &&
        input.parentObjectId !== source.parentObjectId
      )
        fail('version_changed');
      const parentObjectId = source?.companyTemplate
        ? undefined
        : (source?.parentObjectId ?? input.parentObjectId);
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
      const publishingRunId = development?.runId ?? context.runId;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`artifact:${publishingRunId}:${input.callId}`},0))`;
      const [existing] = await tx<
        { version_id: string; request_digest: string }[]
      >`select version_id,request_digest from allrice_workbench_artifacts
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and run_id=${publishingRunId} and request_id=${input.callId}`;
      if (existing) {
        if (existing.request_digest !== requestDigest)
          fail('idempotency_conflict');
        const cached = await readArtifact(
          tx,
          principal,
          input.sessionId,
          existing.version_id,
        );
        await development?.replayed?.(tx, cached.id);
        await development?.admit(tx);
        if (!input.officeReceipt) return cached;
        const [recorded] = await tx`select metadata from allrice_audit_events
          where organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}
            and actor_id=${owner} and action='artifact.office-quality'
            and resource_type='deliverable_version' and resource_id=${cached.id}
            and metadata->>'objectId'=${cached.object.id}
            and metadata->>'checksum'=${cached.object.checksum}
            and metadata->>'runId'=${publishingRunId}
          order by occurred_at desc,id desc limit 1`;
        return {
          ...cached,
          officeReceiptReplayed: true,
          officeReceipt: readBoundOfficeDeliveryReceipt(recorded?.metadata, {
            objectId: cached.object.id,
            checksum: cached.object.checksum,
            mediaType: cached.object.mediaType,
            format: cached.version.format,
            runId: publishingRunId,
          }),
        };
      }
      if (projectParent && input.parentObjectId)
        await assertProjectOutputParent(
          {
            context,
            sessionId: input.sessionId,
            parentObjectId: input.parentObjectId,
            format: input.format,
          },
          tx,
          true,
          true,
        );
      const requiredTool = development
        ? (development.requiredTool ?? 'assistant.development')
        : derivedSource
          ? 'workspace.reconciliation.export'
          : 'workspace.export.create';
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      if (input.trustedImageOperation) {
        if (
          input.format !== 'png' ||
          input.mediaType !== 'image/png' ||
          input.kind !== 'document'
        )
          fail('invalid_publication');
        const [image] = await tx`select i.id from allrice_image_operations i
          join allrice_jobs j on j.id=${context.jobId} and j.run_id=i.run_id
          where i.id=${input.trustedImageOperation.id} and i.run_id=${context.runId}
            and i.organization_id=${context.organizationId} and i.workspace_id=${context.workspaceId!}
            and i.session_id=${input.sessionId} and i.owner_id=${owner} and i.status='running'
            and i.source_object_id is not distinct from ${input.sourceFile?.objectId ?? null}::uuid
            and i.source_checksum is not distinct from ${input.sourceFile?.checksum ?? null}::text
            and j.worker_id=${context.worker.id} and j.lease_token::text=${input.trustedImageOperation.leaseToken}
            for share of i,j`;
        if (!image) fail('run_unavailable');
      }

      if (derivedSource)
        await assertCloudDerivationLease(
          tx,
          context,
          derivedSource.provenance.operationId!,
        );
      let parent: WorkbenchArtifact | null = null;
      let publicationKind: WorkbenchArtifact['kind'] =
        projectParent?.kind ?? input.kind;
      if (parentObjectId) {
        const [p] = await tx<
          { id: string }[]
        >`select id from allrice_deliverable_versions where object_id=${UuidSchema.parse(parentObjectId)} and session_id=${input.sessionId}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!} and owner_id=${owner}`;
        if (!p)
          throw new ArtifactPublicationParentError(
            context.runId,
            input.callId,
            'artifact_not_found',
          );
        parent = await readArtifact(tx, principal, input.sessionId, p.id);
        // Python/Bridge/project results are `file` artifacts. A content export may
        // revise their JSON/text/Markdown/HTML without changing the series' kind or claiming
        // a new execution receipt. Binary files and action proposals stay strict.
        if (
          input.kind === 'document' &&
          parent.kind === 'file' &&
          ['json', 'text', 'markdown', 'html'].includes(input.format)
        )
          publicationKind = 'file';
        if (
          parent.stale ||
          parent.kind !== publicationKind ||
          parent.version.format !== input.format
        )
          throw new ArtifactPublicationParentError(
            context.runId,
            input.callId,
            'version_changed',
          );
      }
      const execution =
        input.kind === 'changeset'
          ? await assertArtifactExecution(
              tx,
              context,
              input.bytes,
              !!development,
            )
          : (development?.projectDelivery?.execution ??
            development?.browserVerification?.execution ??
            derivedSource?.execution ??
            null);
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
          ...(officeReceipt ? { officeReceipt } : {}),
          ...(source ? { sourceFile: source.source } : {}),
          ...(parentObjectId ? { parentObjectId } : {}),
          ...(input.changeSummary
            ? { changeSummary: input.changeSummary }
            : {}),
        },
        tx,
      );
      const provenance = {
        kind:
          development?.projectDelivery ||
          development?.browserVerification ||
          development?.qualityLiveCapture
            ? 'tool_result'
            : requiredTool === 'workspace.project'
              ? 'project_snapshot'
              : derivedSource ||
                  input.trustedImageOperation ||
                  input.trustedOfficePdfLease
                ? 'tool_result'
                : 'model_proposal',
        runId: publishingRunId,
        operationId:
          development?.projectDelivery?.operationId ??
          derivedSource?.provenance.operationId ??
          null,
        stepId: null,
      };
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)
      values(${version.id},${context.organizationId},${context.workspaceId!},${owner},${publishingRunId},${publicationKind},${tx.json(provenance)},${execution ? tx.json(execution) : null},${input.callId},${requestDigest})`;
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${context.organizationId},${context.workspaceId!},${owner},'artifact.published','deliverable_version',${version.id},'recorded','immutable_version',${tx.json({ runId: context.runId, sessionId: input.sessionId, checksum, kind: publicationKind, ...(input.trustedOfficeExport ? { officeExport: OfficeExportProducerSchema.parse({ version: 1, tool: 'workspace.export.create', callId: input.callId, objectId: created.id }) } : {}), ...(input.trustedCloudDerivation ? { derivation: input.trustedCloudDerivation, sourceChecksum: derivedSource!.object.checksum } : {}) })})`;
      const artifact = await readArtifact(
        tx,
        principal,
        input.sessionId,
        version.id,
      );
      // Audit insertion and projection reads may block. Recheck the authoritative
      // deadline after those waits, immediately before committing the new version.
      if (input.trustedOfficePdfLease)
        await assertOfficePdfLease(tx, context, input.trustedOfficePdfLease);
      if (derivedSource)
        await assertCloudDerivationLease(
          tx,
          context,
          derivedSource.provenance.operationId!,
        );
      await assertPublishingRun(tx, context, input.sessionId, requiredTool);
      await development?.admit(tx);
      if (projectParent && input.parentObjectId)
        await assertProjectOutputParent(
          {
            context,
            sessionId: input.sessionId,
            parentObjectId: input.parentObjectId,
            format: input.format,
          },
          tx,
          true,
        );
      await development?.registered?.(tx, artifact.id);
      if (development?.registered) await development.admit(tx);
      return officeReceipt
        ? { ...artifact, officeReceipt, officeReceiptReplayed: false }
        : artifact;
    });
  } catch (error) {
    let cleanupConfirmed = !created;
    if (created) {
      // A lost commit acknowledgement is ambiguous. Query the same primary before
      // cleanup; if unavailable, retain the bounded orphan, never delete evidence.
      const known = await db<
        { id: string }[]
      >`select id from allrice_storage_objects where id=${created.id}`.catch(
        () => null,
      );
      if (known && known.length === 0) {
        try {
          await storage.delete({ ...created, immutable: false });
          cleanupConfirmed = true;
        } catch {
          /* Preserve an unconfirmed private blob for reconciliation. */
        }
      }
    }
    const sqlState =
      error instanceof Error
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    if (cleanupConfirmed && (sqlState === '40P01' || sqlState === '40001')) {
      recordTransactionRetry({
        site: 'artifact_publication',
        sqlState,
        attempt: 1,
        outcome: 'rollback_receipt',
      });
      throw new ArtifactPublicationRollbackError(
        context.runId,
        input.callId,
        sqlState,
        error,
      );
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
    await assertWorkbenchSession(tx, context, sessionId, false, false);
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
