import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type createMcpRuntimeOperation,
  createMcpOperationLedger,
  getDatabase,
  mcpStableId,
  runtimePolicyDigest,
  taskDeadlineOpen,
  type McpStore,
} from '@allrice/database';
import {
  McpError,
  RuntimeOperationSnapshotSchema,
  type RuntimeOperationSignal,
  type RuntimeUsageObservation,
} from '@allrice/contracts';
import { invokeFrozenMcpTool } from './lifecycle.js';
import type { createMcpTransport } from './transport.js';

type Created = Awaited<ReturnType<typeof createMcpRuntimeOperation>>;
type Database = ReturnType<typeof getDatabase>;
type StoredResult = {
  signal: RuntimeOperationSignal;
  evidence: {
    source: 'remote_mcp';
    trusted: false;
    output: string;
    outputDigest: string;
    isError: boolean;
    code: string | null;
  };
};
async function workerCurrent(created: Created, db: Database) {
  const c = created.context;
  const [row] =
    await db`select id from allrice_jobs where id=${c.jobId} and run_id=${c.runId}
    and organization_id=${c.organizationId} and workspace_id=${c.workspaceId} and owner_id=${c.policySnapshot.subjectId}
    and worker_id=${c.worker.id} and lease_token::text=${created.jobLeaseToken} and status='running'
    and lease_expires_at>clock_timestamp() and timeout_at>clock_timestamp() and cancel_requested_at is null`;
  return !!row;
}

/** A single tools/call, not an Agent loop. A durable START authorizes at most
 * one send; network loss, remote errors or cancellation cannot prove rollback. */
