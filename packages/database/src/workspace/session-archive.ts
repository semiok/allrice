import type { RequestContext } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { requestRunCancellationTransaction } from '../execution/queue.ts';

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
      and (j.status not in ('succeeded','failed','dead_letter','canceled') or exists (select 1 from allrice_assistant_instances a where a.root_run_id=j.run_id and a.status not in ('completed','partial','failed','canceled'))) 
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
          : '正在执行或等待处理的工作（含助手）',
      })),
    });
  if (schedules.length)
    activity.push({
      kind: 'schedule',
      items: schedules.map((s) => ({ id: s.id, label: s.name })),
    });
  if (activity.length && !stop) throw new SessionActiveError(activity);
  if (!stop) return;
  // Reuse the same persistent root/assistant cutoff and queue cancellation as Stop.
  // Restoring only changes visibility; these cancellation requests stay in place.
  for (const run of runs)
    await requestRunCancellationTransaction(
      tx,
      context,
      run.id,
      'session_archived',
      true,
    );
  await tx`update allrice_automations set status='paused',updated_at=now()
    where session_id=${sessionId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and owner_id=${context.actor.id} and status='enabled'`;
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
        attempt >= 2 ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !['40P01', '40001'].includes(String(error.code))
      )
        throw error;
    }
  }
}
