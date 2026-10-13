import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { requestEmployeeAccessCancellationTransaction } from '../execution/queue.ts';

export class EmployeeAccessBusyError extends Error {
  constructor() {
    super('employee_access_busy');
  }
}

/** Employee mutations hold identity/assignment locks. Worker admission holds
 * root/job locks first. NOWAIT below aborts this entire transaction instead of
 * waiting in the reverse order; bounded retries start with no locks held. */
async function retryEmployeeAccessTransaction<T>(
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== '55P03'
      )
        throw error;
      if (attempt >= 4) throw new EmployeeAccessBusyError();
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

export function employeeAccessTransaction<T>(
  sql: ReturnType<typeof getDatabase>,
  run: (tx: postgres.TransactionSql) => Promise<T>,
) {
  return retryEmployeeAccessTransaction(() => sql.begin(run));
}

/** Call only inside the authorized assignment/instance mutation transaction.
 * Reassignment cannot clear this durable cutoff, including parked native waits. */
export async function cancelEmployeeAccessRuns(
  tx: postgres.TransactionSql,
  scope: { organizationId: string; workspaceId: string } & (
    | { employeeId: string; inactiveAssignmentsOnly?: boolean }
    | { instanceId: string }
  ),
  reason: string,
  actor: RequestContext | { platformActorLabel: string },
) {
  const runs = await tx<{ run_id: string }[]>`
    select er.run_id from allrice_employee_runs er
    join allrice_employee_assignments a on a.id=er.employee_assignment_id
    join allrice_chat_sessions s on s.id=er.session_id
    join allrice_jobs j on j.run_id=er.run_id
    where a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId}
      and ${
        'instanceId' in scope
          ? tx`coalesce(s.employee_instance_id,a.id)=${scope.instanceId}`
          : tx`a.employee_id=${scope.employeeId} ${scope.inactiveAssignmentsOnly ? tx`and not a.active` : tx``}`
      }
      and j.status not in ('succeeded','failed','dead_letter','canceled')
      and j.cancel_requested_at is null order by er.run_id`;
  for (const run of runs) {
    await requestEmployeeAccessCancellationTransaction(
      tx,
      run.run_id,
      reason,
      'platformActorLabel' in actor
        ? {
            actorId: null,
            requestId: null,
            actorLabel: actor.platformActorLabel,
          }
        : { actorId: actor.actor.id, requestId: actor.requestId },
    );
  }
  return runs.length;
}
