import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type createCloudCommandOperation,
  createCloudOperationLedger,
  loadCloudCommandInputs,
  publishCloudOperationArtifacts,
  cloudStableId,
  getDatabase,
  runtimePolicyDigest,
  taskDeadlineOpen,
} from '@allrice/database';
import {
  CloudCommandSchema,
  RuntimeOperationSnapshotSchema,
  type StoragePort,
  type RuntimeUsageObservation,
} from '@allrice/contracts';
import { CloudRunnerBackend, type CloudRunResult } from './backend.js';

type Created = Awaited<ReturnType<typeof createCloudCommandOperation>>;
type Db = ReturnType<typeof getDatabase>;
async function currentWorker(created: Created, db: Db) {
  const c = created.context;
  const [row] =
    await db`select id from allrice_jobs where id=${c.jobId} and run_id=${c.runId} and organization_id=${c.organizationId} and workspace_id=${c.workspaceId} and owner_id=${c.policySnapshot.subjectId} and worker_id=${c.worker.id} and lease_token::text=${created.jobLeaseToken} and status='running' and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() and cancel_requested_at is null`;
  return !!row;
}

/** No agent loop. One exact cloud operation, with persisted authority/recovery.
 * Re-entry may collect existing stopped work but never replay a started script. */
export async function runCloudCommandOperation(
  created: Created,
  options: {
    storage: StoragePort;
    signal?: AbortSignal;
    backend?: CloudRunnerBackend;
    database?: Db;
  },
) {
  const db = options.database ?? getDatabase(),
    backend = options.backend ?? new CloudRunnerBackend(),
    { ledger, payload } = created;
  const { binding } = created.snapshot,
    scope = binding.task.scope,
    operationId = binding.attempt.operationId,
    attemptId = binding.attempt.attemptId;
  const [prior] = await db<
    {
      lease_token: string;
      container_id: string | null;
      outcome: CloudRunResult | null;
      cleanup_confirmed_at: Date | null;
    }[]
  >`select lease_token,container_id,outcome,cleanup_confirmed_at from allrice_cloud_execution_attempts where operation_id=${operationId}`;
  let leaseToken = prior?.lease_token;
  const cancel = () =>
    ledger.cancelRoot(scope, binding.task.rootRunId, randomUUID());
  if (!leaseToken) {
    while (
      await taskDeadlineOpen(db, binding.task.rootRunId, created.deadlineAt)
    ) {
      if (options.signal?.aborted || !(await currentWorker(created, db))) {
        if (options.signal?.aborted) await cancel();
        return {
          operationId,
          status: options.signal?.aborted ? 'cancel_requested' : 'blocked',
          artifacts: [],
          output: '',
        };
      }
      try {
        const lease = await ledger.dispatch({
          scope,
          operationId,
          leaseOwner: created.context.worker.id,
          leaseMs: 15_000,
        });
        leaseToken = lease.leaseToken;
        break;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (
          ![
            'approval_invalid_or_stale',
            'approval_required',
            'cloud_capacity_unavailable',
          ].includes(code)
        )
          throw error;
        const [approval] = await db<
          { status: string; expired: boolean; revoked: boolean }[]
        >`select status,runtime_expires_at<=clock_timestamp() as expired,runtime_revoked_at is not null as revoked from allrice_approval_requests where resource_id=${operationId} and resource_type='runtime_operation'`;
        if (
          approval &&
          (approval.status === 'rejected' ||
            approval.expired ||
            approval.revoked)
        ) {
          return {
            operationId,
            status: 'blocked',
            artifacts: [],
            output: '',
          };
        }
        await delay(200);
      }
    }
  }
  if (!leaseToken) {
    await cancel();
    return {
      operationId,
      status: 'cancel_requested',
      artifacts: [],
      output: '',
    };
  }
  const receipt = { scope, operationId, leaseToken, attempt: binding.attempt };
  const maintainLease = async () => {
    if (options.signal?.aborted || !(await currentWorker(created, db))) {
      if (options.signal?.aborted) await cancel();
      return false;
    }
    try {
      await ledger.heartbeat({ ...receipt, leaseMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  };
  let outcome = prior?.outcome;
  if (!outcome) {
    const started = await ledger
      .startOperation({
        ...receipt,
        receiptId: cloudStableId(`${operationId}:start`),
      })
      .catch(() => null);
    if (!started?.mayExecute) {
      // Even without a recorded container ID the deterministic attempt name can
      // resolve create-ACK loss. Missing container is unknown, never permission to rerun.
      const container = await backend.inspect(attemptId);
      if (container?.State.Running) await backend.stop(attemptId);
      if (container)
        outcome = await backend.collect(
          attemptId,
          payload,
          Date.now(),
          container.State.Running ? 'unknown' : 'completed',
        );
      else {
        await ledger.recordReceipt({
          ...receipt,
          receiptId: cloudStableId(`${operationId}:unknown`),
          signal: { type: 'operation.uncertain', reason: 'receipt_missing' },
        });
        await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp() where operation_id=${operationId}`;
        return { operationId, status: 'unknown', artifacts: [], output: '' };
      }
    } else {
      try {
        const files = await loadCloudCommandInputs(
          created.context,
          payload,
          options.storage,
        );
        outcome = await backend.execute(payload, files, {
          attemptId,
          deadlineAt: created.deadlineAt,
          ...(options.signal ? { signal: options.signal } : {}),
          maintainLease,
          onCreated: async (id) => {
            await db`update allrice_cloud_execution_attempts set container_id=${id} where operation_id=${operationId} and container_id is null`;
          },
        });
      } catch (error) {
        let absenceConfirmed = false;
        const container = await backend
          .inspect(attemptId)
          .then((c) => {
            absenceConfirmed = c === null;
            return c;
          })
          .catch(() => null);
        if (container) {
          await backend.stop(attemptId).catch(() => false);
          outcome = await backend
            .collect(attemptId, payload, Date.now(), 'unknown')
            .catch(() => null);
        }
        if (!outcome) {
          await ledger.recordReceipt({
            ...receipt,
            receiptId: cloudStableId(`${operationId}:unknown`),
            signal: { type: 'operation.uncertain', reason: 'receipt_missing' },
            evidence: {
              code:
                error instanceof Error
                  ? error.message
                  : 'cloud_execution_failed',
            },
          });
          if (absenceConfirmed)
            await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp() where operation_id=${operationId}`;
          return { operationId, status: 'unknown', artifacts: [], output: '' };
        }
      }
    }
    await db`update allrice_cloud_execution_attempts set outcome=${db.json(outcome)} where operation_id=${operationId} and outcome is null`;
  }
  // No deletion until durable bytes/versions AND result receipt. Failed writes
  // leave the stopped container, daemon logs and journal available for recovery.
  const artifacts =
    outcome.reason === 'completed'
      ? await publishCloudOperationArtifacts(
          {
            context: created.context,
            binding,
            payload,
            artifacts: outcome.artifacts,
          },
          options.storage,
          db,
        )
      : [];
  const evidence = {
    id: cloudStableId(`${operationId}:evidence`),
    recordedAt: new Date().toISOString(),
    digest: runtimePolicyDigest({ outcome, artifacts }),
  };
  const summary = {
    backend: 'cloud-gvisor-v1',
    workCopy: 'cloud_copy',
    exitCode: outcome.exitCode,
    reason: outcome.reason,
    stopped: outcome.stopped,
    output: outcome.output,
    artifacts: artifacts.map((a) => ({
      objectId: a.object.id,
      versionId: a.versionId,
      fileName: a.fileName,
      checksum: a.object.checksum,
    })),
  };
  const stopped = ['canceled', 'deadline'].includes(outcome.reason);
  const signal = stopped
    ? { type: 'operation.stopped' as const, evidence, effects: 'none' as const }
    : outcome.reason === 'unknown'
      ? {
          type: 'operation.uncertain' as const,
          reason: 'receipt_missing' as const,
        }
      : {
          type: 'operation.outcome' as const,
          result: {
            status:
              outcome.reason === 'completed'
                ? ('succeeded' as const)
                : ('failed' as const),
            effects: artifacts.length
              ? ('applied' as const)
              : ('none' as const),
            evidence,
          },
        };
  // Stable replay uses the original receipt body/time, not a fresh timestamp.
  const existing = await ledger.readReceipts(scope, operationId);
  const receiptId = cloudStableId(`${operationId}:result`);
  if (!existing.some((r) => r.receipt_id === receiptId))
    await ledger.recordReceipt({
      ...receipt,
      receiptId,
      signal,
      evidence: summary,
    });
  // Only settle an actually measured meter. Unknown work keeps reservations;
  // bytes/time/cost lacking an authoritative measurement are not invented zeros.
  if (outcome.reason !== 'unknown') {
    const [meter] = await db<
      {
        accounting_id: string;
        source: RuntimeUsageObservation['source'];
        observation: unknown | null;
        created_at: Date;
      }[]
    >`select r.accounting_id,b.source,r.observation,a.created_at from allrice_runtime_reservations r join allrice_runtime_budgets b on b.root_run_id=r.root_run_id and b.metric=r.metric join allrice_cloud_execution_attempts a on a.operation_id=r.operation_id where r.operation_id=${operationId} and r.metric='tool_calls'`;
    if (meter && !meter.observation) {
      const at = new Date().toISOString();
      await ledger.settleUsage({
        ...receipt,
        observation: {
          contractVersion: 1,
          observationId: cloudStableId(`${operationId}:usage`),
          accountingId: meter.accounting_id,
          task: binding.task,
          source: meter.source,
          accountingBoundary: { kind: 'operation', attempt: binding.attempt },
          aggregation: 'self_only',
          metric: 'tool_calls',
          unit: 'calls',
          currency: null,
          mode: 'cumulative',
          quality: 'measured',
          amount: 1,
          state: 'settled',
          window: {
            id: cloudStableId(`${operationId}:usage-window`),
            startedAt: meter.created_at.toISOString(),
            endedAt: at,
          },
          observedAt: at,
        },
      });
    }
  }
  await backend.cleanup(attemptId);
  await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp() where operation_id=${operationId} and cleanup_confirmed_at is null`;
  const snapshot = await ledger.readOperation(scope, operationId);
  return {
    operationId,
    status: snapshot.status,
    artifacts: summary.artifacts,
    output: outcome.output,
    exitCode: outcome.exitCode,
    cleanupConfirmed: true,
  };
}

/** Cold recovery never launches a script or expands authority. Stopped bytes
 * remain in the private journal if the originating Run lost authorization;
 * they are not misrepresented as an approved/downloadable success. */
export async function recoverCloudCommandOperations(
  options: { database?: Db; backend?: CloudRunnerBackend } = {},
) {
  const db = options.database ?? getDatabase(),
    backend = options.backend ?? new CloudRunnerBackend();
  const rows = await db<
    {
      operation_id: string;
      lease_token: string;
      snapshot: unknown;
      payload: unknown;
      outcome: CloudRunResult | null;
    }[]
  >`select a.operation_id,a.lease_token,o.snapshot,i.payload,a.outcome from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id join allrice_cloud_execution_inputs i on i.operation_id=o.id join allrice_runtime_roots r on r.root_run_id=o.root_run_id where a.cleanup_confirmed_at is null and (r.cancel_request_id is not null or r.deadline_at<=clock_timestamp() or not exists(select 1 from allrice_jobs j where j.id=i.job_id and j.run_id=o.run_id and j.worker_id=i.worker_id and j.lease_token=i.job_lease_token and j.status='running' and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null)) order by a.created_at limit 20`;
  let recovered = 0,
    failed = 0;
  for (const row of rows) {
    const connection = await db.reserve();
    try {
      const [lock] = await connection<
        { locked: boolean }[]
      >`select pg_try_advisory_lock(15,hashtext(${row.operation_id})) as locked`;
      if (!lock?.locked) continue;
      const { binding } = RuntimeOperationSnapshotSchema.parse(row.snapshot),
        payload = CloudCommandSchema.parse(row.payload),
        attemptId = binding.attempt.attemptId;
      const container = await backend.inspect(attemptId);
      if (container?.State.Running && !(await backend.stop(attemptId)))
        continue;
      const outcome =
        row.outcome ??
        (container
          ? await backend.collect(attemptId, payload, Date.now(), 'unknown')
          : null);
      if (outcome)
        await db`update allrice_cloud_execution_attempts set outcome=coalesce(outcome,${db.json(outcome)}) where operation_id=${row.operation_id}`;
      const ledger = createCloudOperationLedger(
        {
          actor: binding.requestedBy,
          organizationId: binding.task.scope.organizationId,
          workspaceId: binding.task.scope.workspaceId,
          requestId: randomUUID(),
        },
        db,
      );
      const snapshot = await ledger.readOperation(
        binding.task.scope,
        row.operation_id,
      );
      if (
        !['succeeded', 'failed', 'canceled', 'partial', 'unknown'].includes(
          snapshot.status,
        )
      )
        await ledger.recordReceipt({
          scope: binding.task.scope,
          operationId: row.operation_id,
          leaseToken: row.lease_token,
          attempt: binding.attempt,
          receiptId: cloudStableId(`${row.operation_id}:cold-unknown`),
          signal: { type: 'operation.uncertain', reason: 'receipt_missing' },
          evidence: {
            physicallyStopped: !container || outcome?.stopped === true,
            cloudJournalPreserved: true,
          },
        });
      await backend.cleanup(attemptId);
      await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp() where operation_id=${row.operation_id}`;
      recovered++;
    } catch {
      failed++;
      // Loss of backend access cannot keep a dead Worker's UI looking running,
      // and is never evidence that the physical process stopped.
      try {
        const { binding } = RuntimeOperationSnapshotSchema.parse(row.snapshot);
        const ledger = createCloudOperationLedger(
          {
            actor: binding.requestedBy,
            organizationId: binding.task.scope.organizationId,
            workspaceId: binding.task.scope.workspaceId,
            requestId: randomUUID(),
          },
          db,
        );
        const latest = await ledger.readOperation(
          binding.task.scope,
          row.operation_id,
        );
        if (
          ['dispatched', 'running', 'cancel_requested'].includes(latest.status)
        )
          await ledger.recordReceipt({
            scope: binding.task.scope,
            operationId: row.operation_id,
            leaseToken: row.lease_token,
            attempt: binding.attempt,
            receiptId: cloudStableId(`${row.operation_id}:cold-unavailable`),
            signal: { type: 'operation.uncertain', reason: 'receipt_missing' },
            evidence: { physicallyStopped: false, backendUnavailable: true },
          });
      } catch {
        /* Preserve journal for next maintenance; never fabricate completion. */
      }
    } finally {
      await connection`select pg_advisory_unlock(15,hashtext(${row.operation_id}))`;
      connection.release();
    }
  }
  return { recovered, failed };
}
