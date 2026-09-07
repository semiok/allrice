import { randomUUID } from 'node:crypto';

import {
  BridgeCommandPayloadSchema,
  BridgeDeviceSchema,
  RuntimeActionBindingSchema,
  RuntimeOperationSnapshotSchema,
  isRuntimeRelativePath,
  type BridgeCommandPayload,
  type BridgeDevice,
  type RuntimeActionBinding,
} from '@allrice/contracts';

import { getDatabase } from './core/client.ts';
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
      payload: BridgeCommandPayload;
    };
  } = {},
) {
  const device = BridgeDeviceSchema.parse(deviceInput);
  const database = options.database ?? getDatabase();
  const initial = options.initialOperation
    ? {
        binding: RuntimeActionBindingSchema.parse(
          options.initialOperation.binding,
        ),
        payload: BridgeCommandPayloadSchema.parse(
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
            payload: BridgeCommandPayloadSchema.parse(row.bridge_payload),
          }
        : initial?.binding.attempt.operationId === requested.attempt.operationId
          ? initial
          : null;
      if (!stored) throw new RuntimePolicyError('bridge_authority_changed');
      const { binding, payload } = stored;
      if (
        binding.task.scope.organizationId !== device.organizationId ||
        binding.task.scope.workspaceId !== device.workspaceId ||
        binding.task.scope.projectId !== null ||
        binding.execution.deviceId !== device.id ||
        binding.execution.targetKind !== 'rice_bridge' ||
        binding.command !== null ||
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
        ].includes(payload.capability);
      if (
        (!directoryRoot && !isRuntimeRelativePath(payload.arguments.path)) ||
        (payload.capability === 'local.fs.write' &&
          payload.arguments.expectedSha256 === undefined)
      )
        throw new RuntimePolicyError('bridge_authority_changed');

      const [currentDevice] = await tx<
        {
          capabilities: string[];
          last_seen_at: Date | null;
          revoked_at: Date | null;
        }[]
      >`select capabilities,last_seen_at,revoked_at from allrice_bridge_devices
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
        : ['local.fs.write', 'local.fs.mkdir'].includes(payload.capability)
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
        !currentDevice.capabilities.includes(payload.capability) ||
        !grant ||
        grant.revoked_at ||
        !target ||
        target.kind !== 'rice_bridge' ||
        target.state !== 'online' ||
        !target.capabilities.includes(targetCapability)
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
      const [policy] = await tx<
        { payload: unknown }[]
      >`select payload from allrice_policy_snapshots
        where id=${run.policy_snapshot_id} and organization_id=${device.organizationId}
          and subject_id=${device.ownerId} for share`;
      if (!policy) throw new RuntimePolicyError('bridge_authority_changed');
      const [employee] = await tx<
        { employee_version_id: string; session_id: string; owner_id: string }[]
      >`
        select employee_version_id,session_id,owner_id from allrice_employee_runs
        where run_id=${run.id} and organization_id=${device.organizationId}
          and workspace_id=${device.workspaceId} for share`;
      if (
        (employee && employee.owner_id !== device.ownerId) ||
        (run.execution_spec.employeeVersionId ?? null) !==
          (employee?.employee_version_id ?? null)
      )
        throw new RuntimePolicyError('bridge_authority_changed');
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
      const [clock] = await tx<
        { now: Date }[]
      >`select clock_timestamp() as now`;
      if (
        !clock ||
        !currentDevice.last_seen_at ||
        currentDevice.last_seen_at.getTime() <= clock.now.getTime() - 90_000 ||
        currentDevice.last_seen_at > clock.now
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
          workCopy: { id: grant.id, kind: 'in_place' },
        },
        action: payload.capability,
        inputDigest: runtimePolicyDigest(payload),
        command: null,
        baseline: [],
        dataScope: [],
      });
    },
  };
  const admission = createRuntimePolicyAdmission(policyOptions);
  const ledger = createRuntimeOperationLedger({
    database,
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
