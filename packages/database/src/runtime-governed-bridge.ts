import { randomUUID } from 'node:crypto';

import {
  RuntimeBridgePayloadSchema,
  RuntimeLocalCommandProfileSchema,
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  isLocalCommandProfileForPlatform,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  isRuntimeRelativePath,
  runtimeContractEqual,
  McpError,
  type RuntimeBridgePayload,
  type BridgeDevice,
  type RuntimeActionBinding,
} from '@allrice/contracts';

import { getDatabase } from './core/client.ts';
import { assertLocalMcpAuthority } from './local-mcp-connections.ts';
import { localMcpCommandBinding } from './local-mcp-execution.ts';
import { readArtifact } from './artifact-review.ts';
import {
  localCommandBinding,
  localCommandEnabled,
} from './local-command-profile.ts';
import {
  createRuntimeOperationLedger,
  RuntimeLedgerError,
} from './runtime-ledger/index.ts';
import {
  createRuntimePolicyAdmission,
  runtimePolicyDigest,
  RuntimePolicyError,
  type RuntimePolicyOptions,
} from './runtime-policy.ts';

// Expected authority outcomes are unavailable work, not a broken queue. SQL,
// malformed persisted policy/bindings and unknown adapter failures stay visible.
const unavailablePolicyCodes = new Set([
  'approval_required',
  'approval_invalid_or_stale',
  'approval_already_consumed',
  'approval_not_consumed',
  'membership_denied',
  'identity_denied',
  'run_or_frozen_configuration_changed',
  'frozen_policy_invalid',
  'frozen_policy_permission_denied',
  'target_unavailable',
  'grant_revoked_or_changed',
  'execution_binding_changed',
  'binding_scope_mismatch',
  'resource_adapter_not_registered',
  'runtime_policy_disabled',
  'platform_deny',
  'tenant_deny',
  'plan_only',
  'no_matching_policy',
  'action_not_registered',
  'bridge_authority_changed',
]);

/** Server-owned assembly. This is not an HTTP authorization/budget-install API.
 * initialOperation is a trusted Tool Broker input, never an echoed browser binding.
 * Existing operations always resolve from immutable PostgreSQL input, not this closure.
 */
export function createGovernedBridgeOperationLedger(
  deviceInput: BridgeDevice,
  options: {
    database?: ReturnType<typeof getDatabase>;
    requestId?: string;
    initialOperation?: {
      binding: RuntimeActionBinding;
      payload: RuntimeBridgePayload;
    };
  } = {},
) {
  const policyOptions = createGovernedBridgePolicyOptions(deviceInput, options);
  const admission = createRuntimePolicyAdmission(policyOptions);
  const ledger = createRuntimeOperationLedger({
    database: options.database ?? getDatabase(),
    admission: async (input) => {
      try {
        return await admission(input);
      } catch (error) {
        if (
          error instanceof RuntimePolicyError &&
          unavailablePolicyCodes.has(error.code)
        )
          throw new RuntimeLedgerError('unavailable');
        throw error;
      }
    },
  });
  return { ...ledger, policyOptions };
}

/** The same production authority resolver, without creating a second database
 * client or ledger. Callers must supply their current transaction to resolve. */
