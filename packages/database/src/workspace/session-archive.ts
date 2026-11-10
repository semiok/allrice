import type { RequestContext } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { recordTransactionRetry } from '../core/transaction-retries.ts';
import { requestRunCancellationTransaction } from '../execution/queue.ts';
import {
  insertCalendarDecisionInTransaction,
  prepareCalendarRetirementsInTransaction,
} from '../native-schedule-calendar-business.ts';

export type SessionArchiveActivity = {
  kind: string;
  items: Array<{ id: string; label: string }>;
};
export class SessionActiveError extends Error {
  constructor(readonly activity: SessionArchiveActivity[]) {
    super('此会话仍有未完成的工作，请确认停止并归档。');
  }
}

/** Called while holding the session lock, shared with message/run admission. */
export async function archiveSessionActivity(
  tx: TransactionSql,
  context: RequestContext,
  sessionId: string,
  stop: boolean,
) {
  const runs = await tx<{ id: string; status: string }[]>`
    select j.run_id as id, j.status from allrice_jobs j
    join allrice_employee_runs e on e.run_id=j.run_id
    where e.session_id=${sessionId} and e.organization_id=${context.organizationId}
      and e.workspace_id=${context.workspaceId!} and e.owner_id=${context.actor.id}
      and j.status not in ('succeeded','failed','dead_letter','canceled')
    order by j.run_id`;
  const schedules = await tx<{ id: string; name: string }[]>`
    select id,name from allrice_automations where session_id=${sessionId}
      and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}
      and owner_id=${context.actor.id} and status='enabled' for update`;
  const activity: SessionArchiveActivity[] = [];
  if (runs.length)
    activity.push({
      kind: 'job',
      items: runs.map((r) => ({
        id: r.id,
        label: ['queued', 'retry_wait'].includes(r.status)
          ? '排队中的工作'
          : '正在执行或等待处理的工作',
      })),
    });
  if (schedules.length)
    activity.push({
      kind: 'schedule',
      items: schedules.map((s) => ({ id: s.id, label: s.name })),
    });
  if (activity.length && !stop) throw new SessionActiveError(activity);
  if (!stop) return;
  // Reuse the same persistent root cutoff and queue cancellation as Stop.
  // Restoring only changes visibility; these cancellation requests stay in place.
  for (const run of runs)
    await requestRunCancellationTransaction(
      tx,
      context,
      run.id,
      'session_archived',
      true,
    );
  await tx`update allrice_automations set status='paused',next_run_at=null,updated_at=now()
    where session_id=${sessionId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and owner_id=${context.actor.id} and status='enabled'`;
  // Archiving is another ordinary fixed-task pause entrance. Keep its existing
  // Run cancellation policy, but let the native writer durably delete the clock.
  await tx`update allrice_native_recurring_controls c set
    snapshot=jsonb_set(c.snapshot,'{control,command}',
      (c.snapshot->'control'->'command') || '{"kind":"delete","status":"pending"}'::jsonb),
    snapshot_version=c.snapshot_version+1
    from allrice_automations p where p.id=c.automation_id and p.session_id=${sessionId}
      and p.organization_id=${context.organizationId} and p.workspace_id=${context.workspaceId!}
      and p.owner_id=${context.actor.id} and p.status='paused'
      and c.snapshot->'control'->>'kind'='recurring'
      and not (c.snapshot->'control'->'dispatch' ? 'consumer')
      and c.snapshot->'control'->>'taskDeleted'='false'
      and c.snapshot->'control'->'command'->>'kind'<>'delete'`;
  // The session archive in this same transaction proves authority withdrawal
  // at COMMIT. Close monthly plans now, so an immediate restore cannot leave
  // the old native arm active between Worker polls.
  const plans = await tx<
    {
      period_id: string;
      control_id: string;
      revision: number;
      decided_at: Date;
    }[]
  >`select p.period_id,p.control_id,p.revision,clock_timestamp() decided_at
    from allrice_native_calendar_plans p
    join allrice_native_recurring_controls c on c.control_id=p.control_id and c.partition_id=p.partition_id
    join allrice_automations a on a.id=p.automation_id
    where a.session_id=${sessionId} and a.organization_id=${context.organizationId}
      and a.workspace_id=${context.workspaceId!} and a.owner_id=${context.actor.id}
      and c.immutable_identity->'dispatch'->>'consumer'='ordinary-monthly-v1'
      and p.closed_decision_id is null order by p.period_id for update of p`;
  for (const plan of plans) {
    await insertCalendarDecisionInTransaction(tx, {
      decisionId: randomUUID(),
      periodId: plan.period_id,
      kind: 'authority',
      outcome: 'authority_blocked',
      revision: Number(plan.revision),
      decidedAt: plan.decided_at.toISOString(),
      receiptOccurrenceId: null,
      automationRunId: null,
      successorPeriodId: null,
      lease: null,
      budget: null,
    });
    await prepareCalendarRetirementsInTransaction(tx, plan.control_id);
  }
}

/** Concurrent worker/root locks can invert a session admission lock. Retrying
 * the whole transaction preserves atomic archive + cancellation, never a partial stop. */
export async function retryArchiveTransaction<T>(
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
        !['40P01', '40001'].includes(String(error.code))
      )
        throw error;
      recordTransactionRetry({
        site: 'session_archive',
        sqlState: String(error.code),
        attempt: attempt + 1,
        outcome: attempt >= 2 ? 'exhausted' : 'retrying',
      });
      if (attempt >= 2) throw error;
    }
  }
}
