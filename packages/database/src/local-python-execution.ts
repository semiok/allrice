import { createHash, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  BridgeDeviceSchema,
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionChoiceSchema,
  ExecutionLocationSchema,
  NativeOfficeExportSchema,
  PythonExecuteArgsSchema,
  RuntimeActionBindingSchema,
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonProfileSchema,
  RuntimeLocalPythonArtifactMetadataSchema,
  RuntimeLocalPythonResultSchema,
  RuntimeOperationSnapshotSchema,
  UuidSchema,
  localPythonProfileMatchesRelease,
  localPythonResultMatchesPayload,
  PlatformEmployeeDefinitionSchema,
  managedPythonPayloadForPlatform,
  resolveExecutionChoice,
  runtimeContractEqual,
  type BridgeDevice,
  type ExecutionContext,
  type ExecutionChoice,
  type ExecutionLocation,
  type RequestContext,
  type RuntimeActionBinding,
  type RuntimeLocalPythonPayload,
  type ManagedPythonPurpose,
  type StoragePort,
  type StorageObject,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  RuntimePolicyError,
  createRuntimePolicyAdmission,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  cloudExecutionEnabled,
  normalizeCloudPythonArguments,
} from './cloud-authority.ts';
import {
  createGovernedBridgeOperationLedger,
  createGovernedBridgePolicyOptions,
} from './runtime-governed-bridge.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { registerToolBrokerExport } from './execution/tool-broker.ts';
import { validatePngArtifact } from '@allrice/storage';
import { ensureRuntimeOperationRoot } from './runtime-ledger/root-service.ts';
import {
  localOperationsFeatureEnabled,
  waitLocalCommandOperation,
} from './local-command-service.ts';
import { linkTaskOperationCall } from './task-clock.ts';
import { bridgeDeviceStatus, BridgeDataError } from './bridge.ts';
import { RuntimeLedgerError } from './runtime-ledger/types.ts';
import {
  DataAccessError,
  createStorageMetadata,
  getStoredFile,
  markStorageReady,
  abandonStorageMetadata,
} from './data.ts';

export function managedPythonRuntimeFingerprint(deviceId: string) {
  return createHash('sha256')
    .update(`allrice-managed-python-v1:${UuidSchema.parse(deviceId)}`)
    .digest('hex');
}

export async function readManagedPythonRuntimeGrant(
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
  >`
    select id,root_fingerprint,runtime_generation,revoked_at from allrice_bridge_managed_runtime_grants
    where device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId}`;
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

/** A fresh physical probe authorizes only a fixed private runtime, never a folder. */
export async function reportLocalPythonProfile(
  device: BridgeDevice,
  value: unknown,
  db = getDatabase(),
) {
  if (!localOperationsFeatureEnabled())
    throw new RuntimePolicyError('runtime_policy_disabled');
  const profile = RuntimeLocalPythonProfileSchema.parse(value),
    release = managedPythonPayloadForPlatform(device.platform);
  if (
    !release ||
    !localPythonProfileMatchesRelease(profile, release) ||
    device.revokedAt
  )
    throw new RuntimePolicyError('target_unavailable');
  await db.begin(async (tx) => {
    const [current] =
      await tx`select id from allrice_bridge_devices where id=${device.id} and organization_id=${device.organizationId}
      and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and revoked_at is null for share`;
    if (!current) throw new RuntimePolicyError('target_unavailable');
    await tx`insert into allrice_bridge_managed_python_profiles(device_id,organization_id,workspace_id,profile)
      values(${device.id},${device.organizationId},${device.workspaceId},${tx.json(profile)})
      on conflict(device_id) do update set profile=excluded.profile,reported_at=clock_timestamp()
      where allrice_bridge_managed_python_profiles.organization_id=excluded.organization_id and allrice_bridge_managed_python_profiles.workspace_id=excluded.workspace_id`;
    if (profile.available && profile.stopConfirmed)
      await tx`insert into allrice_bridge_managed_runtime_grants(id,device_id,organization_id,workspace_id,owner_id,profile_version,root_fingerprint)
        values(${cloudStableId(`managed-python-grant:${device.id}`)},${device.id},${device.organizationId},${device.workspaceId},${device.ownerId},1,${managedPythonRuntimeFingerprint(device.id)})
        on conflict(device_id) do update set revoked_at=null,
          runtime_generation=allrice_bridge_managed_runtime_grants.runtime_generation+case when allrice_bridge_managed_runtime_grants.revoked_at is null then 0 else 1 end
        where allrice_bridge_managed_runtime_grants.organization_id=excluded.organization_id and allrice_bridge_managed_runtime_grants.workspace_id=excluded.workspace_id
          and allrice_bridge_managed_runtime_grants.owner_id=excluded.owner_id and allrice_bridge_managed_runtime_grants.root_fingerprint=excluded.root_fingerprint`;
  });
  return profile;
}

function frozenPurpose(
  value: unknown,
  purpose: ManagedPythonPurpose,
  toolName: string,
  hasInputs: boolean,
) {
  const parsed = EmployeeExecutionSnapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.schemaVersion !== 2) return null;
  const f = parsed.data,
    b = f.capabilitySnapshot.bindings.managedPython;
  if (f.employee.definition.schemaVersion !== 2) return null;
  if (
    !b ||
    b.profileVersion !== 1 ||
    !b.purposes.includes(purpose) ||
    !f.capabilitySnapshot.bindings.toolNames.includes(toolName) ||
    !f.capabilitySnapshot.grantedCapabilities.includes('storage:write') ||
    (hasInputs &&
      !f.capabilitySnapshot.grantedCapabilities.includes('storage:read')) ||
    f.employee.definition.securityPolicy.deniedCapabilities.includes(
      'storage:write',
    ) ||
    (hasInputs &&
      f.employee.definition.securityPolicy.deniedCapabilities.includes(
        'storage:read',
      ))
  )
    return null;
  return f;
}

