import { z } from 'zod';
import type { ExecutionContext } from '@allrice/contracts';
import { getDatabase, getDiagnosticsDatabase } from './core/client.ts';
import { refreshTaskClock } from './task-clock.ts';

const Event = z
  .object({
    stage: z.enum([
      'queued',
      'waiting',
      'acquired',
      'executing',
      'completed',
      'failed',
      'canceled',
      'unknown',
      'cleaned',
    ]),
    reason: z
      .enum([
        'sandbox_capacity',
        'memory_pressure',
        'fair_queue',
        'local_busy',
        'local_preparing',
        'none',
      ])
      .default('none'),
    backendId: z.string().max(160).optional(),
    capacity: z.number().int().min(0).max(32).optional(),
    containerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    errorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .optional(),
    waitMs: z.number().nonnegative().optional(),
    elapsedMs: z.number().nonnegative().optional(),
    startupMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ExecutionDiagnosticEvent = z.input<typeof Event>;

/** Low-frequency server diagnostics. The query deliberately excludes SQL text,
 * bind parameters and provider data. Backend PIDs correlate lock samples with
 * the metadata in per-run resource transitions. */
export async function executionPressureSnapshot(db = getDiagnosticsDatabase()) {
  const [jobs] =
    await db`select count(*) filter(where status='queued')::int as queued,
    count(*) filter(where status in ('claimed','running'))::int as active,
    coalesce(max(extract(epoch from (clock_timestamp()-created_at))*1000) filter(where status='queued'),0)::float8 as longest_wait_ms
    from allrice_jobs where status in ('queued','claimed','running')`;
  const [resources] =
    await db`select count(*) filter(where w.state='waiting')::int as waiting,
    count(*) filter(where w.state='executing')::int as executing
    from allrice_task_resource_waits w join allrice_jobs j on j.id=w.job_id
    where w.finished_at is null and j.lease_token=w.lease_token and j.lease_expires_at>clock_timestamp() and j.status='running'`;
  const blocked =
    await db`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blocking_pids,
    (extract(epoch from (clock_timestamp()-query_start))*1000)::float8 as wait_ms
    from pg_stat_activity where datname=current_database() and application_name like 'allrice%'
      and state='active' and wait_event_type='Lock' order by query_start limit 20`;
  return { jobs, resources, blocked: [...blocked] };
}

/** Metadata only. A single validated projection drives resource waits; durable
 * transitions reuse audit_events. Never persist scripts or tool arguments. */
export function executionResourceObserver(
  input: {
    context: ExecutionContext;
    leaseToken: string;
    attemptId: string;
    callId: string;
    operationId?: string;
  },
  db = getDatabase(),
) {
  const c = input.context;
  return {
    async isTurn() {
      const [first] = await db<{ id: string }[]>`
        select w.id from allrice_task_resource_waits w
        join allrice_jobs j on j.id=w.job_id and j.worker_id=w.worker_id and j.lease_token=w.lease_token
        where w.state='waiting' and w.reason not in ('local_busy','local_preparing')
          and j.status='running' and j.cancel_requested_at is null
          and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
        order by (select count(*) from allrice_task_resource_waits a join allrice_jobs aj on aj.id=a.job_id
          where a.organization_id=w.organization_id and a.state='executing' and aj.status='running'
            and aj.lease_token=a.lease_token and aj.lease_expires_at>clock_timestamp()), w.queued_at,w.id limit 1`;
      return first?.id === input.attemptId;
    },
    async observe(raw: ExecutionDiagnosticEvent) {
      const event = Event.parse(raw);
      await db.begin(async (tx) => {
        await refreshTaskClock(tx, c.runId); // root -> clock -> job
        const [job] =
          await tx`select id from allrice_jobs where id=${c.jobId} and run_id=${c.runId}
          and organization_id=${c.organizationId} and workspace_id=${c.workspaceId!}
          and worker_id=${c.worker.id} and lease_token=${input.leaseToken} and status='running'
          and lease_expires_at>clock_timestamp() for update`;
        if (!job) {
          // Cancellation/recovery may already have cleared the job lease.
          // A former holder may close only its existing attempt, never enqueue
          // or acquire work under expired authority. Live queue readers also
          // require the current job lease, so this cannot unblock a successor.
          const [owned] = ['failed', 'canceled', 'unknown', 'cleaned'].includes(
            event.stage,
          )
            ? await tx`select id from allrice_task_resource_waits where id=${input.attemptId}
                and job_id=${c.jobId} and run_id=${c.runId} and organization_id=${c.organizationId}
                and workspace_id=${c.workspaceId!} and worker_id=${c.worker.id}
                and lease_token=${input.leaseToken} for update`
            : [];
          if (!owned) throw Error('execution_observer_lease_lost');
        }
        const state =
          event.stage === 'queued' || event.stage === 'waiting'
            ? 'waiting'
            : event.stage === 'acquired' || event.stage === 'executing'
              ? 'executing'
              : event.stage === 'cleaned'
                ? null
                : event.stage;
        if (event.stage === 'queued') {
          await tx`insert into allrice_task_resource_waits(id,run_id,job_id,organization_id,workspace_id,worker_id,lease_token,call_id,operation_id,state,reason)
            values(${input.attemptId},${c.runId},${c.jobId},${c.organizationId},${c.workspaceId!},${c.worker.id},${input.leaseToken},${input.callId},${input.operationId ?? null},'waiting',${event.reason})
            on conflict(id) do nothing`;
        }
        if (state)
          await tx`update allrice_task_resource_waits set state=${state},reason=${event.reason},
          started_at=case when ${state}='executing' then coalesce(started_at,clock_timestamp()) else started_at end,
          finished_at=case when ${state} not in ('waiting','executing') then coalesce(finished_at,clock_timestamp()) else finished_at end,
          backend_id=coalesce(${event.backendId ?? null},backend_id),capacity=coalesce(${event.capacity ?? null},capacity),
          container_id=coalesce(${event.containerId ?? null},container_id),error_code=coalesce(${event.errorCode ?? null},error_code),updated_at=clock_timestamp()
          where id=${input.attemptId} and run_id=${c.runId} and worker_id=${c.worker.id} and lease_token=${input.leaseToken}`;
        const [backend] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        // A savepoint keeps optional diagnostics from aborting authoritative
        // queue/clock state. Fall back to structured service logs on write error.
        await tx
          .savepoint(
            async (
              log,
            ) => log`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
          values(${c.organizationId},${c.workspaceId!},${c.delegatedBy.id},'execution.diagnostic','run',${c.runId},'recorded',${event.stage},
          ${log.json({ ...event, databasePid: backend?.pid, jobId: c.jobId, workerId: c.worker.id, attemptId: input.attemptId, callId: input.callId, operationId: input.operationId ?? null })})`,
          )
          .catch(() => {
            console.error(
              JSON.stringify({
                event: 'execution_diagnostic_write_failed',
                at: new Date().toISOString(),
                runId: c.runId,
                tenantId: c.organizationId,
                attemptId: input.attemptId,
                ...event,
              }),
            );
          });
        await refreshTaskClock(tx, c.runId);
      });
    },
  };
}
