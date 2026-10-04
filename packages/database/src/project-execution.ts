import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  BridgeDeviceSchema,
  RuntimeLocalCommandProfileSchema,
  EmployeeExecutionSnapshotSchema,
  CloudExecutionProfileSchema,
  ProjectExecuteInputSchema,
  ExecutionChoiceSchema,
  isLocalCommandProfileForPlatform,
  resolveExecutionChoice,
  runtimeContractEqual,
  type ExecutionContext,
  type ProjectExecuteInput,
  type ExecutionChoice,
  type RuntimeSavedProjectSource,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { cloudStableId, cloudExecutionEnabled } from './cloud-execution.ts';
import { localCommandEnabled } from './local-command-profile.ts';
import { bridgeCapabilityReadinessView } from './bridge-settings.ts';
import { executionRequestConstraints } from './browser-execution-choice.ts';
import { assertPublishingRun } from './artifact-review.ts';
import {
  assertSavedProjectAuthority,
  readProjectSourceMetadata,
} from './saved-project-authority.ts';

export interface ProjectExecutionSelection {
  selectionId: string;
  callId: string;
  runId: string;
  operationId: string | null;
  choice: ExecutionChoice;
  originalArguments: ProjectExecuteInput;
  argumentsDigest: string;
  sessionId: string;
  deviceId: string | null;
  targetId: string | null;
  grantId: string | null;
  profileDigest: string | null;
  workerOrigin: RuntimeSavedProjectSource['origin'];
}
export function projectProfileDigest(
  profile: ReturnType<typeof RuntimeLocalCommandProfileSchema.parse>,
) {
  // Availability changes while waiting; immutable native toolchain identity does not.
  return digest({
    image: profile.imageDigest,
    architecture: profile.architecture,
    nodeImage: profile.projectPreparation?.nodeImage,
    pythonImage: profile.projectPreparation?.pythonImage,
  });
}

