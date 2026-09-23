import type postgres from 'postgres';
import {
  unboundedTaskDeadline,
  type TaskRuntimePolicy,
} from './task-runtime-policy.ts';

type Tx = postgres.TransactionSql;
type Phase = 'queued' | 'active' | 'waiting' | 'terminal';
export interface TaskClockRow {
  run_id: string;
  policy: TaskRuntimePolicy;
  active_ms: number;
  waiting_ms: number;
  phase: Phase;
  changed_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export function projectTaskClock(row: TaskClockRow, now: Date) {
  const delta = Math.max(0, now.getTime() - row.changed_at.getTime());
  const activeMs = row.active_ms + (row.phase === 'active' ? delta : 0);
  const waitingMs = row.waiting_ms + (row.phase === 'waiting' ? delta : 0);
  const remainingMs =
    row.policy.timeoutMs === 0
      ? null
      : Math.max(0, row.policy.timeoutMs - activeMs);
  return {
    activeMs,
    waitingMs,
    remainingMs,
    phase: row.phase,
    wallMs: row.started_at
      ? Math.max(
          0,
          (row.completed_at ?? now).getTime() - row.started_at.getTime(),
        )
      : 0,
    timeoutMs: row.policy.timeoutMs,
    sources: row.policy.sources,
    deadlineAt:
      row.policy.timeoutMs === 0 ||
      (remainingMs! > 0 && (row.phase === 'waiting' || row.phase === 'queued'))
        ? unboundedTaskDeadline
        : new Date(now.getTime() + row.policy.timeoutMs - activeMs),
  };
}

/** Explicit blocking only; a child existing is NOT evidence its parent paused.
 * Unknown/dispatched work is active until a terminal receipt proves otherwise. */
export function taskClockPhase(input: {
  state: string;
  instances: { run_id: string; status: string }[];
  operations: { agent_id: string; status: string }[];
  runId: string;
  modelInFlight?: boolean;
}): Phase {
  if (['succeeded', 'failed', 'canceled'].includes(input.state))
    return 'terminal';
  if (input.modelInFlight) return 'active';
  const terminal = new Set(['succeeded', 'failed', 'canceled', 'partial']);
  const blocked = new Set(['waiting_user', 'waiting_device']);
  const liveOps = input.operations.filter((op) => !terminal.has(op.status));
  if (liveOps.some((op) => !blocked.has(op.status))) return 'active';
  if (input.state === 'queued' && liveOps.length === 0) return 'queued';
  const liveInstances = input.instances.filter(
    (inst) =>
      !['completed', 'failed', 'canceled', 'partial'].includes(inst.status),
  );
  const participants = liveInstances.length
    ? liveInstances
    : [{ run_id: input.runId, status: 'running' }];
  const allBlocked = participants.every(
    (inst) =>
      inst.status === 'waiting' ||
      liveOps.some(
        (op) => op.agent_id === inst.run_id && blocked.has(op.status),
      ),
  );
  return allBlocked && liveOps.some((op) => blocked.has(op.status))
    ? 'waiting'
    : 'active';
}

/** Caller owns root -> clock -> job order. Read clock events, never infer historic
 * waiting from a mutable operation.updated_at value. */
export async function refreshTaskClock(tx: Tx, runId: string) {
  const [table] =
    await tx`select to_regclass(format('%I.allrice_task_clocks',current_schema())) is not null as available`;
  if (!table?.available) return;
  await tx`select root_run_id from allrice_runtime_roots where root_run_id=${runId} for update`;
  const [row] = await tx<
    TaskClockRow[]
  >`select * from allrice_task_clocks where run_id=${runId} for update`;
  if (!row) return;
  const [at] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  const now = at!.now;
  const [run] = await tx<
    { state: string }[]
  >`select state from allrice_runs where id=${runId}`;
  const instances = await tx<
    { run_id: string; status: string }[]
  >`select run_id,status from allrice_assistant_instances where root_run_id=${runId}`;
  const operations = await tx<{ agent_id: string; status: string }[]>`
    select coalesce(snapshot->>'agentInstanceId',run_id::text) as agent_id,snapshot->>'status' as status
    from allrice_runtime_operations where root_run_id=${runId}`;
  const questions =
    await tx`select 1 from allrice_task_questions where run_id=${runId} and pending limit 1`;
  if (questions.length)
    operations.push({ agent_id: runId, status: 'waiting_user' });
  const [model] = await tx<
    { active: boolean }[]
  >`select exists(select 1 from allrice_assistant_model_admissions
    where root_run_id=${runId} and dispatched_at is not null and finished_at is null) as active`;
  const [tool] = await tx<
    { active: boolean }[]
  >`select exists(select 1 from allrice_assistant_usage u
    where u.root_run_id=${runId} and u.metric='tool_calls' and u.amount>0 and u.settled_amount is null
      and not exists(select 1 from allrice_task_operation_calls c join allrice_runtime_operations o on o.id=c.operation_id
        where c.run_id=u.root_run_id and c.agent_id=u.run_id and c.native_call_id=u.native_call_id
          and o.snapshot->>'status' in ('waiting_user','waiting_device'))) as active`;
  const phase = taskClockPhase({
    state: run!.state,
    instances,
    operations,
    runId,
    modelInFlight: model?.active || tool?.active,
  });
  const current = projectTaskClock(row, now);
  const startedAt =
    row.started_at ?? (phase === 'active' || phase === 'waiting' ? now : null);
  const completedAt = row.completed_at ?? (phase === 'terminal' ? now : null);
  const next = {
    ...row,
    active_ms: current.activeMs,
    waiting_ms: current.waitingMs,
    phase,
    changed_at: now,
    started_at: startedAt,
    completed_at: completedAt,
  };
  await tx`update allrice_task_clocks set active_ms=${next.active_ms},waiting_ms=${next.waiting_ms},phase=${phase},
    changed_at=${now},started_at=${startedAt},completed_at=${completedAt} where run_id=${runId}`;
  if (phase !== row.phase)
    await tx`insert into allrice_task_clock_events(run_id,phase,occurred_at,active_ms,waiting_ms)
    values(${runId},${phase},${now},${next.active_ms},${next.waiting_ms})`;
  const projection = projectTaskClock(next, now);
  if (phase !== 'terminal') {
    await tx`update allrice_runtime_roots set deadline_at=${projection.deadlineAt} where root_run_id=${runId}`;
    await tx`update allrice_jobs set timeout_at=${projection.deadlineAt} where run_id=${runId}
      and status in ('queued','claimed','running','retry_wait','waiting_approval')`;
  }
  return projection;
}

export async function refreshTaskClockForJob(tx: Tx, jobId: string) {
  const [job] = await tx<
    { run_id: string }[]
  >`select run_id from allrice_jobs where id=${jobId}`;
  if (job) await refreshTaskClock(tx, job.run_id);
}

export async function readTaskClock(tx: Tx, runId: string) {
  const [table] =
    await tx`select to_regclass(format('%I.allrice_task_clocks',current_schema())) is not null as available`;
  if (!table?.available) return null;
  const [row] = await tx<
    TaskClockRow[]
  >`select * from allrice_task_clocks where run_id=${runId}`;
  if (!row) return null;
  const [at] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  return projectTaskClock(row, at!.now);
}

/** Called only within the lease-checked Worker event transaction. Duplicate or
 * reordered question notices cannot reopen an already answered question. */
export async function recordTaskQuestion(
  tx: Tx,
  runId: string,
  payload: unknown,
) {
  if (!payload || typeof payload !== 'object') return;
  const event = payload as Record<string, unknown>;
  if (
    event.source !== 'dsh' ||
    !['session/user-question', 'session/user-question-answered'].includes(
      String(event.sourceEventType),
    )
  )
    return;
  const native = event.nativePayload as Record<string, unknown> | undefined;
  const id = native?.questionId;
  if (typeof id !== 'string' || id.length < 1 || id.length > 240) return;
  if (!(await readTaskClock(tx, runId))) return;
  const pending = event.sourceEventType === 'session/user-question';
  await tx`insert into allrice_task_questions(run_id,question_id,pending) values(${runId},${id},${pending})
    on conflict(run_id,question_id) do update set pending=allrice_task_questions.pending and excluded.pending`;
  await refreshTaskClock(tx, runId);
}

/** A tool waiter must not keep a pre-approval copy of the task deadline. This
 * does not extend operation leases, approval TTLs or subprocess deadlines. */
export async function taskDeadlineOpen(
  db: postgres.Sql,
  runId: string,
  legacyDeadline: string,
) {
  const clock = await db.begin((tx) => readTaskClock(tx, runId));
  return clock
    ? clock.remainingMs === null || clock.remainingMs > 0
    : Date.now() < Date.parse(legacyDeadline);
}

export async function linkTaskOperationCall(
  db: postgres.Sql,
  operationId: string,
  nativeCallId: string,
  agentId?: string,
) {
  await db.begin(async (tx) => {
    const [op] = await tx<
      { root_run_id: string; run_id: string }[]
    >`select root_run_id,run_id from allrice_runtime_operations where id=${operationId}`;
    if (!op || !(await readTaskClock(tx, op.root_run_id))) return;
    await tx`select root_run_id from allrice_runtime_roots where root_run_id=${op.root_run_id} for update`;
    await tx`insert into allrice_task_operation_calls(operation_id,run_id,agent_id,native_call_id)
      values(${operationId},${op.root_run_id},${agentId ?? op.run_id},${nativeCallId}) on conflict(operation_id) do nothing`;
    const [stored] =
      await tx`select native_call_id,agent_id from allrice_task_operation_calls where operation_id=${operationId}`;
    if (
      stored?.native_call_id !== nativeCallId ||
      stored?.agent_id !== (agentId ?? op.run_id)
    )
      throw Error('task_operation_call_conflict');
    await refreshTaskClock(tx, op.root_run_id);
  });
}
