import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';

export interface TimeInterval {
  start: number;
  end: number;
}

export function mergeIntervals(
  intervals: readonly TimeInterval[],
): TimeInterval[] {
  if (intervals.length === 0) return [];
  const valid = intervals
    .filter(
      (i) =>
        Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (valid.length === 0) return [];

  const merged: TimeInterval[] = [
    { start: valid[0]!.start, end: valid[0]!.end },
  ];
  for (let i = 1; i < valid.length; i++) {
    const current = valid[i]!;
    const prev = merged[merged.length - 1]!;
    if (current.start <= prev.end) {
      prev.end = Math.max(prev.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

export function subtractIntervals(
  sources: readonly TimeInterval[],
  toSubtract: readonly TimeInterval[],
): TimeInterval[] {
  const mergedSources = mergeIntervals(sources);
  const mergedSubtractions = mergeIntervals(toSubtract);
  if (mergedSources.length === 0) return [];
  if (mergedSubtractions.length === 0) return mergedSources;

  const result: TimeInterval[] = [];

  for (const src of mergedSources) {
    let currentStart = src.start;
    for (const sub of mergedSubtractions) {
      if (sub.end <= currentStart) {
        continue;
      }
      if (sub.start >= src.end) {
        break;
      }
      if (sub.start > currentStart) {
        result.push({ start: currentStart, end: Math.min(src.end, sub.start) });
      }
      currentStart = Math.max(currentStart, sub.end);
      if (currentStart >= src.end) {
        break;
      }
    }
    if (currentStart < src.end) {
      result.push({ start: currentStart, end: src.end });
    }
  }

  return result.filter((i) => i.end > i.start);
}

export function totalDurationMs(intervals: readonly TimeInterval[]): number {
  return intervals.reduce((acc, i) => acc + Math.max(0, i.end - i.start), 0);
}

export function isTimeInIntervals(
  intervals: readonly TimeInterval[],
  timeMs: number,
): boolean {
  return intervals.some((i) => timeMs >= i.start && timeMs <= i.end);
}

/**
 * Resolves effective task runtime timeout by reconciling base policy and tenant/user/employee
 * resource limits. An explicit limit of 0 means unlimited execution.
 */
export function resolveEffectiveTimeoutMs(options: {
  baseTimeoutMs: number;
  tenantMaxRuntimeMs?: number | null;
  userMaxRuntimeMs?: number | null;
  employeeMaxRuntimeMs?: number | null;
}): number {
  let effective = options.baseTimeoutMs;

  // Tenant limit takes precedent when configured
  if (
    options.tenantMaxRuntimeMs !== undefined &&
    options.tenantMaxRuntimeMs !== null
  ) {
    if (options.tenantMaxRuntimeMs === 0) {
      effective = 0; // Unlimited per tenant admin configuration
    } else if (effective === 0 || options.tenantMaxRuntimeMs < effective) {
      effective = options.tenantMaxRuntimeMs;
    }
  }

  // Employee limit can constrain further if set and non-zero
  if (
    options.employeeMaxRuntimeMs !== undefined &&
    options.employeeMaxRuntimeMs !== null &&
    options.employeeMaxRuntimeMs > 0
  ) {
    if (effective === 0 || options.employeeMaxRuntimeMs < effective) {
      effective = options.employeeMaxRuntimeMs;
    }
  }

  // User limit can constrain further if set and non-zero
  if (
    options.userMaxRuntimeMs !== undefined &&
    options.userMaxRuntimeMs !== null &&
    options.userMaxRuntimeMs > 0
  ) {
    if (effective === 0 || options.userMaxRuntimeMs < effective) {
      effective = options.userMaxRuntimeMs;
    }
  }

  return effective;
}

/**
 * Queries allrice_model_resource_limits to resolve the effective timeout limit for a task.
 */
export async function getEffectiveRuntimeLimit(
  input: {
    organizationId: string;
    userId?: string;
    employeeId?: string;
    baseTimeoutMs: number;
  },
  sql: postgres.Sql | postgres.TransactionSql = getDatabase(),
): Promise<number> {
  const rows = await sql<
    { scope_type: string; scope_id: string; max_runtime_ms: number }[]
  >`
    select scope_type, scope_id, max_runtime_ms
    from allrice_model_resource_limits
    where (
      (scope_type = 'tenant' and scope_id = ${input.organizationId})
      ${input.employeeId ? sql`or (scope_type = 'employee' and scope_id = ${input.employeeId})` : sql``}
      ${input.userId ? sql`or (scope_type = 'user' and scope_id = ${input.userId})` : sql``}
    )
    and (organization_id = ${input.organizationId} or organization_id is null)
    order by organization_id nulls last
  `;

  const tenantRow = rows.find((r) => r.scope_type === 'tenant');
  const employeeRow = input.employeeId
    ? rows.find((r) => r.scope_type === 'employee')
    : undefined;
  const userRow = input.userId
    ? rows.find((r) => r.scope_type === 'user')
    : undefined;

  return resolveEffectiveTimeoutMs({
    baseTimeoutMs: input.baseTimeoutMs,
    tenantMaxRuntimeMs: tenantRow?.max_runtime_ms,
    employeeMaxRuntimeMs: employeeRow?.max_runtime_ms,
    userMaxRuntimeMs: userRow?.max_runtime_ms,
  });
}

/**
 * Computes suspended wait time and status for a root run using interval union and difference.
 * Only time intervals where NO active branches were executing are credited as suspended wait.
 */
export async function computeRootSuspendedTiming(
  input: {
    rootRunId: string;
    rootCreatedAt: Date;
    now?: Date;
  },
  sql: postgres.Sql | postgres.TransactionSql = getDatabase(),
): Promise<{
  suspendedWaitMs: number;
  isSuspended: boolean;
  suspensionReason: 'waiting_user' | 'waiting_device' | null;
  effectiveRuntimeMs: number;
  wallClockElapsedMs: number;
}> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const rootCreatedMs = input.rootCreatedAt.getTime();

  // 1. Approvals under this root
  const approvals = await sql<
    {
      requested_at: Date;
      decided_at: Date | null;
      runtime_revoked_at: Date | null;
      runtime_expires_at: Date;
      status: string;
      run_id: string;
    }[]
  >`
    select requested_at, decided_at, runtime_revoked_at, runtime_expires_at, status, run_id
    from allrice_approval_requests
    where run_id = ${input.rootRunId} or run_id in (
      select run_id from allrice_runtime_run_links where root_run_id = ${input.rootRunId}
    )
  `;

  // 2. Operations under this root (for device waiting and active work)
  const operations = await sql<
    {
      id: string;
      run_id: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    select id, run_id, snapshot->>'status' as status, created_at, updated_at
    from allrice_runtime_operations
    where root_run_id = ${input.rootRunId}
  `;

  // 3. Assistant instances (for parallel branch active execution accounting)
  const instances = await sql<
    {
      run_id: string;
      status: string;
      created_at: Date;
      stopped_at: Date | null;
    }[]
  >`
    select run_id, status, created_at, stopped_at
    from allrice_assistant_instances
    where root_run_id = ${input.rootRunId}
  `;

  // Calculate waiting intervals
  const approvalIntervals: TimeInterval[] = [];
  let pendingApprovalReason: 'waiting_user' | null = null;

  for (const a of approvals) {
    const start = a.requested_at.getTime();
    let end: number;
    if (a.decided_at) {
      end = a.decided_at.getTime();
    } else if (a.runtime_revoked_at) {
      end = a.runtime_revoked_at.getTime();
    } else {
      end = Math.min(a.runtime_expires_at.getTime(), nowMs);
      if (a.status === 'pending') {
        pendingApprovalReason = 'waiting_user';
      }
    }
    if (end > start) {
      approvalIntervals.push({ start, end });
    }
  }

  const deviceWaitIntervals: TimeInterval[] = [];
  let hasWaitingDevice = false;

  for (const op of operations) {
    if (op.status === 'waiting_device') {
      hasWaitingDevice = true;
      const start = op.updated_at.getTime();
      const end = nowMs;
      if (end > start) {
        deviceWaitIntervals.push({ start, end });
      }
    }
  }

  const allWaitIntervals = mergeIntervals([
    ...approvalIntervals,
    ...deviceWaitIntervals,
  ]);

  // Calculate active execution intervals across all instances and operations
  const activeIntervals: TimeInterval[] = [];

  if (instances.length > 0) {
    for (const inst of instances) {
      const instStart = inst.created_at.getTime();
      const instEnd = inst.stopped_at ? inst.stopped_at.getTime() : nowMs;
      if (instEnd <= instStart) continue;

      const instApprovals = approvalIntervals.filter((_, idx) => {
        const row = approvals[idx];
        return row && row.run_id === inst.run_id;
      });
      const instActive = subtractIntervals(
        [{ start: instStart, end: instEnd }],
        instApprovals,
      );
      activeIntervals.push(...instActive);
    }
  } else {
    // Single job / run without assistant instances
    const [runRow] = await sql<{ completed_at: Date | null }[]>`
      select completed_at from allrice_runs where id = ${input.rootRunId}
    `;
    const runEnd = runRow?.completed_at ? runRow.completed_at.getTime() : nowMs;
    if (runEnd > rootCreatedMs) {
      const runActive = subtractIntervals(
        [{ start: rootCreatedMs, end: runEnd }],
        approvalIntervals,
      );
      activeIntervals.push(...runActive);
    }
  }

  // Active operations running without an instance also count as active execution
  for (const op of operations) {
    if (['running', 'dispatched'].includes(op.status)) {
      const opStart = op.updated_at.getTime();
      const opEnd = nowMs;
      if (opEnd > opStart) {
        activeIntervals.push({ start: opStart, end: opEnd });
      }
    }
  }

  // True suspended intervals = wait intervals MINUS any active execution intervals
  const suspendedIntervals = subtractIntervals(
    allWaitIntervals,
    activeIntervals,
  );
  const suspendedWaitMs = totalDurationMs(suspendedIntervals);

  const isSuspended =
    isTimeInIntervals(suspendedIntervals, nowMs) ||
    (allWaitIntervals.length > 0 &&
      isTimeInIntervals(allWaitIntervals, nowMs) &&
      !isTimeInIntervals(mergeIntervals(activeIntervals), nowMs));

  const suspensionReason: 'waiting_user' | 'waiting_device' | null = isSuspended
    ? (pendingApprovalReason ?? (hasWaitingDevice ? 'waiting_device' : null))
    : null;

  const wallClockElapsedMs = Math.max(0, nowMs - rootCreatedMs);
  const effectiveRuntimeMs = Math.max(0, wallClockElapsedMs - suspendedWaitMs);

  return {
    suspendedWaitMs,
    isSuspended,
    suspensionReason,
    effectiveRuntimeMs,
    wallClockElapsedMs,
  };
}