/** One canonical call chooses once in the existing audit journal. No execution or new queue here. */
export async function selectProjectExecution(
  input: {
    context: ExecutionContext;
    callId: string;
    arguments: unknown;
    worker: { attempt: number; leaseToken: string };
    /** Trusted physical backend discovery from the Worker, never public/model input. */
    cloudReady: boolean;
  },
  database = getDatabase(),
): Promise<ProjectExecutionSelection> {
  const ctx = input.context,
    owner = ctx.policySnapshot.subjectId;
  const args = ProjectExecuteInputSchema.parse(input.arguments);
  if (!ctx.workspaceId || !input.callId || input.callId.length > 255)
    throw new RuntimePolicyError('invalid_tool_call');
  const selectionId = cloudStableId(
    `project-execute:${ctx.runId}:${input.callId}`,
  );
  const argumentsDigest = digest(args);
  const workerOrigin = {
    jobId: ctx.jobId,
    workerId: ctx.worker.id,
    attempt: input.worker.attempt,
    leaseTokenDigest: createHash('sha256')
      .update(input.worker.leaseToken)
      .digest('hex'),
  };
  return database.begin(async (tx) => {
    const [run] = await tx<
      {
        text: string;
        session_id: string;
        execution_snapshot: unknown;
        local_inputs: boolean;
      }[]
    >`
      select coalesce(m.content->>'text','') as text,e.session_id,e.execution_snapshot,
        exists(select 1 from allrice_runtime_operations o where o.run_id=r.id and o.organization_id=r.organization_id
          and o.workspace_id=r.workspace_id and o.snapshot->'binding'->'requestedBy'->>'id'=r.owner_id::text
          and o.snapshot->'binding'->>'action' in ('local.fs.read','local.fs.write','local.fs.changeset','local.file.inspect','local.mcp.call','local.process.execute')
          and o.bridge_payload->'arguments'->'projectSource' is null) as local_inputs
      from allrice_runs r join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
      join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
      join allrice_messages m on m.id=e.user_message_id and m.organization_id=r.organization_id and m.workspace_id=r.workspace_id and m.owner_id=r.owner_id
      where r.id=${ctx.runId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId} and r.owner_id=${owner}
        and r.state='running' and r.policy_snapshot_id=${ctx.policySnapshot.id} and j.status='running' and j.worker_id=${ctx.worker.id}
        and j.attempt=${input.worker.attempt} and j.lease_token=${input.worker.leaseToken} and j.lease_expires_at>clock_timestamp()
        and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      for update of j`;
    if (!run)
      throw new RuntimePolicyError('run_or_frozen_configuration_changed');
    await assertPublishingRun(tx, ctx, run.session_id, 'workspace.project');
    await readProjectSourceMetadata(tx, ctx, args.project.snapshot);
    const frozen = EmployeeExecutionSnapshotSchema.parse(
      run.execution_snapshot,
    );
    const tools = frozen.capabilitySnapshot.bindings.toolNames;
    const [prior] = await tx<{ metadata: ProjectExecutionSelection }[]>`
      select metadata from allrice_audit_events where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId}
        and actor_id=${owner} and action='execution.location' and resource_type='saved_project' and resource_id=${selectionId}
      order by occurred_at limit 1`;
    if (
      prior &&
      (prior.metadata.argumentsDigest !== argumentsDigest ||
        !runtimeContractEqual(prior.metadata.workerOrigin, workerOrigin))
    )
      throw new RuntimePolicyError('idempotency_conflict');
    const constraints = executionRequestConstraints(run.text);
    // A model cannot force cloud to bypass the user's local-first default.
    const location =
      constraints.location !== 'auto'
        ? constraints.location
        : args.location === 'local'
          ? 'local'
          : 'auto';
    const localOnly = constraints.localOnly || run.local_inputs;
    const [cloud] =
      input.cloudReady &&
      cloudExecutionEnabled() &&
      tools.includes('cloud.process.execute')
        ? await tx<{ id: string; target_id: string; profile: unknown }[]>`
      select g.id,g.target_id,g.profile from allrice_cloud_execution_grants g
        join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      where g.organization_id=${ctx.organizationId} and g.workspace_id=${ctx.workspaceId} and g.owner_id=${owner}
        and g.enabled and g.revoked_at is null and t.state='online' and t.kind='cloud_sandbox'
        and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())
        and (${prior?.metadata.grantId ?? null}::uuid is null or ${prior?.metadata.choice.location !== 'cloud'} or g.id=${prior?.metadata.grantId ?? null}::uuid)
      order by g.created_at desc limit 1`
        : [];
    const candidates =
      localCommandEnabled() && tools.includes('local.process.execute')
        ? await tx<
            {
              device: unknown;
              target_id: string | null;
              grant_id: string | null;
              profile: unknown;
              metadata: Record<string, unknown>;
              online: boolean;
              profile_fresh: boolean;
            }[]
          >`
      select json_build_object('id',d.id,'organizationId',d.organization_id,'workspaceId',d.workspace_id,'ownerId',d.owner_id,
        'name',d.name,'platform',d.platform,'protocolVersion',d.protocol_version,'capabilities',d.capabilities,'status','online',
        'lastSeenAt',d.last_seen_at,'createdAt',d.created_at,'revokedAt',d.revoked_at) as device,
        t.id as target_id,g.id as grant_id,p.profile,coalesce(t.metadata,'{}'::jsonb) as metadata,
        coalesce(t.state='online' and d.last_seen_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) as online,
        coalesce(p.reported_at between clock_timestamp()-interval '90 seconds' and clock_timestamp(),false) as profile_fresh
      from allrice_bridge_devices d
        left join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id and t.kind='rice_bridge' and t.target_key='bridge.'||d.id::text
        left join allrice_bridge_runtime_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
        left join allrice_bridge_managed_runtime_grants g on g.device_id=d.id and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id and g.revoked_at is null
      where d.organization_id=${ctx.organizationId} and d.workspace_id=${ctx.workspaceId} and d.owner_id=${owner} and d.revoked_at is null
        and (${prior?.metadata.deviceId ?? null}::uuid is null or d.id=${prior?.metadata.deviceId ?? null}::uuid)
      order by d.last_seen_at desc`
        : [];
    const classified = candidates.map((c) => {
      const device = BridgeDeviceSchema.parse(c.device),
        parsed = RuntimeLocalCommandProfileSchema.safeParse(c.profile);
      const discovery = bridgeCapabilityReadinessView(
        c.metadata,
        'local.process',
      );
      let state = discovery.state;
      if (!c.online) state = 'offline';
      else if (
        state !== 'preparing' &&
        state !== 'busy' &&
        (!parsed.success ||
          !isLocalCommandProfileForPlatform(device.platform, parsed.data) ||
          !parsed.data.features?.includes('saved_project_source') ||
          !parsed.data.features.includes('project_preparation'))
      )
        state = 'unsupported';
      else if (
        state === 'ready' &&
        (!parsed.success ||
          !c.profile_fresh ||
          !parsed.data.available ||
          !parsed.data.projectPreparation?.available)
      )
        state = 'preparing';
      else if (
        state !== 'preparing' &&
        state !== 'busy' &&
        (!c.grant_id || !c.target_id)
      )
        state = 'unsupported';
      return {
        ...c,
        device,
        profile: parsed.success ? parsed.data : null,
        state,
      };
    });
    const rank = [
      'ready',
      'busy',
      'preparing',
      'paused',
      'offline',
      'unsupported',
    ];
    const device = classified.sort(
      (a, b) => rank.indexOf(a.state) - rank.indexOf(b.state),
    )[0];
    const [existing] = prior?.metadata.operationId
      ? await tx<{ snapshot: unknown }[]>`
      select snapshot from allrice_runtime_operations where id=${prior.metadata.operationId} and organization_id=${ctx.organizationId}
        and workspace_id=${ctx.workspaceId} and snapshot->'binding'->'requestedBy'->>'id'=${owner} and run_id=${ctx.runId}`
      : [];
    const bound = prior?.metadata.choice.location;
    const choice = resolveExecutionChoice({
      location,
      local: device?.state ?? null,
      cloudAvailable: !!cloud,
      localInputs: localOnly,
      ...(bound === 'local' || bound === 'cloud'
        ? { boundLocation: bound }
        : {}),
      outcomeUnknown:
        (existing?.snapshot as { status?: string } | undefined)?.status ===
        'unknown',
    });
    const side = choice.location;
    if (side !== 'none')
      await assertSavedProjectAuthority(
        tx,
        ctx,
        run.session_id,
        workerOrigin,
        args.project,
        side === 'local' ? 'local.process.execute' : 'cloud.process.execute',
      );
    const selection: ProjectExecutionSelection = {
      selectionId,
      callId: input.callId,
      runId: ctx.runId,
      operationId:
        side === 'none'
          ? null
          : cloudStableId(
              `${side === 'local' ? 'local-command' : 'cloud-project'}:${ctx.runId}:${input.callId}`,
            ),
      choice,
      originalArguments: args,
      argumentsDigest,
      sessionId: run.session_id,
      deviceId: side === 'local' ? (device?.device.id ?? null) : null,
      targetId:
        side === 'local'
          ? (device?.target_id ?? null)
          : (cloud?.target_id ?? null),
      grantId:
        side === 'local' ? (device?.grant_id ?? null) : (cloud?.id ?? null),
      profileDigest:
        side === 'local'
          ? device?.profile
            ? projectProfileDigest(device.profile)
            : null
          : cloud
            ? digest(CloudExecutionProfileSchema.parse(cloud.profile))
            : null,
      workerOrigin,
    };
    if (prior) {
      if (
        side === 'local' &&
        prior.metadata.choice.location === 'local' &&
        !existing &&
        (!prior.metadata.grantId || !prior.metadata.profileDigest)
      ) {
        const completed = {
          ...prior.metadata,
          grantId: selection.grantId,
          targetId: selection.targetId,
          profileDigest: selection.profileDigest,
          choice: ExecutionChoiceSchema.parse(choice),
        };
        await tx`update allrice_audit_events set metadata=${tx.json(completed as unknown as Parameters<typeof tx.json>[0])}
          where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and actor_id=${owner}
            and action='execution.location' and resource_type='saved_project' and resource_id=${selectionId}`;
        return completed;
      }
      return { ...prior.metadata, choice: ExecutionChoiceSchema.parse(choice) };
    }
    if (
      side !== 'none' &&
      selection.operationId &&
      (side !== 'cloud' || selection.grantId)
    )
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
        values(${ctx.organizationId},${ctx.workspaceId},${owner},'execution.location','saved_project',${selectionId},'recorded',${choice.reason},${tx.json(selection as unknown as Parameters<typeof tx.json>[0])})`;
    return selection;
  });
}

/** Compare the canonical call to the actual backend command, at every authority boundary. */
export async function assertProjectExecutionOrigin(
  tx: TransactionSql,
  binding: RuntimeActionBinding,
  command: {
    projectSource?: RuntimeSavedProjectSource;
    projectPreparation?: unknown;
    executable: string;
    args: string[];
    path: string;
    limits: unknown;
  },
  location: 'local' | 'cloud',
) {
  const source = command.projectSource,
    origin = source?.executionOrigin;
  if (!origin) return; // Existing explicit local source execution retains its own checks.
  const [row] = await tx<{ metadata: ProjectExecutionSelection }[]>`
    select metadata from allrice_audit_events where organization_id=${binding.task.scope.organizationId}
      and workspace_id=${binding.task.scope.workspaceId} and actor_id=${binding.requestedBy.id} and action='execution.location'
      and resource_type='saved_project' and resource_id=${origin.selectionId} order by occurred_at limit 1`;
  const selection = row?.metadata;
  const fail = () => {
    throw new RuntimePolicyError('project_execution_origin_changed');
  };
  if (
    !selection ||
    selection.callId !== origin.callId ||
    selection.runId !== binding.task.runId ||
    selection.argumentsDigest !== origin.argumentsDigest ||
    selection.choice.location !== location ||
    selection.operationId !== binding.attempt.operationId ||
    selection.deviceId !== binding.execution.deviceId ||
    selection.targetId !== binding.execution.targetId ||
    selection.grantId !== binding.execution.grantId ||
    !runtimeContractEqual(selection.workerOrigin, source.origin) ||
    selection.selectionId !== origin.selectionId
  )
    fail();
  const args = ProjectExecuteInputSchema.parse(selection!.originalArguments);
  if (
    digest(args) !== origin.argumentsDigest ||
    !runtimeContractEqual(
      {
        project: args.project,
        projectPreparation: args.projectPreparation,
        executable: args.executable,
        args: args.args,
        path: args.path,
        limits: args.limits,
      },
      {
        project: source.project,
        projectPreparation: command.projectPreparation,
        executable: command.executable,
        args: command.args,
        path: command.path,
        limits: command.limits,
      },
    )
  )
    fail();
}
