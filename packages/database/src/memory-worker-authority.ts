import type postgres from 'postgres';
import { readTaskClock } from './task-clock.ts';
type Tx = postgres.TransactionSql;
export class MemoryWorkerAuthorityError extends Error {
  readonly code = 'identity_denied';
  constructor() {
    super('identity_denied');
  }
}
const deny = (): never => {
  throw new MemoryWorkerAuthorityError();
};

export type MemoryRunScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
};
export type MemoryWorker = {
  workerId: string;
  jobId: string;
  leaseToken: string;
  attempt: number;
};
export async function assertMemoryWorker(
  tx: Tx,
  scope: MemoryRunScope,
  worker: MemoryWorker,
  exclusiveRun = false,
) {
  const roots =
    await tx`select root_run_id,(cancel_requested_at is null and cancel_request_id is null and deadline_at>clock_timestamp()) live
    from allrice_runtime_roots where root_run_id=${scope.runId} for share nowait`;
  if (roots.some((r) => !r.live)) return deny();
  // Roots may be absent; still take Job before Run and recheck the lease below.
  await tx`select id from allrice_jobs
    where id=${worker.jobId} and run_id=${scope.runId} for share`;
  const [live] =
    await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
    join allrice_employee_runs er on er.run_id=r.id
    where j.id=${worker.jobId} and j.run_id=${scope.runId} and j.organization_id=${scope.organizationId}
      and j.workspace_id=${scope.workspaceId} and j.owner_id=${scope.ownerId}
      and r.organization_id=j.organization_id and r.workspace_id=j.workspace_id and r.owner_id=j.owner_id
      and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id and er.owner_id=r.owner_id and er.session_id=${scope.sessionId}
      and j.status='running' and r.state='running' and er.status='running'
      and j.worker_id=${worker.workerId} and j.attempt=${worker.attempt} and j.lease_token=${worker.leaseToken}
      and j.cancel_requested_at is null and j.timeout_at>clock_timestamp() and j.lease_expires_at>clock_timestamp()
      and not exists(select 1 from allrice_runtime_run_links l where l.run_id=r.id and l.root_run_id<>r.id)
    for share of r,j ${exclusiveRun ? tx`for no key update of er` : tx`for share of er nowait`}`;
  if (!live) return deny();
  const clock = await readTaskClock(tx, scope.runId);
  if (
    clock &&
    (clock.deadlineAt.getTime() <= Date.now() ||
      (clock.remainingMs !== null && clock.remainingMs <= 0))
  )
    return deny();
}
