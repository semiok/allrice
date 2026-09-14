import {
  RuntimeOperationSnapshotSchema,
  RuntimeTaskRefSchema,
  UuidSchema,
  runtimeContractEqual,
  type BridgeDevice,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import type postgres from 'postgres';
import { assertAssistantAuthority } from './assistant-authority.ts';
import type { AssistantWorkerLease } from './assistant-runtime.ts';
import { RuntimePolicyError, runtimePolicyDigest } from './runtime-policy.ts';

/** Trusted Worker-only context, never parsed from a public tool argument. */
export interface AssistantOperationOrigin {
  runId: string;
  worker: AssistantWorkerLease;
}
type Input = {
  transaction: postgres.TransactionSql;
  binding: RuntimeActionBinding;
};
const deny = (): never => {
  throw new RuntimePolicyError('assistant_authority_changed');
};

/** Resolves immutable operation provenance on EVERY reconstructed Bridge
 * ledger. No closure-only child authorization survives as an implicit grant. */
export function createAssistantOperationAuthority(
  device: BridgeDevice,
  initial?: {
    binding: RuntimeActionBinding;
    assistant?: AssistantOperationOrigin;
  },
) {
  async function resolve({ transaction: tx, binding }: Input) {
    const [row] = await tx<{ initial_snapshot: unknown }[]>`
      select initial_snapshot from allrice_runtime_operations
      where id=${binding.attempt.operationId} and organization_id=${device.organizationId}
        and workspace_id=${device.workspaceId} and device_id=${device.id}`;
    const snapshot = row
      ? RuntimeOperationSnapshotSchema.parse(row.initial_snapshot)
      : null;
    const first =
      initial?.binding.attempt.operationId === binding.attempt.operationId
        ? initial
        : undefined;
    const storedBinding = snapshot?.binding ?? first?.binding;
    const agent = snapshot
      ? snapshot.agentInstanceId
      : (first?.assistant?.runId ?? null);
    if (agent === null) {
      if (first?.assistant) deny();
      return null;
    }
    const agentId = UuidSchema.safeParse(agent);
    if (!agentId.success) return deny();
    if (
      !storedBinding ||
      !runtimeContractEqual(storedBinding, binding) ||
      (first && first.assistant?.runId !== agent) ||
      binding.action !== 'local.process.execute' ||
      binding.task.runId !== binding.task.rootRunId ||
      binding.task.parentRunId !== null ||
      agent === binding.task.rootRunId ||
      binding.task.scope.organizationId !== device.organizationId ||
      binding.task.scope.workspaceId !== device.workspaceId ||
      binding.requestedBy.type !== 'user' ||
      binding.requestedBy.id !== device.ownerId
    )
      deny();
    return { agent: agentId.data, worker: first?.assistant?.worker };
  }
  async function lockCurrentBinding(input: Input) {
    const origin = await resolve(input);
    if (!origin) return;
    const { transaction: tx, binding } = input;
    // Exactly the ledger/runtime order. Approval requests also enter here
    // before locking controls, so a delegate holding root cannot deadlock them.
    const [root] = await tx`select root_run_id from allrice_runtime_roots
      where root_run_id=${binding.task.rootRunId} and organization_id=${device.organizationId}
        and workspace_id=${device.workspaceId} for update`;
    if (!root) deny();
    const [assistant] =
      await tx`select root_run_id from allrice_assistant_roots where root_run_id=${binding.task.rootRunId} for update`;
    const [child] = await tx`select run_id from allrice_assistant_instances
      where run_id=${origin.agent} and root_run_id=${binding.task.rootRunId} and parent_run_id is not null for update`;
    if (!assistant || !child) deny();
  }
  async function assertCurrentBinding(input: Input) {
    const origin = await resolve(input);
    if (!origin) return;
    const { transaction: tx, binding } = input;
    const [root] = await tx<
      {
        worker_job_id: string;
        worker_id: string;
        worker_lease_digest: string;
        generation: string;
        fence: string;
        lease_token: string;
        lease_expires_at: Date;
        timeout_at: Date;
        task: unknown;
      }[]
    >`
      select a.worker_job_id,a.worker_id,a.worker_lease_digest,a.generation,a.fence,j.lease_token,j.lease_expires_at,j.timeout_at,l.task
      from allrice_assistant_roots a join allrice_jobs j on j.id=a.worker_job_id and j.run_id=a.root_run_id
        and j.organization_id=${device.organizationId} and j.workspace_id=${device.workspaceId} and j.owner_id=${device.ownerId}
      join allrice_runtime_run_links l on l.run_id=${origin.agent} and l.root_run_id=a.root_run_id
        and l.organization_id=j.organization_id and l.workspace_id=j.workspace_id
      where a.root_run_id=${binding.task.rootRunId} and a.revoked_at is null and j.worker_id=a.worker_id
        and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      for share of a,j,l`;
    if (!root || Number(root.generation) !== binding.attempt.generation)
      return deny();
    if (root.worker_lease_digest !== runtimePolicyDigest(root.lease_token))
      return deny();
    const worker = origin.worker;
    if (
      worker &&
      (root.worker_job_id !== worker.jobId ||
        root.worker_id !== worker.workerId ||
        root.lease_token !== worker.leaseToken ||
        Number(root.generation) !== worker.generation ||
        Number(root.fence) !== (worker.fence ?? 1))
    )
      deny();
    const task = RuntimeTaskRefSchema.parse(root.task);
    if (
      task.runId !== origin.agent ||
      task.rootRunId !== binding.task.rootRunId ||
      !task.parentRunId ||
      !runtimeContractEqual(
        { ...task, runId: task.rootRunId, parentRunId: null },
        binding.task,
      )
    )
      deny();
    const lineage = await tx<
      {
        run_id: string;
        parent_run_id: string | null;
        status: string;
        cancel_requested_at: Date | null;
        state: string;
        allowed_tools: string[];
      }[]
    >`
      with recursive ancestors as (
        select i.*,array[i.run_id] as visited from allrice_assistant_instances i where i.run_id=${origin.agent} and i.root_run_id=${task.rootRunId}
        union all select p.*,c.visited||p.run_id from allrice_assistant_instances p join ancestors c on p.run_id=c.parent_run_id
          where p.root_run_id=${task.rootRunId} and cardinality(c.visited)<4 and not p.run_id=any(c.visited)
      ) select i.run_id,i.parent_run_id,i.status,i.cancel_requested_at,i.allowed_tools,r.state from ancestors i
        join allrice_runs r on r.id=i.run_id and r.organization_id=${device.organizationId} and r.workspace_id=${device.workspaceId} and r.owner_id=${device.ownerId}`;
    if (
      !lineage.some(
        (i) => i.run_id === task.rootRunId && i.parent_run_id === null,
      ) ||
      lineage.some(
        (i) =>
          i.cancel_requested_at ||
          !['provisioning', 'running', 'waiting'].includes(i.status) ||
          i.state !== 'running' ||
          !Array.isArray(i.allowed_tools) ||
          !i.allowed_tools.includes('local.process.execute'),
      )
    )
      deny();
    try {
      await assertAssistantAuthority({
        transaction: tx,
        task,
        tools: ['local.process.execute'],
        phase: 'proposal',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'assistant_authority_denied'
      )
        deny();
      throw error;
    }
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
    if (
      !clock ||
      root.lease_expires_at <= clock.now ||
      root.timeout_at <= clock.now
    )
      deny();
  }
  return { lockCurrentBinding, assertCurrentBinding };
}
