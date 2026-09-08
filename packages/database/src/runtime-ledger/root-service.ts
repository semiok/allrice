import type { RuntimeTaskRef } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import type { createRuntimeOperationLedger } from './ledger.ts';
import type { RuntimeBudgetLimit } from './types.ts';

/** Trusted adapters share one immutable root. Never allocates another budget
 * for switching local/cloud/MCP target, and never raises an existing limit. */
export async function ensureRuntimeOperationRoot(
  ledger: ReturnType<typeof createRuntimeOperationLedger>,
  task: RuntimeTaskRef,
  deadlineAt: string,
  database = getDatabase(),
) {
  const [root] = await database<
    { deadline_at: Date }[]
  >`select deadline_at from allrice_runtime_roots where root_run_id=${task.rootRunId} and organization_id=${task.scope.organizationId} and workspace_id=${task.scope.workspaceId}`;
  const rows = root
    ? await database<
        {
          metric: RuntimeBudgetLimit['metric'];
          unit: RuntimeBudgetLimit['unit'];
          currency: string | null;
          capacity: string;
          source: RuntimeBudgetLimit['source'];
        }[]
      >`select metric,unit,currency,capacity,source from allrice_runtime_budgets where root_run_id=${task.rootRunId} order by metric`
    : [];
  const budgets: RuntimeBudgetLimit[] = root
    ? rows.map((r) => ({ ...r, capacity: Number(r.capacity) }))
    : [
        {
          metric: 'tool_calls',
          unit: 'calls',
          currency: null,
          capacity: 32,
          source: { kind: 'worker', sourceId: 'runtime-operation-v1' },
        },
      ];
  try {
    await ledger.createRoot({
      task,
      deadlineAt: root?.deadline_at.toISOString() ?? deadlineAt,
      budgets,
    });
  } catch (error) {
    // Another trusted adapter can win first creation. Re-read, never force or
    // modify its limits; createRoot still compares task/frozen identity exactly.
    if (
      !root &&
      error instanceof Error &&
      error.message === 'idempotency_conflict'
    ) {
      const [winner] =
        await database`select root_run_id from allrice_runtime_roots where root_run_id=${task.rootRunId} and organization_id=${task.scope.organizationId} and workspace_id=${task.scope.workspaceId}`;
      // A conflicting ID in another scope is not a creation race and must not
      // recurse indefinitely. The ledger remains the source of scope validation.
      if (winner)
        return ensureRuntimeOperationRoot(ledger, task, deadlineAt, database);
    }
    throw error;
  }
  return budgets;
}