export interface ManagedPythonSelectionInput {
  context: ExecutionContext;
  callId: string;
  toolName: 'workspace.export.create' | 'python.execute';
  arguments: Record<string, unknown>;
  purpose: ManagedPythonPurpose;
  inputs: { objectId: string; checksum: string }[];
  location?: ExecutionLocation;
  jobAttempt: number;
  jobLeaseToken: string;
}

/** Select once in existing audit history. Temporary preparation/busy uses the existing durable wait. */
export async function selectManagedPythonExecution(
  input: ManagedPythonSelectionInput,
  db = getDatabase(),
) {
  const ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  UuidSchema.parse(ctx.workspaceId);
  if (
    !input.callId ||
    input.callId.length > 255 ||
    input.toolName !==
      (input.purpose === 'office'
        ? 'workspace.export.create'
        : 'python.execute')
  )
    throw new RuntimePolicyError('invalid_tool_call');
  const requested = ExecutionLocationSchema.parse(input.location ?? 'auto'),
    key = `managed-python:${ctx.runId}:${input.callId}`,
    operationId = cloudStableId(key),
    requestDigest = digest({
      toolName: input.toolName,
      arguments: input.arguments,
      purpose: input.purpose,
    });
  return db.begin(async (tx) => {
    const [run] = await tx<
      {
        text: string;
        execution_snapshot: unknown;
        timeout_at: Date;
        local_inputs: boolean;
      }[]
    >`
      select coalesce(m.content->>'text','') as text,e.execution_snapshot,j.timeout_at,
      exists(select 1 from allrice_runtime_operations o where o.run_id=r.id and o.organization_id=r.organization_id and o.workspace_id=r.workspace_id
        and o.snapshot->'binding'->>'action' in ('local.fs.read','local.fs.write','local.fs.changeset','local.process.execute','local.file.inspect')) as local_inputs
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_messages m on m.id=e.user_message_id and m.organization_id=r.organization_id and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id
      join allrice_users u on u.id=r.owner_id and u.status='active'
      where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
        and r.state='running' and r.policy_snapshot_id=${ctx.policySnapshot.id} and j.status='running' and j.worker_id=${ctx.worker.id}
        and j.attempt=${input.jobAttempt} and j.lease_token=${input.jobLeaseToken} and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
        and exists(select 1 from allrice_memberships m where m.organization_id=r.organization_id and m.user_id=r.owner_id and m.active
          and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.role in ('admin','member'))
      for update of j`;
    if (!run)
      throw new RuntimePolicyError('run_or_frozen_configuration_changed');
    const constraints = executionRequestConstraints(run.text),
      location =
        constraints.location === 'auto' ? requested : constraints.location,
      localInputs = run.local_inputs || constraints.localOnly;
    const f = frozenPurpose(
      run.execution_snapshot,
      input.purpose,
      input.toolName,
      input.inputs.length > 0,
    );
    // Historic snapshots retain the established cloud Office execution; explicit local stays unavailable.
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
        and actor_id=${owner} and action='execution.location' and resource_type='managed_python' and resource_id=${operationId} order by occurred_at limit 1`;
    if (prior && prior.metadata.requestDigest !== requestDigest)
      throw new RuntimePolicyError('idempotency_conflict');
    const [existing] = await tx<
      { snapshot: unknown; device_id: string | null }[]
    >`select snapshot,device_id from allrice_runtime_operations
      where id in (${operationId},${cloudStableId(`cloud-python:${ctx.runId}:${input.callId}`)}) and run_id=${ctx.runId}
        and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} order by id`;
    const old = prior
        ? ExecutionChoiceSchema.parse(prior.metadata.choice)
        : null,
      snapshot = existing
        ? RuntimeOperationSnapshotSchema.parse(existing.snapshot)
        : null;
    const boundDevice = existing?.device_id ?? prior?.metadata.deviceId ?? null;
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
              busy: boolean;
            }[]
          >`
      select d.id,d.platform,json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,
        'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online',
        'lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,
        t.metadata,coalesce(d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) and t.state='online' as online,
        p.profile,coalesce(p.reported_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) as profile_fresh,
        exists(select 1 from allrice_runtime_operations o where o.device_id=d.id and o.id<>${operationId}
          and o.snapshot->>'status' in ('dispatched','running','cancel_requested','unknown') and o.snapshot->'binding'->>'action' in ('local.python.execute','local.process.execute','local.mcp.call')) as busy
      from allrice_bridge_devices d join allrice_execution_targets t on t.target_key='bridge.'||d.id::text and t.organization_id=d.organization_id
        and t.workspace_id=d.workspace_id and t.kind='rice_bridge'
      left join allrice_bridge_managed_python_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
      where d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${owner} and d.revoked_at is null
        and d.protocol_version=2 and (${boundDevice}::uuid is null or d.id=${boundDevice}::uuid)
      order by d.last_seen_at desc nulls last`
        : [];
    const candidates = devices.map((d) => {
      let state = bridgeCapabilityReadinessView(
        d.metadata,
        input.purpose === 'office' ? 'local.office' : 'local.python',
        d.online,
      ).state;
      const release = managedPythonPayloadForPlatform(d.platform),
        p = RuntimeLocalPythonProfileSchema.safeParse(d.profile);
      if (!release?.nativeSupported) state = 'unsupported';
      if (
        state === 'ready' &&
        (!p.success ||
          !p.data.available ||
          !p.data.purposes.includes(input.purpose) ||
          (input.purpose === 'python_charts' &&
            p.data.pythonChartsContractVersion !== 1) ||
          !d.profile_fresh ||
          !localPythonProfileMatchesRelease(p.data, release!))
      )
        state = 'unsupported';
      if (snapshot && state === 'busy') state = 'ready';
      if (d.busy && state === 'ready') state = 'busy';
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
    const device = candidates[0];
    const choice = resolveExecutionChoice({
      location,
      local: device?.state ?? null,
      cloudAvailable: input.purpose === 'office' || cloudExecutionEnabled(),
      localInputs,
      boundLocation: existing
        ? existing.device_id
          ? 'local'
          : 'cloud'
        : old?.location === 'none'
          ? undefined
          : old?.location,
      outcomeUnknown: snapshot?.status === 'unknown',
    });
    if (!prior && choice.status !== 'unavailable')
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${ctx.organizationId},${ctx.workspaceId},${owner},'execution.location','managed_python',${operationId},'recorded',${choice.reason},
        ${tx.json({ requestDigest, choice, deviceId: choice.location === 'local' ? (device?.id ?? null) : null, runId: ctx.runId, callId: input.callId, purpose: input.purpose, localInputs })})`;
    return {
      choice,
      selectionReason: prior?.reason ?? choice.reason,
      operationId,
      device: device?.device ? BridgeDeviceSchema.parse(device.device) : null,
      profile: device?.profile ?? null,
      deadlineAt: run.timeout_at.toISOString(),
      existingSnapshot: snapshot,
      localOnly: localInputs || location === 'local',
    };
  });
}

