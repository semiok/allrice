import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';

export const defaultTaskRuntimeMs = 3_600_000;
// A compatibility projection only. The frozen policy's 0 means unlimited;
// never treat this timestamp as an actual multi-year execution allowance.
export const unboundedTaskDeadline = new Date('9999-01-01T00:00:00.000Z');

export interface TaskRuntimePolicy {
  version: 1;
  timeoutMs: number;
  sources: { scope: string; scopeId: string; timeoutMs: number }[];
}

/** Explicit finite constraints compose by minimum. An absent row is inheritance,
 * not another hidden default cap. Defaults apply only when nobody configured it. */
export function resolveTaskRuntimePolicy(
  sources: TaskRuntimePolicy['sources'],
): TaskRuntimePolicy {
  for (const source of sources) {
    if (
      !Number.isSafeInteger(source.timeoutMs) ||
      (source.timeoutMs !== 0 && source.timeoutMs < 1000) ||
      source.timeoutMs > 86_400_000
    )
      throw Error('invalid_task_runtime_policy');
  }
  const finite = sources.filter((s) => s.timeoutMs > 0);
  return {
    version: 1,
    timeoutMs: finite.length
      ? Math.min(...finite.map((s) => s.timeoutMs))
      : sources.length
        ? 0
        : defaultTaskRuntimeMs,
    sources,
  };
}

/** Called for a new Run, not a new Session. Model identity stays session-frozen,
 * while admin changes take effect on the next Run without rewriting old Runs. */
export async function freezeTaskRuntimePolicy(
  input: {
    organizationId: string;
    userId: string;
    employeeId: string;
    connectionId: string;
  },
  sql: postgres.Sql | postgres.TransactionSql = getDatabase(),
): Promise<TaskRuntimePolicy> {
  const rows = await sql<
    { scope_type: string; scope_id: string; max_runtime_ms: number }[]
  >`
    select distinct on (scope_type) scope_type, scope_id, max_runtime_ms
    from allrice_model_resource_limits
    where (organization_id=${input.organizationId} or organization_id is null)
      and ((scope_type='tenant' and scope_id=${input.organizationId})
        or (scope_type='user' and scope_id=${input.userId})
        or (scope_type='employee' and scope_id=${input.employeeId})
        or (scope_type='provider' and scope_id=${input.connectionId}))
    order by scope_type, organization_id nulls last`;
  return resolveTaskRuntimePolicy(
    rows.map((r) => ({
      scope: r.scope_type,
      scopeId: r.scope_id,
      timeoutMs: r.max_runtime_ms,
    })),
  );
}