export async function runMcpRuntimeOperation(
  created: Created,
  options: {
    database?: Database;
    signal?: AbortSignal;
    store?: McpStore;
    transport?: ReturnType<typeof createMcpTransport>;
  } = {},
) {
  const db = options.database ?? getDatabase(),
    { ledger, payload } = created;
  const binding = created.snapshot.binding,
    scope = binding.task.scope,
    operationId = binding.attempt.operationId;
  const response = (
    status: string,
    output = '',
    code: string | null = null,
  ) => ({
    operationId,
    status,
    output,
    code,
    source: 'remote_mcp' as const,
    trusted: false as const,
  });
  const [prior] = await db<
    { lease_token: string; result: StoredResult | null }[]
  >`select lease_token,result from allrice_mcp_execution_attempts where operation_id=${operationId}`;
  let leaseToken = prior?.lease_token;
  if (!leaseToken) {
    while (
      await taskDeadlineOpen(db, binding.task.rootRunId, created.deadlineAt)
    ) {
      if (options.signal?.aborted) {
        await ledger.cancelRoot(scope, binding.task.rootRunId, randomUUID());
        return response(
          (await ledger.readOperation(scope, operationId)).status,
          '',
          'MCP_CANCELED',
        );
      }
      if (!(await workerCurrent(created, db)))
        return response('blocked', '', 'MCP_WORKER_LEASE_LOST');
      try {
        const lease = await ledger.dispatch({
          scope,
          operationId,
          leaseOwner: created.context.worker.id,
          leaseMs: 15000,
        });
        leaseToken = lease.leaseToken;
        break;
      } catch (error) {
        if (
          !['approval_required', 'approval_invalid_or_stale'].includes(
            error instanceof Error ? error.message : '',
          )
        ) {
          // A dispatch ACK lost before recording its token cannot be recovered
          // into a new permission. Leave ledger expiry/reconciliation in charge.
          return response(
            (await ledger.readOperation(scope, operationId)).status,
            '',
            'MCP_DISPATCH_DENIED',
          );
        }
        const [approval] = await db<
          { status: string; expired: boolean; revoked: boolean }[]
        >`select status,runtime_expires_at<=clock_timestamp() as expired,runtime_revoked_at is not null as revoked
          from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${operationId}`;
        if (
          approval &&
          (approval.status === 'rejected' ||
            approval.expired ||
            approval.revoked)
        )
          return response(
            'blocked',
            '',
            approval.status === 'rejected'
              ? 'MCP_APPROVAL_REJECTED'
              : 'MCP_APPROVAL_STALE',
          );
        await delay(200);
      }
    }
  }
  if (!leaseToken) return response('blocked', '', 'MCP_DEADLINE');
  const receipt = { scope, operationId, leaseToken, attempt: binding.attempt };
  const uncertain = async () => {
    await ledger.recordReceipt({
      ...receipt,
      receiptId: mcpStableId(`${operationId}:uncertain`),
      signal: { type: 'operation.uncertain', reason: 'receipt_missing' },
      evidence: { source: 'remote_mcp', trusted: false, effects: 'unknown' },
    });
    return response('unknown', '', 'MCP_UNKNOWN');
  };
  let result = prior?.result;
  if (!result) {
    // Re-entry never reruns a started call, even if no process-local cache exists.
    let mayExecute = false;
    try {
      mayExecute = (
        await ledger.startOperation({
          ...receipt,
          receiptId: mcpStableId(`${operationId}:start`),
        })
      ).mayExecute;
    } catch {
      return uncertain();
    }
    if (!mayExecute) return uncertain();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        Math.max(
          1,
          Math.min(60000, Date.parse(created.deadlineAt) - Date.now()),
        ),
      ),
      ...(options.signal ? [options.signal] : []),
    ]);
    let checking: Promise<void> | undefined;
    const maintain = () => {
      if (checking) return checking;
      checking = (async () => {
        signal.throwIfAborted();
        if (!(await workerCurrent(created, db)))
          throw new McpError('MCP_DENIED');
        await ledger.heartbeat({ ...receipt, leaseMs: 15000 });
      })()
        .catch((error) => {
          controller.abort();
          throw error;
        })
        .finally(() => {
          checking = undefined;
        });
      return checking;
    };
    const timer = setInterval(() => {
      void maintain().catch(() => undefined);
    }, 1000);
    const evidenceBase = {
      source: 'remote_mcp' as const,
      trusted: false as const,
    };
    try {
      const returned = await invokeFrozenMcpTool({
        scope: created.scope,
        tool: payload.tool,
        arguments: payload.arguments,
        signal,
        assertOperationLease: maintain,
        ...(options.store ? { store: options.store } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
      });
      const outputDigest = runtimePolicyDigest(returned.rawOutput);
      const evidence = {
        id: mcpStableId(`${operationId}:evidence`),
        recordedAt: new Date().toISOString(),
        digest: outputDigest,
      };
      result = {
        signal: returned.isError
          ? { type: 'operation.uncertain', reason: 'receipt_missing' }
          : {
              type: 'operation.outcome',
              result: {
                status: 'succeeded',
                effects: payload.tool.risk === 'read_only' ? 'none' : 'applied',
                evidence,
              },
            },
        evidence: {
          ...evidenceBase,
          output: returned.modelContent,
          outputDigest,
          isError: returned.isError,
          code: returned.isError ? 'MCP_REMOTE_ERROR_EFFECTS_UNKNOWN' : null,
        },
      };
    } catch (error) {
      const code = error instanceof McpError ? error.code : 'MCP_UNKNOWN';
      if (code === 'MCP_UNKNOWN') return await uncertain();
      // Transport promises these errors occur before tools/call was dispatched.
      const evidence = {
        id: mcpStableId(`${operationId}:evidence`),
        recordedAt: new Date().toISOString(),
        digest: runtimePolicyDigest({ code, dispatched: false }),
      };
      const current = await ledger.readOperation(scope, operationId);
      result = {
        signal:
          current.status === 'cancel_requested'
            ? { type: 'operation.stopped', effects: 'none', evidence }
            : {
                type: 'operation.outcome',
                result: { status: 'failed', effects: 'none', evidence },
              },
        evidence: {
          ...evidenceBase,
          output: '',
          outputDigest: evidence.digest,
          isError: true,
          code,
        },
      };
    } finally {
      clearInterval(timer);
      await checking?.catch(() => undefined);
    }
    // Persist exactly the receipt body before publishing it, so crash recovery
    // reuses timestamp/digest and never generates a conflicting second receipt.
    await db`update allrice_mcp_execution_attempts set result=${db.json(result)} where operation_id=${operationId} and result is null`;
    const [saved] = await db<
      { result: StoredResult }[]
    >`select result from allrice_mcp_execution_attempts where operation_id=${operationId}`;
    result = saved!.result;
  }
  const recorded = await ledger.recordReceipt({
    ...receipt,
    receiptId: mcpStableId(`${operationId}:result`),
    signal: result.signal,
    evidence: result.evidence,
  });
  if (result.signal.type === 'operation.outcome')
    await settleMcpToolUsage(db, ledger, binding, leaseToken);
  return response(
    recorded.snapshot.status,
    result.evidence.output,
    result.evidence.code,
  );
}