export function localPythonCommandBinding(payload: RuntimeLocalPythonPayload) {
  const a = payload.arguments;
  return {
    executableDigest: digest({
      executable: '/opt/python/bin/python',
      purpose: a.purpose,
      imageId: a.imageId,
    }),
    argumentsDigest: digest({
      script: a.script,
      origin: a.origin,
      outputs: a.outputs,
    }),
    workingDirectoryDigest: digest({ kind: 'local_copy', inputs: a.inputs }),
    effectiveEnvironmentDigest: digest({ version: 1, credentials: 'none' }),
    networkPolicyDigest: digest({ network: 'none' }),
    toolchainDigest: digest({
      imageId: a.imageId,
      architecture: a.architecture,
      profileVersion: a.profileVersion,
    }),
    budgetDigest: digest(a.limits),
  };
}

/** Used again by governed dispatch/heartbeat, not only Worker selection. */
export async function assertLocalPythonDelegation(
  tx: TransactionSql,
  device: BridgeDevice,
  binding: RuntimeActionBinding,
  payload: RuntimeLocalPythonPayload,
  frozenValue: unknown,
) {
  const a = payload.arguments,
    f = frozenPurpose(
      frozenValue,
      a.purpose,
      a.origin.toolName,
      a.inputs.length > 0,
    );
  const [origin] = await tx<
    { original_arguments: Record<string, unknown>; request_digest: string }[]
  >`select original_arguments,request_digest
    from allrice_local_python_delegations where operation_id=${binding.attempt.operationId} and run_id=${binding.task.runId}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} and device_id=${device.id}
      and call_id=${a.origin.callId} and tool_name=${a.origin.toolName} and purpose=${a.purpose}`;
  if (
    !f ||
    !origin ||
    digest(origin.original_arguments) !== a.origin.argumentsDigest ||
    origin.request_digest !==
      digest({
        toolName: a.origin.toolName,
        arguments: origin.original_arguments,
        purpose: a.purpose,
      }) ||
    !runtimeContractEqual(binding.command, localPythonCommandBinding(payload))
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  const [version] = await tx<{ id: string; manifest: unknown }[]>`
    select id,manifest from allrice_employee_versions where id=${f.employee.versionId} and employee_id=${f.employee.id}
    and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and config_checksum=${f.employee.definitionChecksum} for share`;
  const manifest = EmployeeDefinitionSchema.safeParse(version?.manifest);
  if (
    !version ||
    !manifest.success ||
    // Preserve the immutable published checksum. JSONB/parser key order is
    // not another publication and cannot reproduce JSON.stringify's bytes.
    !runtimeContractEqual(manifest.data, f.employee.definition)
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  const publication = f.capabilitySnapshot.bindings.managedPython!.publication;
  const [published] = await tx<
    { definition: Record<string, unknown>; checksum: string }[]
  >`select definition,checksum
    from allrice_platform_employee_revisions where id=${publication.revisionId} and checksum=${publication.checksum}`;
  const definition = PlatformEmployeeDefinitionSchema.safeParse(
    published?.definition,
  );
  if (
    !published ||
    !definition.success ||
    definition.data.securityPolicy.bridgeAccess !== 'read_write' ||
    !definition.data.capabilities.toolNames.includes(a.origin.toolName) ||
    definition.data.securityPolicy.deniedCapabilities.includes(
      'storage:write',
    ) ||
    (a.inputs.length > 0 &&
      definition.data.securityPolicy.deniedCapabilities.includes(
        'storage:read',
      ))
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  if (a.purpose === 'office') {
    const native = NativeOfficeExportSchema.safeParse(
        origin.original_arguments.python,
      ),
      format = origin.original_arguments.format;
    if (
      !native.success ||
      native.data.script !== a.script ||
      a.outputs.length !== 1 ||
      a.outputs[0]!.format !== format ||
      a.outputs[0]!.path !== `result.${format}` ||
      a.inputs.length !== native.data.inputs.length ||
      !a.inputs.every((i) =>
        native.data.inputs.some(
          (s) =>
            s.objectId === i.objectId &&
            s.checksum === i.checksum &&
            s.path === i.path,
        ),
      )
    )
      throw new RuntimePolicyError('bridge_authority_changed');
  } else {
    const original = PythonExecuteArgsSchema.safeParse(
      origin.original_arguments,
    );
    const [profile] = await tx<{ profile: unknown }[]>`
      select profile from allrice_bridge_managed_python_profiles where device_id=${device.id}
        and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}`;
    const currentProfile = RuntimeLocalPythonProfileSchema.safeParse(
      profile?.profile,
    );
    if (
      !original.success ||
      !currentProfile.success ||
      currentProfile.data.pythonChartsContractVersion !== 1
    )
      throw new RuntimePolicyError('bridge_authority_changed');
    const normalized = normalizeCloudPythonArguments(origin.original_arguments);
    const mediaTypes = {
      png: 'image/png',
      json: 'application/json',
      csv: 'text/csv',
      txt: 'text/plain',
    };
    if (
      normalized.script !== a.script ||
      !runtimeContractEqual(
        normalized.inputs,
        a.inputs.map(({ path, objectId, checksum }) => ({
          path,
          objectId,
          checksum,
        })),
      ) ||
      !runtimeContractEqual(
        normalized.outputs,
        a.outputs.map(({ path, fileName, format }) => ({
          path,
          fileName,
          format,
        })),
      ) ||
      !runtimeContractEqual(
        { ...normalized.limits, inputBytes: 2_000_000 },
        a.limits,
      ) ||
      a.outputs.some(
        (o, index) =>
          o.mediaType !== mediaTypes[normalized.outputs[index]!.format] ||
          o.objectId !==
            cloudStableId(
              `managed-python-output:${binding.task.runId}:${a.origin.callId}:${index}`,
            ),
      )
    )
      throw new RuntimePolicyError('bridge_authority_changed');
  }
  for (const file of a.inputs) {
    const { getCompanyRunMaterial } = await import('./company-run-assets.ts');
    await getCompanyRunMaterial(
      {
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        ownerId: device.ownerId,
        runId: binding.task.runId,
      },
      file.objectId,
      tx,
    );
    const [reserved] =
      await tx`select id from allrice_company_asset_revisions where snapshot_object_id=${file.objectId} limit 1`;
    if (reserved) throw new RuntimePolicyError('bridge_authority_changed');
    const [object] = await tx<
      { checksum: string; size_bytes: string | number; media_type: string }[]
    >`select checksum,size_bytes,media_type from allrice_storage_objects
      where id=${file.objectId} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and state='ready'
        and deleted_at is null and (retention_until is null or retention_until>clock_timestamp())
        and (owner_id=${device.ownerId} or visibility<>'private') for share`;
    if (
      !object ||
      object.checksum !== file.checksum ||
      Number(object.size_bytes) !== file.sizeBytes ||
      object.media_type !== file.mediaType
    )
      throw new RuntimePolicyError('bridge_authority_changed');
  }
}

export async function createLocalPythonOperation(
  input: {
    selection: Awaited<ReturnType<typeof selectManagedPythonExecution>>;
    context: ExecutionContext;
    payload: RuntimeLocalPythonPayload;
    arguments: Record<string, unknown>;
  },
  db = getDatabase(),
) {
  const { selection, context: ctx } = input,
    payload = RuntimeLocalPythonPayloadSchema.parse(input.payload),
    device = selection.device;
  if (!device || selection.choice.location !== 'local')
    throw new RuntimePolicyError('local_runner_unavailable');
  if (selection.choice.status === 'wait')
    throw new RuntimePolicyError(
      selection.choice.reason === 'local_busy'
        ? 'local_runner_busy'
        : 'local_runner_preparing',
    );
  if (selection.choice.status === 'reconcile')
    throw new RuntimePolicyError('local_python_outcome_unknown');
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
    join allrice_execution_targets t on t.target_key=${`bridge.${device.id}`} and t.organization_id=r.organization_id and t.workspace_id=r.workspace_id and t.kind='rice_bridge'
    where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${ctx.policySnapshot.subjectId}`;
  const grant = await readManagedPythonRuntimeGrant(device, db);
  if (!row || !grant || grant.revokedAt)
    throw new RuntimePolicyError('bridge_authority_changed');
  const key = `managed-python:${ctx.runId}:${payload.arguments.origin.callId}`,
    operationId = selection.operationId;
  const [origin] = await db<
    { request_digest: string }[]
  >`insert into allrice_local_python_delegations(operation_id,run_id,organization_id,workspace_id,owner_id,device_id,call_id,tool_name,purpose,original_arguments,request_digest)
    values(${operationId},${ctx.runId},${ctx.organizationId},${ctx.workspaceId},${ctx.policySnapshot.subjectId},${device.id},${payload.arguments.origin.callId},
      ${payload.arguments.origin.toolName},${payload.arguments.purpose},${db.json(JSON.parse(JSON.stringify(input.arguments)))},${digest({ toolName: payload.arguments.origin.toolName, arguments: input.arguments, purpose: payload.arguments.purpose })})
    on conflict(operation_id) do update set operation_id=allrice_local_python_delegations.operation_id returning request_digest`;
  if (
    origin?.request_digest !==
    digest({
      toolName: payload.arguments.origin.toolName,
      arguments: input.arguments,
      purpose: payload.arguments.purpose,
    })
  )
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
    command: localPythonCommandBinding(payload),
    baseline: [],
    dataScope: [],
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
    database: db,
    initialOperation: { binding, payload },
  });
  const budgets = await ensureRuntimeOperationRoot(
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
    workspaceLabel: '电脑私有 Office 环境',
    deadlineAt: selection.deadlineAt,
    ledger,
  };
}

export const waitLocalPythonOperation = waitLocalCommandOperation;

/** The existing authenticated operation transfer, with exact declared object IDs. */
export async function localPythonTransferAuthority(
  token: string,
  id: string,
  leaseToken: string,
  objectId: string,
  mode: 'authorize' | 'download' | 'upload',
) {
  const { device } = await bridgeDeviceStatus(token),
    db = getDatabase();
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
  const payload = RuntimeLocalPythonPayloadSchema.parse(row.bridge_payload),
    snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  const renewed = await createGovernedBridgeOperationLedger(device)
    .heartbeat({
      scope: snapshot.binding.task.scope,
      operationId: id,
      leaseToken,
      leaseMs: 120_000,
    })
    .catch((error: unknown) => {
      if (error instanceof RuntimePolicyError)
        throw new DataAccessError('authorization_denied');
      if (error instanceof RuntimeLedgerError && error.code === 'unavailable')
        throw new DataAccessError('authorization_denied');
      if (error instanceof RuntimeLedgerError && error.code === 'lease_lost')
        throw new BridgeDataError('lease_lost');
      throw error;
    });
  if (renewed.snapshot.status !== 'running' || renewed.snapshot.cancelRequestId)
    throw new DataAccessError('authorization_denied');
  const selectedInput = payload.arguments.inputs.find(
      (i) => i.objectId === objectId,
    ),
    output = payload.arguments.outputs.find((o) => o.objectId === objectId);
  if (
    (mode === 'download' && !selectedInput) ||
    (mode === 'upload' && !output) ||
    (!selectedInput && !output)
  )
    throw new DataAccessError('authorization_denied');
  const memberships = await db<
    RequestContext['memberships']
  >`select id,user_id as "userId",organization_id as "organizationId",workspace_id as "workspaceId",role,active
    from allrice_memberships where user_id=${device.ownerId} and organization_id=${device.organizationId} and active
      and (workspace_id is null or workspace_id=${device.workspaceId}) and role in ('admin','member')`;
  if (!memberships.length) throw new DataAccessError('authorization_denied');
  const { getCompanyRunMaterial } = await import('./company-run-assets.ts');
  const companyMaterial = selectedInput
    ? await getCompanyRunMaterial(
        {
          organizationId: device.organizationId,
          workspaceId: device.workspaceId,
          ownerId: device.ownerId,
          runId: snapshot.binding.task.runId,
        },
        objectId,
        db,
      )
    : null;
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
    input: selectedInput,
    output,
    companyMaterial,
  };
}

export async function readLocalPythonInput(
  token: string,
  id: string,
  leaseToken: string,
  objectId: string,
) {
  const a = await localPythonTransferAuthority(
      token,
      id,
      leaseToken,
      objectId,
      'download',
    ),
    file = a.companyMaterial ?? (await getStoredFile(a.context, objectId));
  if (
    !a.input ||
    file.object.checksum !== a.input.checksum ||
    file.object.sizeBytes !== a.input.sizeBytes ||
    file.object.mediaType !== a.input.mediaType
  )
    throw new DataAccessError('authorization_denied');
  return { object: file.object, fileName: a.input.path.split('/').at(-1)! };
}

/** Quota must be locked before the existing root/operation lock order. */
async function assertPythonTransferInTransaction(
  tx: TransactionSql,
  authority: Awaited<ReturnType<typeof localPythonTransferAuthority>>,
  operationId: string,
  leaseToken: string,
) {
  const { device, snapshot } = authority;
  const [root] = await tx`
    select root_run_id from allrice_runtime_roots where root_run_id=${snapshot.binding.task.rootRunId}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and cancel_request_id is null and deadline_at>clock_timestamp() for update`;
  const [row] = await tx<{ snapshot: unknown; bridge_payload: unknown }[]>`
    select snapshot,bridge_payload from allrice_runtime_operations where id=${operationId}
      and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and device_id=${device.id}
      and lease_token_hash=${createHash('sha256').update(leaseToken).digest('hex')}
      and lease_expires_at>clock_timestamp() and snapshot->>'status'='running'
      and snapshot->>'cancelRequestId' is null for update`;
  if (
    !root ||
    !row ||
    !runtimeContractEqual(row.bridge_payload, authority.payload)
  )
    throw new DataAccessError('authorization_denied');
  const current = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  if (!runtimeContractEqual(current.binding, snapshot.binding))
    throw new DataAccessError('authorization_denied');
  await createRuntimePolicyAdmission(createGovernedBridgePolicyOptions(device))(
    {
      transaction: tx,
      binding: current.binding,
      phase: 'heartbeat',
      now: new Date(),
    },
  ).catch((error: unknown) => {
    if (error instanceof RuntimePolicyError)
      throw new DataAccessError('authorization_denied');
    throw error;
  });
}

async function verifiedPythonBytes(
  storage: StoragePort,
  object: StorageObject,
  maximum: number,
) {
  const reader = (await storage.get(object)).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum || size > object.sizeBytes)
        throw new DataAccessError('quota_exceeded');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length !== object.sizeBytes ||
    digestBytes(bytes) !== object.checksum
  )
    throw new DataAccessError('grant_invalid');
  return bytes;
}
const digestBytes = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function storeLocalPythonArtifact(input: {
  token: string;
  id: string;
  leaseToken: string;
  objectId: string;
  metadata: unknown;
  stream: ReadableStream<Uint8Array>;
  storage: StoragePort;
}) {
  const metadata = RuntimeLocalPythonArtifactMetadataSchema.parse(
    input.metadata,
  );
  const a = await localPythonTransferAuthority(
    input.token,
    input.id,
    input.leaseToken,
    input.objectId,
    'upload',
  ).catch(async (error: unknown) => {
    await input.stream.cancel().catch(() => undefined);
    throw error;
  });
  const output = a.output!,
    db = getDatabase();
  const validation =
    a.payload.arguments.purpose === 'office'
      ? 'dsh_office'
      : output.format === 'png'
        ? 'trusted_png'
        : 'utf8';
  if (
    metadata.mediaType !== output.mediaType ||
    metadata.validation !== validation ||
    metadata.sizeBytes > a.payload.arguments.limits.artifactBytes ||
    (output.format === 'png'
      ? metadata.png?.checksum !== metadata.checksum
      : metadata.png !== undefined)
  ) {
    await input.stream.cancel().catch(() => undefined);
    throw new DataAccessError('authorization_denied');
  }
  const reservation = await db
    .begin(async (tx) => {
      await lockWorkspaceStorageQuota(
        tx,
        a.device.organizationId,
        a.device.workspaceId,
      );
      await assertPythonTransferInTransaction(
        tx,
        a,
        input.id,
        input.leaseToken,
      );
      const [existing] = await tx<
        {
          state: string;
          checksum: string;
          size_bytes: string;
          media_type: string;
          owner_id: string;
          organization_id: string;
          workspace_id: string;
        }[]
      >`select state,checksum,size_bytes,media_type,owner_id,organization_id,workspace_id from allrice_storage_objects where id=${output.objectId} for update`;
      if (existing) {
        if (
          existing.owner_id !== a.device.ownerId ||
          existing.organization_id !== a.device.organizationId ||
          existing.workspace_id !== a.device.workspaceId ||
          existing.checksum !== metadata.checksum ||
          Number(existing.size_bytes) !== metadata.sizeBytes ||
          existing.media_type !== metadata.mediaType
        )
          throw new DataAccessError('authorization_denied');
        // A pending or abandoned identity is uncertain, never a second writer.
        if (existing.state !== 'ready')
          throw new DataAccessError('grant_invalid');
        return {
          file: await getStoredFile(a.context, output.objectId, tx),
          writer: false,
        };
      }
      const [budget] = await tx<{ bytes: string }[]>`
      select coalesce(sum(size_bytes),0) as bytes from allrice_storage_objects
      where id=any(${a.payload.arguments.outputs.map((o) => o.objectId)}::uuid[])
        and organization_id=${a.device.organizationId} and workspace_id=${a.device.workspaceId}
        and owner_id=${a.device.ownerId} and state<>'deleted'`;
      if (
        Number(budget?.bytes ?? 0) + metadata.sizeBytes >
        a.payload.arguments.limits.artifactBytes
      )
        throw new DataAccessError('quota_exceeded');
      const file = await createStorageMetadata(
        a.context,
        {
          id: output.objectId,
          workspaceId: a.device.workspaceId,
          category: 'artifacts',
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          checksum: metadata.checksum,
          visibility: 'private',
          retentionUntil: new Date(Date.now() + 86_400_000).toISOString(),
          immutable: true,
        },
        tx,
      );
      return { file, writer: true };
    })
    .catch(async (error: unknown) => {
      await input.stream.cancel().catch(() => undefined);
      throw error;
    });
  const file = reservation.file;
  if (!reservation.writer) {
    await input.stream.cancel().catch(() => undefined);
    if (output.format === 'png') {
      const bytes = await verifiedPythonBytes(
        input.storage,
        file.object,
        a.payload.arguments.limits.artifactBytes,
      );
      try {
        validatePngArtifact(bytes, metadata.png);
      } catch {
        throw new DataAccessError('grant_invalid');
      }
    }
    await localPythonTransferAuthority(
      input.token,
      input.id,
      input.leaseToken,
      input.objectId,
      'upload',
    );
    return { ...output, ...metadata, collected: true as const };
  }
  const reader = input.stream.getReader(),
    hash = createHash('sha256'),
    pngChunks: Uint8Array[] = [];
  let size = 0,
    verified = false;
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (
            size !== metadata.sizeBytes ||
            `sha256:${hash.digest('hex')}` !== metadata.checksum
          )
            throw new DataAccessError('grant_invalid');
          if (output.format === 'png') {
            try {
              validatePngArtifact(Buffer.concat(pngChunks), metadata.png);
            } catch {
              throw new DataAccessError('grant_invalid');
            }
          }
          verified = true;
          controller.close();
          return;
        }
        size += next.value.byteLength;
        if (
          size > metadata.sizeBytes ||
          size > a.payload.arguments.limits.artifactBytes
        )
          throw new DataAccessError('quota_exceeded');
        hash.update(next.value);
        if (output.format === 'png') pngChunks.push(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  try {
    await input.storage.put(file.object, bounded);
    if (!verified || !(await input.storage.exists(file.object)))
      throw new DataAccessError('grant_invalid');
    await db.begin(async (tx) => {
      await lockWorkspaceStorageQuota(
        tx,
        a.device.organizationId,
        a.device.workspaceId,
      );
      await assertPythonTransferInTransaction(
        tx,
        a,
        input.id,
        input.leaseToken,
      );
      await markStorageReady(a.context, file.object.id, tx);
    });
    return { ...output, ...metadata, collected: true as const };
  } catch (error) {
    // Commit acknowledgements can be lost. Query before deleting: never remove
    // a ready winner, or erase evidence if the database cannot confirm state.
    const abandoned = await db
      .begin(async (tx) => {
        await lockWorkspaceStorageQuota(
          tx,
          a.device.organizationId,
          a.device.workspaceId,
        );
        const [pending] =
          await tx`select id from allrice_storage_objects where id=${file.object.id}
        and organization_id=${a.device.organizationId} and workspace_id=${a.device.workspaceId} and owner_id=${a.device.ownerId}
        and state='pending' for update`;
        if (!pending) return false;
        await abandonStorageMetadata(a.context, file.object.id, tx);
        return true;
      })
      .catch(() => false);
    if (abandoned)
      await input.storage
        .delete({ ...file.object, immutable: false })
        .catch(() => undefined);
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Register only the original, stopped successful operation's ready outputs. */
export async function publishLocalPythonArtifacts(
  input: { context: ExecutionContext; operationId: string },
  storage: StoragePort,
  db = getDatabase(),
) {
  const { context: ctx } = input,
    owner = ctx.policySnapshot.subjectId;
  const read = async (sql: typeof db | TransactionSql) => {
    const [row] = await sql<
      {
        snapshot: unknown;
        bridge_payload: unknown;
        device_id: string;
        receipt: { attempt: unknown; evidence?: { output?: unknown } } | null;
      }[]
    >`
      select o.snapshot,o.bridge_payload,o.device_id,r.payload as receipt from allrice_runtime_operations o
      left join lateral (select payload from allrice_runtime_operation_receipts where operation_id=o.id and disposition='applied'
        and payload->'signal'->>'type'='operation.outcome' and payload->'signal'->'result'->>'status'='succeeded'
        order by received_at desc limit 1) r on true
      where o.id=${UuidSchema.parse(input.operationId)} and o.run_id=${ctx.runId}
        and o.organization_id=${ctx.organizationId} and o.workspace_id=${ctx.workspaceId}`;
    if (!row) throw new RuntimePolicyError('local_python_result_unconfirmed');
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot),
      payload = RuntimeLocalPythonPayloadSchema.parse(row.bridge_payload),
      result = RuntimeLocalPythonResultSchema.safeParse(
        row.receipt?.evidence?.output,
      );
    if (
      payload.arguments.purpose !== 'python_charts' ||
      snapshot.status !== 'succeeded' ||
      snapshot.cancelRequestId ||
      snapshot.binding.requestedBy.id !== owner ||
      snapshot.binding.execution.deviceId !== row.device_id ||
      snapshot.binding.task.runId !== ctx.runId ||
      !row.receipt ||
      !runtimeContractEqual(row.receipt.attempt, snapshot.binding.attempt) ||
      !result.success ||
      !result.data.stopped ||
      result.data.reason !== 'exited' ||
      result.data.exitCode !== 0 ||
      !localPythonResultMatchesPayload(payload, result.data) ||
      result.data.artifacts.length !== payload.arguments.outputs.length
    )
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    return { snapshot, payload, result: result.data, deviceId: row.device_id };
  };
  const initial = await read(db);
  const requestContext: RequestContext = {
    requestId: randomUUID(),
    sessionId: initial.snapshot.binding.task.chatSessionId!,
    actor: { type: 'user', id: owner },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    memberships: ctx.policySnapshot.memberships,
    authenticatedAt: new Date().toISOString(),
  };
  const verified: StorageObject[] = [];
  let total = 0;
  // Bounded byte validation happens before locks; final transaction rechecks all
  // immutable identities and authority, so IO never blocks cancellation.
  for (const output of initial.payload.arguments.outputs) {
    const artifact = initial.result.artifacts.find(
      (a) => a.objectId === output.objectId,
    );
    if (!artifact)
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    const { object } = await getStoredFile(requestContext, output.objectId, db);
    if (
      object.checksum !== artifact.checksum ||
      object.sizeBytes !== artifact.sizeBytes ||
      object.mediaType !== artifact.mediaType ||
      !object.immutable
    )
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    total += object.sizeBytes;
    if (total > initial.payload.arguments.limits.artifactBytes)
      throw new DataAccessError('quota_exceeded');
    const bytes = await verifiedPythonBytes(
      storage,
      object,
      initial.payload.arguments.limits.artifactBytes,
    );
    if (output.format === 'png') {
      try {
        validatePngArtifact(bytes, artifact.png);
      } catch {
        throw new RuntimePolicyError('local_python_result_unconfirmed');
      }
    }
    verified.push(object);
  }
  return db.begin(async (tx) => {
    await lockWorkspaceStorageQuota(tx, ctx.organizationId, ctx.workspaceId);
    const [root] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${initial.snapshot.binding.task.rootRunId}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}
      and cancel_request_id is null and deadline_at>clock_timestamp() for update`;
    const [operation] =
      await tx`select id from allrice_runtime_operations where id=${input.operationId}
      and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and run_id=${ctx.runId} for update`;
    if (!root || !operation)
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    const current = await read(tx);
    if (!runtimeContractEqual(initial, current))
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    const [d] = await tx<
      { device: unknown }[]
    >`select json_build_object('id',id,'organizationId',organization_id,'workspaceId',workspace_id,'ownerId',owner_id,
      'name',name,'platform',platform,'protocolVersion',protocol_version,'capabilities',capabilities,'status','online',
      'lastSeenAt',last_seen_at,'createdAt',created_at,'revokedAt',revoked_at) as device from allrice_bridge_devices
      where id=${current.deviceId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${owner} and revoked_at is null`;
    if (!d) throw new RuntimePolicyError('local_python_result_unconfirmed');
    const binding = current.snapshot.binding;
    const admission = createRuntimePolicyAdmission(
      createGovernedBridgePolicyOptions(BridgeDeviceSchema.parse(d.device)),
    );
    await admission({
      transaction: tx,
      binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    const published: {
      object: StorageObject;
      fileName: string;
      versionId: string;
    }[] = [];
    for (const [index, output] of current.payload.arguments.outputs.entries()) {
      const object = verified[index]!,
        requestId = `managed-python:${input.operationId}:${output.path}`,
        requestDigest = digest({
          objectId: object.id,
          checksum: object.checksum,
        });
      const [existing] = await tx<
        { version_id: string; request_digest: string; object_id: string }[]
      >`
        select a.version_id,a.request_digest,v.object_id from allrice_workbench_artifacts a
        join allrice_deliverable_versions v on v.id=a.version_id
        where a.organization_id=${ctx.organizationId} and a.workspace_id=${ctx.workspaceId} and a.owner_id=${owner}
          and a.run_id=${ctx.runId} and a.request_id=${requestId}`;
      if (existing) {
        if (
          existing.object_id !== object.id ||
          existing.request_digest !== requestDigest
        )
          throw new RuntimePolicyError('idempotency_conflict');
        published.push({
          object: { ...object, retentionUntil: null },
          fileName: output.fileName,
          versionId: existing.version_id,
        });
        continue;
      }
      const version = await registerToolBrokerExport(
        {
          context: ctx,
          sessionId: binding.task.chatSessionId!,
          fileName: output.fileName,
          format:
            output.format === 'png'
              ? 'png'
              : output.format === 'json'
                ? 'json'
                : 'text',
          object,
          storageMode: 'existing_ready',
        },
        tx,
      );
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)
        values(${version.id},${ctx.organizationId},${ctx.workspaceId},${owner},${ctx.runId},'file',
        ${tx.json({ kind: 'tool_result', runId: ctx.runId, operationId: input.operationId, stepId: null })},${tx.json(binding.execution)},${requestId},${requestDigest})`;
      published.push({
        object: { ...object, retentionUntil: null },
        fileName: output.fileName,
        versionId: version.id,
      });
    }
    await admission({
      transaction: tx,
      binding,
      phase: 'heartbeat',
      now: new Date(),
    });
    const [stillCurrent] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${binding.task.rootRunId}
      and cancel_request_id is null and deadline_at>clock_timestamp()`;
    if (!stillCurrent)
      throw new RuntimePolicyError('local_python_result_unconfirmed');
    return published;
  });
}