export function createGovernedBridgePolicyOptions(
  deviceInput: BridgeDevice,
  options: {
    requestId?: string;
    initialOperation?: {
      binding: RuntimeActionBinding;
      payload: RuntimeBridgePayload;
    };
  } = {},
) {
  const device = BridgeDeviceSchema.parse(deviceInput);
  const initial = options.initialOperation
    ? {
        binding: RuntimeActionBindingSchema.parse(
          options.initialOperation.binding,
        ),
        payload: RuntimeBridgePayloadSchema.parse(
          options.initialOperation.payload,
        ),
      }
    : null;
  const context = {
    actor: { type: 'user' as const, id: device.ownerId },
    organizationId: device.organizationId,
    workspaceId: device.workspaceId,
    requestId: options.requestId ?? randomUUID(),
  };
  const policyOptions: RuntimePolicyOptions = {
    context,
    async resolveCurrentBinding({ transaction: tx, binding: requested }) {
      // Immutable inputs have a DB trigger. Plain SELECT avoids the inverse
      // controls→operation lock order in approval creation/decision transactions.
      const [row] = await tx<
        { initial_snapshot: unknown; bridge_payload: unknown }[]
      >`
        select initial_snapshot, bridge_payload from allrice_runtime_operations
        where id=${requested.attempt.operationId} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} and device_id=${device.id}`;
      const stored = row
        ? {
            binding: RuntimeOperationSnapshotSchema.parse(row.initial_snapshot)
              .binding,
            payload: RuntimeBridgePayloadSchema.parse(row.bridge_payload),
          }
        : initial?.binding.attempt.operationId === requested.attempt.operationId
          ? initial
          : null;
      if (!stored) throw new RuntimePolicyError('bridge_authority_changed');
      const { binding, payload } = stored;
      const command =
        payload.capability === 'local.process.execute' ? payload : null;
      const mcp =
        payload.capability === 'local.mcp.discover' ||
        payload.capability === 'local.mcp.call'
          ? payload
          : null;
      const changeset =
        payload.capability === 'local.fs.changeset' ? payload : null;
      if (
        binding.task.scope.organizationId !== device.organizationId ||
        binding.task.scope.workspaceId !== device.workspaceId ||
        binding.task.scope.projectId !== null ||
        binding.execution.deviceId !== device.id ||
        binding.execution.targetKind !== 'rice_bridge' ||
        (!command && !mcp && binding.command !== null) ||
        binding.dataScope.length ||
        binding.baseline.length
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      // This checks syntax, not OS confinement; local realpath/CAS remains mandatory.
      const directoryRoot =
        payload.arguments.path === '.' &&
        [
          'local.fs.list',
          'local.fs.search',
          'local.git.status',
          'local.git.diff',
          'local.process.execute',
          'local.fs.changeset',
          'local.mcp.discover',
          'local.mcp.call',
        ].includes(payload.capability);
      if (
        (!directoryRoot && !isRuntimeRelativePath(payload.arguments.path)) ||
        (payload.capability === 'local.fs.write' &&
          payload.arguments.expectedSha256 === undefined)
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      const [currentDevice] = await tx<
        {
          platform: string;
          capabilities: string[];
          last_seen_at: Date | null;
          revoked_at: Date | null;
        }[]
      >`select platform,capabilities,last_seen_at,revoked_at from allrice_bridge_devices
        where id=${device.id} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} for share`;
      const [grant] = await tx<
        {
          id: string;
          root_fingerprint: string;
          runtime_generation: number;
          revoked_at: Date | null;
        }[]
      >`select id,root_fingerprint,runtime_generation,revoked_at from allrice_bridge_folder_grants
        where id=${binding.execution.grantId} and device_id=${device.id}
          and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
          and owner_id=${device.ownerId} for share`;
      const targetCapability = payload.capability.startsWith('local.git.')
        ? 'git.read'
        : ['local.fs.write', 'local.fs.mkdir', 'local.fs.changeset'].includes(
              payload.capability,
            )
          ? 'files.write'
          : 'files.read';
      const [target] = await tx<
        { id: string; kind: string; state: string; capabilities: string[] }[]
      >`
        select id,kind,state,capabilities from allrice_execution_targets
        where id=${binding.execution.targetId} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} and target_key=${`bridge.${device.id}`}
          and metadata->>'bridgeDeviceId'=${device.id} for share`;
      if (
        !currentDevice ||
        currentDevice.revoked_at ||
        (!command &&
          !mcp &&
          !changeset &&
          !currentDevice.capabilities.includes(payload.capability)) ||
        (changeset && !currentDevice.capabilities.includes('local.fs.write')) ||
        !grant ||
        grant.revoked_at ||
        !target ||
        target.kind !== 'rice_bridge' ||
        target.state !== 'online' ||
        (!command && !mcp && !target.capabilities.includes(targetCapability))
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      const [run] = await tx<
        {
          id: string;
          execution_spec: Record<string, unknown>;
          policy_snapshot_id: string;
          state: string;
        }[]
      >`select id,execution_spec,policy_snapshot_id,state from allrice_runs
        where id=${binding.task.runId} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} and owner_id=${device.ownerId} for share`;
      if (
        !run ||
        !['queued', 'running', 'waiting_approval'].includes(run.state)
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      let profileReportedAt: Date | null = null;
      if (command || mcp) {
        if (
          !localCommandEnabled() ||
          device.platform !== currentDevice.platform
        )
          throw new RuntimePolicyError('bridge_authority_changed');
        const [reported] = await tx<{ profile: unknown; reported_at: Date }[]>`
          select profile,reported_at from allrice_bridge_runtime_profiles
          where device_id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} for share`;
        const profile = RuntimeLocalCommandProfileSchema.safeParse(
          reported?.profile,
        );
        const [current] = await tx<
          { now: Date }[]
        >`select clock_timestamp() as now`;
        if (
          !reported ||
          !profile.success ||
          !profile.data.available ||
          (mcp &&
            (process.env.ALLRICE_LOCAL_MCP_ENABLED !== '1' ||
              !profile.data.features?.includes('local_mcp'))) ||
          (command?.arguments.background &&
            (process.env.ALLRICE_LOCAL_SERVICE_ENABLED !== '1' ||
              !profile.data.features?.includes('background_services'))) ||
          (command?.arguments.dependencies &&
            !profile.data.features?.includes('npm_dependencies')) ||
          (command?.arguments.diagnostics &&
            !profile.data.features?.includes('project_diagnostics')) ||
          !isLocalCommandProfileForPlatform(
            currentDevice.platform,
            profile.data,
          ) ||
          profile.data.imageDigest !==
            (command ?? mcp)!.arguments.imageDigest ||
          !current ||
          reported.reported_at.getTime() <= current.now.getTime() - 90_000 ||
          reported.reported_at > current.now
        )
          throw new RuntimePolicyError('bridge_authority_changed');
        profileReportedAt = reported.reported_at;
        if (command?.arguments.background) {
          const [active] = await tx<
            { n: number; same_run: number }[]
          >`select count(*)::int as n,count(*) filter(where o.run_id=${binding.task.runId})::int as same_run
            from allrice_local_services s join allrice_runtime_operations o on o.id=s.operation_id
            where o.device_id=${device.id} and o.id<>${binding.attempt.operationId} and s.hard_deadline_at>clock_timestamp()
              and o.snapshot->>'status' in ('running','dispatched','cancel_requested')`;
          if ((active?.n ?? 0) >= 2 || (active?.same_run ?? 0) >= 1)
            throw new RuntimePolicyError('bridge_authority_changed');
        }
      }
      const [policy] = await tx<
        { payload: unknown }[]
      >`select payload from allrice_policy_snapshots
        where id=${run.policy_snapshot_id} and organization_id=${device.organizationId}
          and subject_id=${device.ownerId} for share`;
      if (!policy) throw new RuntimePolicyError('bridge_authority_changed');
      const [employee] = await tx<
        {
          employee_version_id: string;
          session_id: string;
          owner_id: string;
          execution_snapshot: unknown;
        }[]
      >`
        select employee_version_id,session_id,owner_id,execution_snapshot from allrice_employee_runs
        where run_id=${run.id} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} for share`;
      if (
        (employee && employee.owner_id !== device.ownerId) ||
        (run.execution_spec.employeeVersionId ?? null) !==
          (employee?.employee_version_id ?? null)
      )
        throw new RuntimePolicyError('bridge_authority_changed');
      if (command || mcp) {
        // Permissions come from the Run's frozen employee snapshot, not a
        // client-supplied action or the employee's mutable current definition.
        const frozen = EmployeeExecutionSnapshotSchema.safeParse(
          employee?.execution_snapshot,
        );
        if (
          !frozen.success ||
          frozen.data.employee.versionId !== employee?.employee_version_id ||
          frozen.data.tenantContext.organizationId !== device.organizationId ||
          frozen.data.tenantContext.workspaceId !== device.workspaceId ||
          frozen.data.tenantContext.actorId !== device.ownerId ||
          frozen.data.tenantContext.policySnapshotId !==
            run.policy_snapshot_id ||
          frozen.data.assignment.userId !== device.ownerId ||
          !frozen.data.capabilitySnapshot.bindings.toolNames.includes(
            payload.capability,
          ) ||
          !frozen.data.capabilitySnapshot.grantedCapabilities.includes(
            'storage:write',
          ) ||
          (command?.arguments.dependencies?.packages.some(
            (p) => !p.archivePath,
          ) &&
            !frozen.data.capabilitySnapshot.grantedCapabilities.includes(
              'network:outbound',
            ))
        )
          throw new RuntimePolicyError('bridge_authority_changed');
        if (mcp) {
          if (frozen.data.schemaVersion !== 2)
            throw new RuntimePolicyError('bridge_authority_changed');
          const frozenConnection = frozen.data.localMcp?.connections.find(
            (c) => c.connectionId === mcp.arguments.connectionId,
          );
          if (
            !frozenConnection ||
            !frozen.data.capabilitySnapshot.grantedCapabilities.includes(
              'secret:use',
            ) ||
            frozenConnection.folderGrantId !== binding.execution.grantId ||
            frozenConnection.folderGrantVersion !==
              binding.execution.grantVersion
          )
            throw new RuntimePolicyError('bridge_authority_changed');
          if (
            mcp.capability === 'local.mcp.call' &&
            !frozen.data.localMcp?.tools.some((t) =>
              runtimeContractEqual(t, mcp.arguments.tool),
            )
          )
            throw new RuntimePolicyError('bridge_authority_changed');
          try {
            await assertLocalMcpAuthority(
              tx,
              {
                organizationId: device.organizationId,
                workspaceId: device.workspaceId,
                actorId: device.ownerId,
              },
              frozenConnection,
              mcp,
              employee!.employee_version_id,
            );
          } catch (error) {
            if (error instanceof McpError)
              throw new RuntimePolicyError('bridge_authority_changed');
            throw error;
          }
        }
      }
      if (changeset) {
        const frozen = EmployeeExecutionSnapshotSchema.safeParse(
          employee?.execution_snapshot,
        );
        const [application] = await tx<
          {
            artifact_id: string;
            checksum: string;
            restore_of: string | null;
            session_id: string;
          }[]
        >`
          select artifact_id,checksum,restore_of,session_id from allrice_changeset_runs where run_id=${run.id}
          and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and actor_id=${device.ownerId}`;
        if (
          process.env.ALLRICE_CHANGESET_ENABLED !== '1' ||
          process.env.ALLRICE_WORKBENCH_ENABLED !== '1' ||
          !application ||
          !frozen.success ||
          frozen.data.schemaVersion !== 2 ||
          !frozen.data.capabilitySnapshot.grantedCapabilities.includes(
            'storage:write',
          ) ||
          !frozen.data.capabilitySnapshot.bindings.toolNames.includes(
            'local.fs.write',
          ) ||
          application.artifact_id !== changeset.arguments.artifactId ||
          application.checksum !== changeset.arguments.checksum ||
          (application.restore_of !== null) !==
            (changeset.arguments.direction === 'restore')
        )
          throw new RuntimePolicyError('bridge_authority_changed');
        const artifact = await readArtifact(
          tx,
          context,
          application.session_id,
          application.artifact_id,
        ).catch(() => {
          throw new RuntimePolicyError('bridge_authority_changed');
        });
        if (
          artifact.kind !== 'changeset' ||
          artifact.object.checksum !== application.checksum ||
          (!application.restore_of && artifact.stale) ||
          !artifact.execution ||
          !runtimeContractEqual(artifact.execution, binding.execution)
        )
          throw new RuntimePolicyError('bridge_authority_changed');
      }
      let generation = 0;
      if (employee) {
        const [session] = await tx<
          { id: string; employee_version_id: string }[]
        >`
          select id,employee_version_id from allrice_chat_sessions where id=${employee.session_id}
            and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
            and owner_id=${device.ownerId} and archived_at is null and project_id is null for share`;
        const [runtime] = await tx<{ thread_generation: number }[]>`
          select thread_generation from allrice_conversation_runtimes where session_id=${employee.session_id}
            and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
            and owner_id=${device.ownerId} and state='running' and active_run_id=${run.id} for share`;
        if (
          !session ||
          session.employee_version_id !== employee.employee_version_id ||
          !runtime
        )
          throw new RuntimePolicyError('bridge_authority_changed');
        generation = runtime.thread_generation;
      }
      // All locks/waits precede this temporal check; the initiating JS timestamp is not authority.
      const job =
        command || mcp || changeset
          ? (
              await tx<
                {
                  status: string;
                  cancel_requested_at: Date | null;
                  timeout_at: Date;
                  lease_expires_at: Date | null;
                }[]
              >`
        select status,cancel_requested_at,timeout_at,lease_expires_at from allrice_jobs
        where run_id=${run.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId} and owner_id=${device.ownerId}`
            )[0]
          : null;
      const [clock] = await tx<
        { now: Date }[]
      >`select clock_timestamp() as now`;
      if (
        !clock ||
        !currentDevice.last_seen_at ||
        currentDevice.last_seen_at.getTime() <= clock.now.getTime() - 90_000 ||
        currentDevice.last_seen_at > clock.now ||
        ((command || mcp || changeset) &&
          (!job ||
            job.status !== 'running' ||
            job.cancel_requested_at ||
            !job.lease_expires_at ||
            job.lease_expires_at <= clock.now ||
            job.timeout_at <= clock.now ||
            ((command || mcp) &&
              (!profileReportedAt ||
                profileReportedAt.getTime() <= clock.now.getTime() - 90_000 ||
                profileReportedAt > clock.now))))
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      return RuntimeActionBindingSchema.parse({
        ...binding,
        task: {
          ...binding.task,
          chatSessionId: employee?.session_id ?? null,
          scope: {
            organizationId: device.organizationId,
            workspaceId: device.workspaceId,
            projectId: null,
          },
          frozenConfiguration: {
            employeeVersionId: employee?.employee_version_id ?? null,
            digest: runtimePolicyDigest(run.execution_spec),
          },
        },
        attempt: { ...binding.attempt, generation },
        requestedBy: context.actor,
        policy: {
          snapshotId: run.policy_snapshot_id,
          digest: runtimePolicyDigest(policy.payload),
        },
        execution: {
          targetId: target.id,
          targetKind: 'rice_bridge',
          deviceId: device.id,
          grantId: grant.id,
          grantVersion: grant.runtime_generation,
          scopeDigest: `sha256:${grant.root_fingerprint}`,
          workCopy:
            command || mcp
              ? { id: binding.attempt.operationId, kind: 'local_copy' }
              : { id: grant.id, kind: 'in_place' },
        },
        action: payload.capability,
        inputDigest: runtimePolicyDigest(payload),
        command: command
          ? localCommandBinding(command)
          : mcp
            ? localMcpCommandBinding(mcp)
            : null,
        baseline: [],
        dataScope: [],
      });
    },
  };
  return policyOptions;
}
