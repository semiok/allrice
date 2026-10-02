import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  BridgeDeviceSchema,
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionChoiceSchema,
  ExecutionLocationSchema,
  ExecutionContextSchema,
  PolicySnapshotSchema,
  PlatformEmployeeDefinitionSchema,
  RuntimeActionBindingSchema,
  RuntimeLocalPdfPayloadSchema,
  RuntimeLocalPdfProfileSchema,
  RuntimeLocalPdfSourceSchema,
  RuntimeOperationSnapshotSchema,
  UuidSchema,
  WorkspaceDocumentReadArgsSchema,
  localPdfProfileMatchesRelease,
  pdfReadReleaseForPlatform,
  resolveExecutionChoice,
  runtimeContractEqual,
  authorizeExecution,
  type BridgeDevice,
  type ExecutionChoice,
  type ExecutionContext,
  type ExecutionLocation,
  type RequestContext,
  type RuntimeActionBinding,
  type RuntimeLocalPdfPayload,
  type RuntimeLocalPdfSource,
  type Visibility,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { cloudStableId } from './cloud-execution.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import { RuntimeLedgerError } from './runtime-ledger/types.ts';
import {
  localOperationsFeatureEnabled,
  waitLocalCommandOperation,
} from './local-command-service.ts';
import { linkTaskOperationCall } from './task-clock.ts';
import { bridgeDeviceStatus, BridgeDataError } from './bridge.ts';
import { DataAccessError, getStoredFile } from './data.ts';

export function localPdfRuntimeFingerprint(deviceId: string) {
  return createHash('sha256')
    .update(`allrice-readonly-pdf-v1:${UuidSchema.parse(deviceId)}`)
    .digest('hex');
}

export async function readLocalPdfRuntimeGrant(
  device: BridgeDevice,
  db = getDatabase(),
) {
  const [row] = await db<
    {
      id: string;
      root_fingerprint: string;
      runtime_generation: number;
      revoked_at: Date | null;
    }[]
  >`select id,root_fingerprint,runtime_generation,revoked_at from allrice_bridge_pdf_runtime_grants
    where device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and profile_version=1`;
  return row
    ? {
        id: row.id,
        deviceId: device.id,
        rootFingerprint: row.root_fingerprint,
        runtimeGeneration: row.runtime_generation,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        profileVersion: 1 as const,
      }
    : null;
}

/** An observed fixed-reader probe authorizes no folder, Python or write action. */
export async function reportLocalPdfProfile(
  device: BridgeDevice,
  value: unknown,
  db = getDatabase(),
) {
  if (!localOperationsFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const profile = RuntimeLocalPdfProfileSchema.parse(value),
    release = pdfReadReleaseForPlatform(device.platform);
  if (
    !release ||
    !localPdfProfileMatchesRelease(profile, release) ||
    device.revokedAt
  )
    throw new RuntimePolicyError('target_unavailable');
  await db.begin(async (tx) => {
    const [current] =
      await tx`select id from allrice_bridge_devices where id=${device.id} and organization_id=${device.organizationId}
      and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and platform=${profile.platform}
      and protocol_version=2 and capabilities @> array['local.pdf.read']::text[] and revoked_at is null for share`;
    if (!current) throw new RuntimePolicyError('target_unavailable');
    await tx`insert into allrice_bridge_pdf_profiles(device_id,organization_id,workspace_id,profile)
      values(${device.id},${device.organizationId},${device.workspaceId},${tx.json(profile)})
      on conflict(device_id) do update set profile=excluded.profile,reported_at=clock_timestamp()
      where allrice_bridge_pdf_profiles.organization_id=excluded.organization_id and allrice_bridge_pdf_profiles.workspace_id=excluded.workspace_id`;
    if (profile.available && profile.stopConfirmed)
      await tx`insert into allrice_bridge_pdf_runtime_grants(id,device_id,organization_id,workspace_id,owner_id,profile_version,root_fingerprint)
        values(${cloudStableId(`readonly-pdf-grant:${device.id}`)},${device.id},${device.organizationId},${device.workspaceId},${device.ownerId},1,${localPdfRuntimeFingerprint(device.id)})
        on conflict(device_id) do update set revoked_at=null,
          runtime_generation=allrice_bridge_pdf_runtime_grants.runtime_generation+case when allrice_bridge_pdf_runtime_grants.revoked_at is null then 0 else 1 end
        where allrice_bridge_pdf_runtime_grants.organization_id=excluded.organization_id and allrice_bridge_pdf_runtime_grants.workspace_id=excluded.workspace_id
          and allrice_bridge_pdf_runtime_grants.owner_id=excluded.owner_id and allrice_bridge_pdf_runtime_grants.root_fingerprint=excluded.root_fingerprint`;
  });
  return profile;
}

function frozenPdf(value: unknown) {
  const parsed = EmployeeExecutionSnapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.schemaVersion !== 2 ||
    parsed.data.employee.definition.schemaVersion !== 2
  )
    return null;
  const f = parsed.data,
    definition = parsed.data.employee.definition,
    b = f.capabilitySnapshot.bindings.managedPdf;
  if (
    !b ||
    b.contractVersion !== 1 ||
    b.profileVersion !== 1 ||
    !f.capabilitySnapshot.bindings.toolNames.includes(
      'workspace.document.read',
    ) ||
    !f.capabilitySnapshot.grantedCapabilities.includes('storage:read') ||
    definition.securityPolicy.deniedCapabilities.includes('storage:read')
  )
    return null;
  return f;
}