async function settleMcpToolUsage(
  db: Database,
  ledger: ReturnType<typeof createMcpOperationLedger>,
  binding: Created['snapshot']['binding'],
  leaseToken: string,
) {
  const operationId = binding.attempt.operationId;
  const [meter] = await db<
    {
      accounting_id: string;
      source: RuntimeUsageObservation['source'];
      observation: unknown | null;
      created_at: Date;
    }[]
  >`
    select r.accounting_id,b.source,r.observation,a.created_at from allrice_runtime_reservations r
    join allrice_runtime_budgets b on b.root_run_id=r.root_run_id and b.metric=r.metric
    join allrice_mcp_execution_attempts a on a.operation_id=r.operation_id where r.operation_id=${operationId} and r.metric='tool_calls'`;
  if (!meter || meter.observation) return;
  const at = new Date().toISOString();
  await ledger.settleUsage({
    scope: binding.task.scope,
    operationId,
    leaseToken,
    observation: {
      contractVersion: 1,
      observationId: mcpStableId(`${operationId}:usage`),
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
        id: mcpStableId(`${operationId}:usage-window`),
        startedAt: meter.created_at.toISOString(),
        endedAt: at,
      },
      observedAt: at,
    },
  });
}

/** Cold recovery is receipt-only: never obtains credentials, connects to MCP,
 * retries a call or claims that canceling HTTP stopped a third-party effect. */
export async function recoverMcpRuntimeOperations(
  options: { database?: Database } = {},
) {
  const db = options.database ?? getDatabase();
  const rows = await db<
    {
      operation_id: string;
      lease_token: string;
      snapshot: unknown;
      result: StoredResult | null;
    }[]
  >`
    select a.operation_id,a.lease_token,o.snapshot,a.result from allrice_mcp_execution_attempts a
    join allrice_runtime_operations o on o.id=a.operation_id join allrice_mcp_execution_inputs i on i.operation_id=o.id
    join allrice_runtime_roots r on r.root_run_id=o.root_run_id
    where o.snapshot->>'status' in ('dispatched','running','cancel_requested') and
    (r.cancel_request_id is not null or r.deadline_at<=clock_timestamp() or o.lease_expires_at<=clock_timestamp()
      or not exists(select 1 from allrice_jobs j where j.id=i.job_id and j.run_id=i.run_id and j.worker_id=i.worker_id and j.lease_token::text=i.job_lease_token
        and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null))
    order by a.created_at limit 20`;
  let recovered = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const { binding } = RuntimeOperationSnapshotSchema.parse(row.snapshot);
      const ledger = createMcpOperationLedger(
        {
          actor: binding.requestedBy,
          organizationId: binding.task.scope.organizationId,
          workspaceId: binding.task.scope.workspaceId,
          requestId: randomUUID(),
        },
        db,
      );
      const receipt = {
        scope: binding.task.scope,
        operationId: row.operation_id,
        leaseToken: row.lease_token,
        attempt: binding.attempt,
      };
      await ledger.recordReceipt(
        row.result
          ? {
              ...receipt,
              receiptId: mcpStableId(`${row.operation_id}:result`),
              signal: row.result.signal,
              evidence: row.result.evidence,
            }
          : {
              ...receipt,
              receiptId: mcpStableId(`${row.operation_id}:uncertain`),
              signal: {
                type: 'operation.uncertain',
                reason: 'receipt_missing',
              },
              evidence: {
                source: 'remote_mcp',
                trusted: false,
                effects: 'unknown',
              },
            },
      );
      if (row.result?.signal.type === 'operation.outcome')
        await settleMcpToolUsage(db, ledger, binding, row.lease_token);
      recovered++;
    } catch {
      failed++;
    }
  }
  return { recovered, failed };
}
