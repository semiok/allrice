import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { cloudStableId } from './cloud-execution.ts';
import { currentMaintenanceAdmin } from './platform-maintenance.ts';
import {
  createAutomaticMaintenanceGrant,
  createMaintenanceGrant,
  getMaintenanceReportAuthority,
  revokeMaintenanceGrant,
} from './platform-maintenance-authority.ts';
import { startMaintenanceRepairGrant } from './platform-maintenance-repair.ts';
import { startMaintenancePublication } from './platform-maintenance-publication.ts';
import { cancelPlatformRepairTask } from './platform-repair.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';

/** The report stays immutable. One explicit authorization is independent of the
 * company's default mode; its request UUID is recovered by GET, not guessed. */
export async function authorizeMaintenanceReport(
  context: RequestContext,
  raw: unknown,
) {
  const grant = await createMaintenanceGrant(context, raw);
  // Existing queue owns execution. A temporary concurrency conflict leaves a
  // durable grant which the normal producer can admit later without reissuing.
  try {
    await startMaintenanceRepairGrant(grant.id);
  } catch (error) {
    if (!(error instanceof QueueError || error instanceof DataAccessError))
      throw error;
  }
  return getMaintenanceReportAuthority(context, grant.reportId);
}
export async function controlMaintenanceGrant(
  context: RequestContext,
  id: string,
  action: 'revoke' | 'inspect',
) {
  const g = await getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    const [row] =
      await tx`select g.*,a.primary_grant_id,a.repair_task_id shared_repair_task_id from allrice_platform_maintenance_grants g join allrice_platform_maintenance_grant_attempts l on l.grant_id=g.id join allrice_platform_maintenance_attempts a on a.id=l.attempt_id where g.id=${UuidSchema.parse(id)} and g.issuer_id=${owner}`;
    if (!row) throw new DataAccessError('not_found');
    return row;
  });
  if (action === 'revoke') {
    await revokeMaintenanceGrant(context, id);
    if (g.primary_grant_id === id && g.shared_repair_task_id)
      await cancelPlatformRepairTask(context, g.shared_repair_task_id);
  } else {
    if (g.primary_grant_id !== id)
      throw new DataAccessError('authorization_denied');
    await startMaintenancePublication(id, 'inspect');
  }
  return getMaintenanceReportAuthority(context, g.report_id);
}
/** Small existing producer tick: grants and Jobs are authoritative. There is
 * no additional supervisor, merge action or deployment process. */
export async function runMaintenanceExecutionTick(signal: AbortSignal) {
  if (process.env.ALLRICE_MAINTENANCE_CENTRAL_ENABLED !== '1') return;
  const db = getDatabase();
  async function bounded(work: () => Promise<unknown>) {
    signal.throwIfAborted();
    try {
      await work();
    } catch (error) {
      if (!(error instanceof QueueError || error instanceof DataAccessError))
        throw error;
    }
  }
  const automatic =
    await db`select r.id from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id join allrice_platform_maintenance_diagnoses x on x.report_id=r.id and x.target_sha=${process.env.ALLRICE_RELEASE_SHA ?? ''}
    where x.defect_id is not null and d.revoked_at is null and d.policy->>'mode'='repair_and_pr' and (d.policy->>'paused')::boolean=false
    and (d.policy->>'automaticAuthorizationUntil')::timestamptz>clock_timestamp() and d.enabled_at is not null and r.received_at>=d.enabled_at and (r.payload->>'sampledAt')::timestamptz>=d.enabled_at
    and not exists(select 1 from allrice_platform_maintenance_grants g where g.report_id=r.id and g.policy_revision=d.revision and g.origin='automatic') order by r.received_at,r.id limit 10`;
  for (const r of automatic)
    await bounded(() => createAutomaticMaintenanceGrant(r.id));
  const pending =
    await db`select g.id,a.repair_task_id,a.publication_id,j.status,p.ci from allrice_platform_maintenance_attempts a join allrice_platform_maintenance_grants g on g.id=a.primary_grant_id
    left join allrice_platform_repair_tasks q on q.id=a.repair_task_id left join allrice_jobs j on j.id=q.job_id left join allrice_platform_repository_publications p on p.id=a.publication_id
    where g.frozen->'githubBot' is not null and ((a.repair_task_id is null and g.revoked_at is null and g.expires_at>clock_timestamp()) or (j.status='succeeded' and a.publication_id is null and g.revoked_at is null and g.expires_at>clock_timestamp()) or (p.id is not null and p.created_at>clock_timestamp()-interval '24 hours' and coalesce(p.ci->>'state','not_observed') in ('not_observed','pending','unknown')
      and not exists(select 1 from allrice_platform_repository_actions x join allrice_jobs y on y.id=x.job_id where x.publication_id=p.id and (y.status in ('queued','claimed','running') or x.created_at>clock_timestamp()-interval '1 minute'))
      and (select count(*) from allrice_platform_repository_actions x where x.publication_id=p.id and x.mode='inspect')<48)) order by a.created_at,a.id limit 10`;
  for (const r of pending)
    await bounded(() =>
      !r.repair_task_id
        ? startMaintenanceRepairGrant(r.id)
        : !r.publication_id
          ? startMaintenancePublication(r.id)
          : startMaintenancePublication(
              r.id,
              'inspect',
              cloudStableId(
                'maintenance-ci:' +
                  r.publication_id +
                  ':' +
                  Math.floor(Date.now() / 60000),
              ),
            ),
    );
}