/** Lock and resolve the same authorized object/version, never a model-provided filename. */
async function assertPdfSource(
  tx: TransactionSql,
  scope: { organizationId: string; workspaceId: string; ownerId: string },
  source: RuntimeLocalPdfSource,
  context?: ExecutionContext,
) {
  const { getCompanyMaterialForExecution } =
    await import('./company-run-assets.ts');
  const company = context
    ? await getCompanyMaterialForExecution(context, source.objectId, tx)
    : null;
  if (company) {
    if (
      company.object.mediaType !== 'application/pdf' ||
      company.object.mediaType !== source.mediaType ||
      company.object.checksum !== source.checksum ||
      company.object.sizeBytes !== source.sizeBytes ||
      source.artifactVersionId !== undefined ||
      source.artifactVersion !== undefined
    )
      throw new RuntimePolicyError('bridge_authority_changed');
    return company.fileName;
  }
  const [object] = await tx<
    {
      checksum: string;
      size_bytes: number | string;
      media_type: string;
      file_name: string;
      artifact_version_id: string | null;
      artifact_version: number | null;
      id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      visibility: Visibility;
    }[]
  >`select o.id,o.organization_id,o.workspace_id,o.owner_id,o.visibility,o.checksum,o.size_bytes,o.media_type,
      coalesce(v.file_name,(select max(f.file_name) from allrice_file_references f where f.object_id=o.id),'未命名文件') as file_name,
      v.id as artifact_version_id,v.version as artifact_version
    from allrice_storage_objects o left join lateral (
      select id,version,file_name from allrice_deliverable_versions where object_id=o.id and organization_id=o.organization_id
        and workspace_id=o.workspace_id order by version desc limit 1
    ) v on true
    where o.id=${source.objectId} and o.organization_id=${scope.organizationId} and o.workspace_id=${scope.workspaceId}
      and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
      and (o.owner_id=${scope.ownerId} or o.visibility<>'private') for share of o`;
  if (
    !object ||
    (object.media_type !== 'application/pdf' &&
      !/\.pdf$/i.test(object.file_name)) ||
    object.media_type !== source.mediaType ||
    object.checksum !== source.checksum ||
    Number(object.size_bytes) !== source.sizeBytes ||
    (object.artifact_version_id ?? undefined) !== source.artifactVersionId ||
    (object.artifact_version ?? undefined) !== source.artifactVersion
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  if (
    context &&
    !authorizeExecution(
      {
        type: 'storage_object',
        id: object.id,
        organizationId: object.organization_id,
        workspaceId: object.workspace_id,
        ownerId: object.owner_id,
        visibility: object.visibility,
        archivedAt: null,
      },
      'resource:read',
      context,
    ).allowed
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  return object.file_name;
}

export interface LocalPdfSelectionInput {
  context: ExecutionContext;
  callId: string;
  toolName: 'workspace.document.read';
  arguments: Record<string, unknown>;
  source: RuntimeLocalPdfSource;
  location?: ExecutionLocation;
  jobAttempt: number;
  jobLeaseToken: string;
}

/** Select once using the existing job lock/audit. Busy/preparing never consumes a cloud slot. */
export async function selectLocalPdfExecution(
  input: LocalPdfSelectionInput,
  db = getDatabase(),
) {
  const ctx = input.context,
    owner = ctx.policySnapshot.subjectId,
    args = WorkspaceDocumentReadArgsSchema.parse(input.arguments),
    source = RuntimeLocalPdfSourceSchema.parse(input.source);
  UuidSchema.parse(ctx.workspaceId);
  if (
    !input.callId ||
    input.callId.length > 255 ||
    input.toolName !== 'workspace.document.read' ||
    args.objectId !== source.objectId ||
    (input.location !== undefined &&
      input.location !== (args.location ?? 'auto'))
  )
    throw new RuntimePolicyError('invalid_tool_call');
  const requested = ExecutionLocationSchema.parse(args.location ?? 'auto'),
    key = `local-pdf:${ctx.runId}:${input.callId}`,
    operationId = cloudStableId(key),
    requestDigest = digest({
      toolName: input.toolName,
      arguments: input.arguments,
      source,
    });
  return db.begin(async (tx) => {
    const [run] = await tx<
      { text: string; execution_snapshot: unknown; timeout_at: Date }[]
    >`
      select coalesce(m.content->>'text','') as text,e.execution_snapshot,j.timeout_at
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_messages m on m.id=e.user_message_id and m.organization_id=r.organization_id and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id
      join allrice_users u on u.id=r.owner_id and u.status='active'
      where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
        and r.state='running' and r.policy_snapshot_id=${ctx.policySnapshot.id} and j.status='running' and j.worker_id=${ctx.worker.id}
        and j.attempt=${input.jobAttempt} and j.lease_token=${input.jobLeaseToken} and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
        and exists(select 1 from allrice_memberships m where m.organization_id=r.organization_id and m.user_id=r.owner_id and m.active
          and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.role in ('admin','member')) for update of j`;
    if (!run)
      throw new RuntimePolicyError('run_or_frozen_configuration_changed');
    const parsed = EmployeeExecutionSnapshotSchema.safeParse(
      run.execution_snapshot,
    );
    if (
      !parsed.success ||
      !parsed.data.capabilitySnapshot.bindings.toolNames.includes(
        input.toolName,
      ) ||
      !parsed.data.capabilitySnapshot.grantedCapabilities.includes(
        'storage:read',
      ) ||
      (parsed.data.employee.definition.schemaVersion === 2 &&
        parsed.data.employee.definition.securityPolicy.deniedCapabilities.includes(
          'storage:read',
        ))
    )
      throw new RuntimePolicyError('frozen_configuration_invalid');
    const fileName = await assertPdfSource(
        tx,
        {
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId!,
          ownerId: owner,
        },
        source,
        ctx,
      ),
      constraints = executionRequestConstraints(run.text),
      location =
        constraints.location === 'auto' ? requested : constraints.location,
      localOnly = constraints.localOnly,
      f = frozenPdf(run.execution_snapshot);
    const [prior] = await tx<
      {
        reason: string;
        metadata: {
          requestDigest: string;
          choice: ExecutionChoice;
          deviceId: string | null;
        };
      }[]
    >`
      select reason,metadata from allrice_audit_events where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}
        and actor_id=${owner} and action='execution.location' and resource_type='readonly_pdf' and resource_id=${operationId} order by occurred_at limit 1`;
    if (prior && prior.metadata.requestDigest !== requestDigest)
      throw new RuntimePolicyError('idempotency_conflict');
    const [existing] = await tx<
      { snapshot: unknown; device_id: string | null; bridge_payload: unknown }[]
    >`select snapshot,device_id,bridge_payload from allrice_runtime_operations
      where id=${operationId} and run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}`;
    const old = prior
        ? ExecutionChoiceSchema.parse(prior.metadata.choice)
        : null,
      snapshot = existing
        ? RuntimeOperationSnapshotSchema.parse(existing.snapshot)
        : null,
      existingPayload = existing
        ? RuntimeLocalPdfPayloadSchema.parse(existing.bridge_payload)
        : null,
      boundDevice = existing?.device_id ?? prior?.metadata.deviceId ?? null;
    if (
      existingPayload &&
      (existingPayload.arguments.origin.argumentsDigest !==
        digest(input.arguments) ||
        !runtimeContractEqual(existingPayload.arguments.source, source))
    )
      throw new RuntimePolicyError('idempotency_conflict');
    const devices =
      f && localOperationsFeatureEnabled()
        ? await tx<
            {
              device: unknown;
              id: string;
              platform: string;
              metadata: Record<string, unknown>;
              online: boolean;
              profile: unknown;
              profile_fresh: boolean;
              grant_active: boolean;
              busy: boolean;
            }[]
          >`select d.id,d.platform,json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,
        'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online',
        'lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,
      t.metadata,coalesce(d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false)
        and (t.state='online' or t.metadata->'environment'->>'paused'='true') as online,
      p.profile,coalesce(p.reported_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) as profile_fresh,
      g.id is not null and g.revoked_at is null as grant_active,
      exists(select 1 from allrice_runtime_operations o where o.device_id=d.id and o.id<>${operationId}
        and o.snapshot->>'status' in ('dispatched','running','cancel_requested','unknown') and o.snapshot->'binding'->>'action' in ('local.pdf.read','local.python.execute','local.process.execute','local.mcp.call')) as busy
      from allrice_bridge_devices d join allrice_execution_targets t on t.target_key='bridge.'||d.id::text and t.organization_id=d.organization_id
        and t.workspace_id=d.workspace_id and t.kind='rice_bridge'
      left join allrice_bridge_pdf_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
      left join allrice_bridge_pdf_runtime_grants g on g.device_id=d.id and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
      where d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${owner} and d.revoked_at is null
        and d.protocol_version=2 and d.capabilities @> array['local.pdf.read']::text[] and (${boundDevice}::uuid is null or d.id=${boundDevice}::uuid)
      order by d.last_seen_at desc nulls last`
        : [];
    const candidates = devices.map((d) => {
      let state = bridgeCapabilityReadinessView(
        d.metadata,
        'local.pdf.read',
        d.online,
      ).state;
      const release = pdfReadReleaseForPlatform(d.platform),
        p = RuntimeLocalPdfProfileSchema.safeParse(d.profile);
      if (!release?.nativeSupported) state = 'unsupported';
      if (
        (state === 'ready' || state === 'busy') &&
        (!p.success ||
          !p.data.available ||
          !d.profile_fresh ||
          !d.grant_active ||
          !localPdfProfileMatchesRelease(p.data, release!))
      )
        state = 'unsupported';
      if (snapshot && state === 'busy') state = 'ready';
      if (d.busy && state === 'ready') state = 'busy';
      if (
        existingPayload &&
        p.success &&
        !runtimeContractEqual(existingPayload.arguments.pins, p.data.pins)
      )
        state = 'unsupported';
      return { ...d, state, profile: p.success ? p.data : null };
    });
    const rank = [
      'ready',
      'busy',
      'preparing',
      'paused',
      'unsupported',
      'offline',
    ];
    candidates.sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state));
    const device = candidates[0],
      choice = resolveExecutionChoice({
        location,
        local: device?.state ?? null,
        cloudAvailable: true,
        localInputs: localOnly,
        boundLocation: existing
          ? 'local'
          : old?.location === 'none'
            ? undefined
            : old?.location,
        outcomeUnknown:
          snapshot?.status === 'unknown' ||
          !!(
            existingPayload &&
            device?.profile &&
            !runtimeContractEqual(
              existingPayload.arguments.pins,
              device.profile.pins,
            )
          ),
      });
    if (!prior && choice.status !== 'unavailable')
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${ctx.organizationId},${ctx.workspaceId},${owner},'execution.location','readonly_pdf',${operationId},'recorded',${choice.reason},
          ${tx.json({ requestDigest, choice, deviceId: choice.location === 'local' ? (device?.id ?? null) : null, runId: ctx.runId, callId: input.callId, localOnly })})`;
    return {
      choice,
      selectionReason: prior?.reason ?? choice.reason,
      operationId,
      device: device?.device ? BridgeDeviceSchema.parse(device.device) : null,
      profile: device?.profile ?? null,
      deadlineAt: run.timeout_at.toISOString(),
      existingSnapshot: snapshot,
      existingPayload,
      localOnly: localOnly || location === 'local',
      fileName,
      source,
      jobAttempt: input.jobAttempt,
      jobLeaseToken: input.jobLeaseToken,
      argumentsDigest: digest(input.arguments),
    };
  });
}

export function localPdfCommandBinding(payload: RuntimeLocalPdfPayload) {
  const a = payload.arguments;
  return {
    executableDigest: digest({ reader: 'native-seatbelt-v1', pins: a.pins }),
    argumentsDigest: digest({
      origin: a.origin,
      source: a.source,
      options: a.options,
      fileName: a.fileName,
    }),
    workingDirectoryDigest: digest({ kind: 'local_copy', source: a.source }),
    effectiveEnvironmentDigest: digest({ version: 1, credentials: 'none' }),
    networkPolicyDigest: digest({ network: 'none' }),
    toolchainDigest: digest({ profileVersion: a.profileVersion, pins: a.pins }),
    budgetDigest: digest(a.limits),
  };
}

/** Governed create/dispatch/heartbeat repeat the immutable call and actual source checks. */
export async function assertLocalPdfDelegation(
  tx: TransactionSql,
  device: BridgeDevice,
  binding: RuntimeActionBinding,
  payload: RuntimeLocalPdfPayload,
  frozenValue: unknown,
) {
  const a = payload.arguments,
    f = frozenPdf(frozenValue);
  const [origin] = await tx<
    {
      original_arguments: Record<string, unknown>;
      request_digest: string;
      source: unknown;
      file_name: string;
      job_id: string;
      job_attempt: number;
      job_lease_token: string;
      job_worker_id: string;
    }[]
  >`
    select original_arguments,request_digest,source,file_name,job_id,job_attempt,job_lease_token,job_worker_id from allrice_local_pdf_delegations
    where operation_id=${binding.attempt.operationId} and run_id=${binding.task.runId} and organization_id=${device.organizationId}
      and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and device_id=${device.id}
      and call_id=${a.origin.callId} and tool_name='workspace.document.read'`;
  const original = WorkspaceDocumentReadArgsSchema.safeParse(
    origin?.original_arguments,
  );
  if (
    !f ||
    !origin ||
    !original.success ||
    original.data.objectId !== a.source.objectId ||
    digest(origin.original_arguments) !== a.origin.argumentsDigest ||
    origin.request_digest !==
      digest({
        toolName: a.origin.toolName,
        arguments: origin.original_arguments,
        source: origin.source,
      }) ||
    !runtimeContractEqual(origin.source, a.source) ||
    origin.file_name !== a.fileName ||
    !runtimeContractEqual(binding.command, localPdfCommandBinding(payload)) ||
    !runtimeContractEqual(
      a.options,
      Object.fromEntries(
        Object.entries(original.data).filter(([k]) =>
          ['maxCharacters', 'includeStructure', 'pages'].includes(k),
        ),
      ),
    )
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  const [job] =
    await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id and r.organization_id=j.organization_id
    and r.workspace_id=j.workspace_id and r.owner_id=j.owner_id
    where j.id=${origin.job_id} and j.run_id=${binding.task.runId} and j.organization_id=${device.organizationId} and j.workspace_id=${device.workspaceId}
      and j.owner_id=${device.ownerId} and j.attempt=${origin.job_attempt} and j.lease_token=${origin.job_lease_token} and j.worker_id=${origin.job_worker_id}
      and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      and r.state='running' and r.policy_snapshot_id=${f.tenantContext.policySnapshotId} for share of j,r`;
  const [version] = await tx<
    { manifest: unknown }[]
  >`select manifest from allrice_employee_versions where id=${f.employee.versionId} and employee_id=${f.employee.id}
    and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and config_checksum=${f.employee.definitionChecksum} for share`;
  const manifest = EmployeeDefinitionSchema.safeParse(version?.manifest);
  const publication = f.capabilitySnapshot.bindings.managedPdf!.publication;
  const [published] = await tx<
    { definition: unknown }[]
  >`select definition from allrice_platform_employee_revisions
    where id=${publication.revisionId} and checksum=${publication.checksum} and status='published' for share`;
  const definition = PlatformEmployeeDefinitionSchema.safeParse(
    published?.definition,
  );
  if (
    !job ||
    !manifest.success ||
    !runtimeContractEqual(manifest.data, f.employee.definition) ||
    !definition.success ||
    definition.data.securityPolicy.bridgeAccess === 'none' ||
    definition.data.securityPolicy.deniedCapabilities.includes(
      'storage:read',
    ) ||
    !definition.data.capabilities.toolNames.includes('workspace.document.read')
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  const [policy] = await tx<
    {
      id: string;
      organization_id: string;
      subject_id: string;
      version: number;
      payload: Record<string, unknown>;
      issued_at: Date;
      expires_at: Date;
    }[]
  >`
    select id,organization_id,subject_id,version,payload,issued_at,expires_at from allrice_policy_snapshots
    where id=${binding.policy.snapshotId} and organization_id=${device.organizationId} and subject_id=${device.ownerId} for share`;
  if (!policy) throw new RuntimePolicyError('bridge_authority_changed');
  const context = ExecutionContextSchema.parse({
    executionId: binding.attempt.attemptId,
    runId: binding.task.runId,
    jobId: origin.job_id,
    worker: { type: 'worker', id: origin.job_worker_id },
    delegatedBy: { type: 'user', id: device.ownerId },
    organizationId: device.organizationId,
    workspaceId: device.workspaceId,
    policySnapshot: PolicySnapshotSchema.parse({
      ...policy.payload,
      id: policy.id,
      organizationId: policy.organization_id,
      subjectId: policy.subject_id,
      version: policy.version,
      issuedAt: policy.issued_at.toISOString(),
      expiresAt: policy.expires_at.toISOString(),
    }),
    startedAt: policy.issued_at.toISOString(),
  });
  await assertPdfSource(
    tx,
    {
      organizationId: device.organizationId,
      workspaceId: device.workspaceId,
      ownerId: device.ownerId,
    },
    a.source,
    context,
  );
}

export async function createLocalPdfReadOperation(
  input: {
    selection: Awaited<ReturnType<typeof selectLocalPdfExecution>>;
    context: ExecutionContext;
    payload: RuntimeLocalPdfPayload;
    arguments: Record<string, unknown>;
  },
  db = getDatabase(),
) {
  const { selection, context: ctx } = input,
    payload = RuntimeLocalPdfPayloadSchema.parse(input.payload),
    device = selection.device;
  if (
    !device ||
    selection.choice.location !== 'local' ||
    selection.choice.status === 'unavailable'
  )
    throw new RuntimePolicyError('local_runner_unavailable');
  if (selection.choice.status === 'wait')
    throw new RuntimePolicyError(
      selection.choice.reason === 'local_busy'
        ? 'local_runner_busy'
        : 'local_runner_preparing',
    );
  if (selection.choice.status === 'reconcile')
    throw new RuntimePolicyError('local_pdf_outcome_unknown');
  const key = `local-pdf:${ctx.runId}:${payload.arguments.origin.callId}`,
    operationId = cloudStableId(key);
  if (
    operationId !== selection.operationId ||
    !runtimeContractEqual(selection.source, payload.arguments.source) ||
    payload.arguments.fileName !== selection.fileName ||
    digest(input.arguments) !== selection.argumentsDigest ||
    (selection.existingPayload &&
      !runtimeContractEqual(payload, selection.existingPayload))
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  const [row] = await db<
    {
      execution_spec: unknown;
      policy_payload: unknown;
      session_id: string;
      employee_version_id: string;
      thread_generation: number;
      target_id: string;
    }[]
  >`
    select r.execution_spec,p.payload as policy_payload,e.session_id,e.employee_version_id,c.thread_generation,t.id as target_id
    from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.organization_id=r.organization_id and p.subject_id=r.owner_id
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.active_run_id=r.id and c.state='running'
      and c.organization_id=r.organization_id and c.workspace_id=r.workspace_id and c.owner_id=r.owner_id
    join allrice_execution_targets t on t.target_key=${`bridge.${device.id}`} and t.organization_id=r.organization_id and t.workspace_id=r.workspace_id and t.kind='rice_bridge'
    where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${ctx.policySnapshot.subjectId}`;
  const grant = await readLocalPdfRuntimeGrant(device, db);
  if (!row || !grant || grant.revokedAt)
    throw new RuntimePolicyError('bridge_authority_changed');
  const requestDigest = digest({
    toolName: payload.arguments.origin.toolName,
    arguments: input.arguments,
    source: payload.arguments.source,
  });
  const [origin] = await db<
    { request_digest: string }[]
  >`insert into allrice_local_pdf_delegations
    (operation_id,run_id,organization_id,workspace_id,owner_id,device_id,job_id,job_worker_id,job_attempt,job_lease_token,call_id,tool_name,original_arguments,source,file_name,request_digest)
    values(${operationId},${ctx.runId},${ctx.organizationId},${ctx.workspaceId},${ctx.policySnapshot.subjectId},${device.id},${ctx.jobId},${ctx.worker.id},${selection.jobAttempt},${selection.jobLeaseToken},
      ${payload.arguments.origin.callId},'workspace.document.read',${db.json(JSON.parse(JSON.stringify(input.arguments)))},${db.json(payload.arguments.source)},${payload.arguments.fileName},${requestDigest})
    on conflict(operation_id) do update set operation_id=allrice_local_pdf_delegations.operation_id returning request_digest`;
  if (origin?.request_digest !== requestDigest)
    throw new RuntimePolicyError('idempotency_conflict');
  const binding = RuntimeActionBindingSchema.parse({
    task: {
      scope: {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        projectId: null,
      },
      runId: ctx.runId,
      rootRunId: ctx.runId,
      parentRunId: null,
      chatSessionId: row.session_id,
      frozenConfiguration: {
        employeeVersionId: row.employee_version_id,
        digest: digest(row.execution_spec),
      },
    },
    attempt: {
      operationId,
      attemptId: cloudStableId(`${key}:attempt`),
      attemptNumber: 1,
      generation: row.thread_generation,
      fence: 1,
    },
    requestedBy: { type: 'user', id: ctx.policySnapshot.subjectId },
    policy: {
      snapshotId: ctx.policySnapshot.id,
      digest: digest(row.policy_payload),
    },
    execution: {
      targetId: row.target_id,
      targetKind: 'rice_bridge',
      deviceId: device.id,
      grantId: grant.id,
      grantVersion: grant.runtimeGeneration,
      scopeDigest: `sha256:${grant.rootFingerprint}`,
      workCopy: { id: operationId, kind: 'local_copy' },
    },
    action: payload.capability,
    inputDigest: digest(payload),
    command: localPdfCommandBinding(payload),
    baseline: [],
    dataScope: [],
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
      database: db,
      initialOperation: { binding, payload },
    }),
    budgets = await ensureRuntimeOperationRoot(
      ledger,
      binding.task,
      selection.deadlineAt,
      db,
    );
  const snapshot = await ledger.createOperation({
    snapshot: RuntimeOperationSnapshotSchema.parse({
      contractVersion: 1,
      binding,
      stepId: null,
      agentInstanceId: null,
      processId: null,
      cancelRequestId: null,
      idempotencyKey: cloudStableId(`${key}:delivery`),
      status: 'planned',
      result: null,
    }),
    bridgePayload: payload,
    reservations: budgets.map(({ metric }) => ({
      metric,
      accountingId: cloudStableId(`${key}:meter:${metric}`),
      amount: metric === 'tool_calls' ? 1 : 0,
    })),
  });
  await linkTaskOperationCall(db, operationId, payload.arguments.origin.callId);
  await db`select pg_notify('allrice_bridge_commands',${device.id})`;
  return {
    snapshot,
    workspaceLabel: '电脑只读 PDF 环境',
    deadlineAt: selection.deadlineAt,
    ledger,
  };
}

export const waitLocalPdfReadOperation = waitLocalCommandOperation;

/** Scoped discovery only: the selected transfer helper must re-admit the action. */
export async function readBridgeOperationTransferCapability(
  token: string,
  id: string,
  leaseToken: string,
  db = getDatabase(),
) {
  const { device } = await bridgeDeviceStatus(token);
  UuidSchema.parse(id);
  UuidSchema.parse(leaseToken);
  const leaseHash = createHash('sha256').update(leaseToken).digest('hex');
  const [row] = await db<
    { capability: string; action: string }[]
  >`select bridge_payload->>'capability' as capability,initial_snapshot->'binding'->>'action' as action from allrice_runtime_operations
    where id=${id} and device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and lease_token_hash=${leaseHash} and lease_expires_at>clock_timestamp() and snapshot->>'status'='running' and snapshot->>'cancelRequestId' is null`;
  if (!row || row.capability !== row.action)
    throw new DataAccessError('authorization_denied');
  return row.capability;
}

/** Only the exact authorized source may be downloaded. There is no PDF upload authority. */
export async function localPdfTransferAuthority(
  token: string,
  id: string,
  leaseToken: string,
  objectId: string,
  mode: 'authorize' | 'download',
  db = getDatabase(),
) {
  if (mode !== 'authorize' && mode !== 'download')
    throw new DataAccessError('authorization_denied');
  const { device } = await bridgeDeviceStatus(token);
  UuidSchema.parse(id);
  UuidSchema.parse(leaseToken);
  UuidSchema.parse(objectId);
  const leaseHash = createHash('sha256').update(leaseToken).digest('hex');
  const [row] = await db<
    { snapshot: unknown; bridge_payload: unknown }[]
  >`select snapshot,bridge_payload from allrice_runtime_operations
    where id=${id} and device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and lease_token_hash=${leaseHash} and lease_expires_at>clock_timestamp() and snapshot->>'status'='running' and snapshot->>'cancelRequestId' is null`;
  if (!row) throw new DataAccessError('authorization_denied');
  const parsed = RuntimeLocalPdfPayloadSchema.safeParse(row.bridge_payload);
  if (!parsed.success || parsed.data.arguments.source.objectId !== objectId)
    throw new DataAccessError('authorization_denied');
  const payload = parsed.data,
    snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  const renewed = await createGovernedBridgeOperationLedger(device, {
    database: db,
  })
    .heartbeat({
      scope: snapshot.binding.task.scope,
      operationId: id,
      leaseToken,
      leaseMs: 120000,
    })
    .catch((error: unknown) => {
      if (
        error instanceof RuntimePolicyError ||
        (error instanceof RuntimeLedgerError && error.code === 'unavailable')
      )
        throw new DataAccessError('authorization_denied');
      if (error instanceof RuntimeLedgerError && error.code === 'lease_lost')
        throw new BridgeDataError('lease_lost');
      throw error;
    });
  if (renewed.snapshot.status !== 'running' || renewed.snapshot.cancelRequestId)
    throw new DataAccessError('authorization_denied');
  const memberships = await db<
    RequestContext['memberships']
  >`select id,user_id as "userId",organization_id as "organizationId",workspace_id as "workspaceId",role,active
    from allrice_memberships where user_id=${device.ownerId} and organization_id=${device.organizationId} and active
      and (workspace_id is null or workspace_id=${device.workspaceId}) and role in ('admin','member')`;
  if (!memberships.length) throw new DataAccessError('authorization_denied');
  const { getCompanyRunMaterial } = await import('./company-run-assets.ts');
  const companyMaterial = await getCompanyRunMaterial(
    {
      organizationId: device.organizationId,
      workspaceId: device.workspaceId,
      ownerId: device.ownerId,
      runId: snapshot.binding.task.runId,
    },
    objectId,
    db,
  );
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: device.id,
    actor: { type: 'user', id: device.ownerId },
    organizationId: device.organizationId,
    workspaceId: device.workspaceId,
    memberships,
    authenticatedAt: new Date().toISOString(),
  };
  return {
    device,
    context,
    payload,
    snapshot: renewed.snapshot,
    sessionId: snapshot.binding.task.chatSessionId,
    input: payload.arguments.source,
    companyMaterial,
  };
}

export async function readLocalPdfInput(
  token: string,
  id: string,
  leaseToken: string,
  objectId: string,
  db = getDatabase(),
) {
  const a = await localPdfTransferAuthority(
      token,
      id,
      leaseToken,
      objectId,
      'download',
      db,
    ),
    file = a.companyMaterial ?? (await getStoredFile(a.context, objectId, db));
  if (
    file.object.checksum !== a.input.checksum ||
    file.object.sizeBytes !== a.input.sizeBytes ||
    file.object.mediaType !== a.input.mediaType
  )
    throw new DataAccessError('authorization_denied');
  return { object: file.object, fileName: a.payload.arguments.fileName };
}
