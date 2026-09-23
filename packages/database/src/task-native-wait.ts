import {
  NativeQuestionCheckpointSchema,
  UserQuestionAnswerSubmissionSchema,
  type ExecutionContext,
  type NativeQuestionCheckpoint,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { refreshTaskClock } from './task-clock.ts';
import { cancelUnadoptedSteers } from './conversation/conversation-input.ts';

function matchesQuestion(checkpoint: NativeQuestionCheckpoint, text: string) {
  const prefix = 'allrice:user-question:v1:';
  if (!text.startsWith(prefix)) return false;
  try {
    const answer = UserQuestionAnswerSubmissionSchema.parse(
      JSON.parse(text.slice(prefix.length)),
    );
    return (
      answer.questionId === checkpoint.questionId &&
      answer.answers.length === checkpoint.questions.length &&
      new Set(answer.answers.map((a) => a.id)).size === answer.answers.length &&
      checkpoint.questions.every((q) => {
        const a = answer.answers.find((a) => a.id === q.id);
        return (
          !!a &&
          (a.selected.length > 0 || !!a.custom?.trim()) &&
          new Set(a.selected).size === a.selected.length &&
          (q.multiSelect ||
            (a.selected.length <= 1 && !(a.selected.length && a.custom))) &&
          a.selected.every((label) =>
            q.options?.some((option) => option.label === label),
          )
        );
      })
    );
  } catch {
    return false;
  }
}

type Owner = {
  context: ExecutionContext;
  worker: { jobId: string; workerId: string; leaseToken: string };
};

export class NativeWaitAuthorityError extends Error {
  constructor(
    readonly code:
      'native_wait_authority_changed' | 'native_wait_configuration_changed',
  ) {
    super(code);
  }
}

export async function readParkedNativeUsage(
  context: ExecutionContext,
  db = getDatabase(),
) {
  const [row] = await db<
    {
      input: number;
      cached: number;
      output: number;
      complete: boolean;
      cache_known: boolean;
    }[]
  >`
    select coalesce(sum(input_tokens),0)::float8 as input,coalesce(sum(cached_input_tokens),0)::float8 as cached,
      coalesce(sum(output_tokens),0)::float8 as output,coalesce(bool_and(usage_complete),true) as complete,
      coalesce(bool_and(cache_usage_known),true) as cache_known from allrice_route_decisions
    where run_id=${context.runId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId!}
      and status='canceled' and error_code='NATIVE_QUESTION_PARKED'`;
  return {
    usage: {
      inputTokens: row!.input,
      cachedInputTokens: row!.cached,
      outputTokens: row!.output,
    },
    usageComplete: row!.complete,
    cacheUsageKnown: row!.cache_known,
  };
}

async function lockOwner(tx: TransactionSql, { context, worker }: Owner) {
  await refreshTaskClock(tx, context.runId);
  const [job] =
    await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
    where j.id=${worker.jobId} and j.run_id=${context.runId} and j.worker_id=${worker.workerId}
      and j.lease_token=${worker.leaseToken} and j.status='running' and j.lease_expires_at>clock_timestamp()
      and j.cancel_requested_at is null and r.organization_id=${context.organizationId}
      and r.workspace_id=${context.workspaceId!} and r.owner_id=${context.delegatedBy.id} for update of j`;
  if (!job) throw Error('native_wait_lease_lost');
  const [authority] = await tx`select r.id from allrice_runs r
    join allrice_users u on u.id=r.owner_id and u.status='active'
    join allrice_organizations o on o.id=r.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=o.id and w.archived_at is null
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.subject_id=r.owner_id and p.expires_at>clock_timestamp()
    join allrice_employee_runs er on er.run_id=r.id and er.organization_id=r.organization_id and er.owner_id=r.owner_id
    join allrice_employee_assignments a on a.id=er.employee_assignment_id and a.user_id=r.owner_id and a.active
      and a.organization_id=r.organization_id and a.workspace_id=r.workspace_id
    join allrice_employees e on e.id=a.employee_id and e.status='active'
    join allrice_chat_sessions s on s.id=er.session_id and s.owner_id=r.owner_id and s.organization_id=r.organization_id
      and s.workspace_id=r.workspace_id and s.archived_at is null
    where r.id=${context.runId} and r.policy_snapshot_id=${context.policySnapshot.id}
      and exists(select 1 from allrice_memberships m where m.user_id=r.owner_id and m.organization_id=r.organization_id
        and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.active and m.role in ('admin','member'))`;
  if (!authority)
    throw new NativeWaitAuthorityError('native_wait_authority_changed');
}

/** Native has drained the question callback and flushed its journal before
 * this call. A persisted waiting clock alone never authorizes killing work. */
export async function parkNativeQuestion(
  input: Owner & {
    checkpoint: NativeQuestionCheckpoint;
    configChecksum: string;
    generation: number;
  },
  db = getDatabase(),
) {
  const checkpoint = NativeQuestionCheckpointSchema.parse(input.checkpoint);
  return db.begin(async (tx) => {
    await lockOwner(tx, input);
    const runId = input.context.runId;
    const [safe] = await tx`select 1 from allrice_task_clocks t
      join allrice_task_questions q on q.run_id=t.run_id and q.question_id=${checkpoint.questionId} and q.pending
      where t.run_id=${runId} and t.phase='waiting'
      and not exists(select 1 from allrice_assistant_roots where root_run_id=t.run_id)
      and not exists(select 1 from allrice_task_calls c where c.run_id=t.run_id and c.finished_at is null)
      and not exists(select 1 from allrice_runtime_operations o where o.root_run_id=t.run_id and o.snapshot->>'status' not in ('succeeded','failed','canceled','partial'))`;
    if (!safe) throw Error('native_wait_not_quiescent');
    const [runtime] =
      await tx`select session_id from allrice_conversation_runtimes where active_run_id=${runId}
      and worker_id=${input.worker.workerId} and thread_id=${checkpoint.sessionId} and active_turn_id=${checkpoint.turnId}
      and config_checksum=${input.configChecksum} and thread_generation=${input.generation} and state='running' for update`;
    if (!runtime) throw Error('native_wait_conversation_changed');
    await tx`insert into allrice_native_question_waits(run_id,question_id,checkpoint,config_checksum,generation,state)
      values(${runId},${checkpoint.questionId},${tx.json(checkpoint)},${input.configChecksum},${input.generation},'parked')`;
    await tx`update allrice_jobs set status='waiting_approval',worker_id=null,lease_token=null,lease_expires_at=null,
      claimed_at=null,heartbeat_at=null,updated_at=clock_timestamp() where id=${input.worker.jobId}`;
    await tx`update allrice_runs set state='waiting_approval',updated_at=clock_timestamp() where id=${runId}`;
    // Keep the last owner for the running-session consistency constraint. Its
    // job lease is gone, so it cannot heartbeat, deliver inputs or execute.
    await tx`update allrice_native_task_dispatches set state='parked' where run_id=${runId} and state='started'`;
    await refreshTaskClock(tx, runId);
  });
}

/** A worker crash after dispatch is not a license to replay the original
 * prompt. Only a confirmed quiescent checkpoint admits another segment. */
export async function beginNativeTask(
  input: Owner & { attempt: number },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await lockOwner(tx, input);
    const prior =
      await tx`select 1 from allrice_native_task_dispatches where run_id=${input.context.runId} and state='started'`;
    if (prior.length) return false;
    const inserted =
      await tx`insert into allrice_native_task_dispatches(run_id,attempt,state)
      values(${input.context.runId},${input.attempt},'started') on conflict do nothing returning run_id`;
    return inserted.length === 1;
  });
}

export async function completeNativeTask(
  input: Owner & { attempt: number },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await lockOwner(tx, input);
    await tx`update allrice_native_task_dispatches set state='completed' where run_id=${input.context.runId} and attempt=${input.attempt} and state='started'`;
  });
}

export async function readNativeQuestionWait(
  input: Owner & { configChecksum: string; generation: number },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await lockOwner(tx, input);
    const [row] = await tx<
      {
        checkpoint: unknown;
        config_checksum: string;
        generation: number;
        state: string;
      }[]
    >`
      select checkpoint,config_checksum,generation,state from allrice_native_question_waits where run_id=${input.context.runId}
      and state <> 'continued' for update`;
    if (!row) return null;
    if (
      row.state !== 'ready' ||
      row.config_checksum !== input.configChecksum ||
      row.generation !== input.generation
    )
      throw new NativeWaitAuthorityError('native_wait_configuration_changed');
    return NativeQuestionCheckpointSchema.parse(row.checkpoint);
  });
}

export async function continueNativeQuestion(
  input: Owner & { questionId: string },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await lockOwner(tx, input);
    const rows =
      await tx`update allrice_native_question_waits set state='continued',continued_at=clock_timestamp()
      where run_id=${input.context.runId} and question_id=${input.questionId} and state='ready' returning question_id`;
    if (!rows.length) throw Error('native_wait_already_continued');
    await tx`update allrice_task_questions set pending=false where run_id=${input.context.runId} and question_id=${input.questionId}`;
    await refreshTaskClock(tx, input.context.runId);
  });
}

/** Bounded global queue maintenance; suspended Runs own no process or timer.
 * Answer submission remains the existing authenticated typed-input endpoint. */
export async function wakeNativeQuestionWaits(
  limit: number,
  db = getDatabase(),
) {
  const [table] =
    await db`select to_regclass(format('%I.allrice_native_question_waits',current_schema())) is not null as available`;
  if (!table?.available) return;
  const rows = await db<
    { run_id: string }[]
  >`select w.run_id from allrice_native_question_waits w join allrice_jobs j on j.run_id=w.run_id
    where w.state='parked' and j.status='waiting_approval' and (j.cancel_requested_at is not null or exists(
      select 1 from allrice_conversation_commands c join allrice_conversation_runtimes cr on cr.session_id=c.session_id
      where cr.active_run_id=w.run_id and cr.thread_generation=w.generation and cr.active_turn_id=w.checkpoint->>'turnId'
      and c.expected_generation=w.generation and c.expected_turn_id=w.checkpoint->>'turnId' and c.input_kind='ask_user' and c.state='pending'))
    order by w.created_at limit ${limit}`;
  for (const row of rows)
    await db.begin(async (tx) => {
      await refreshTaskClock(tx, row.run_id);
      const [job] =
        await tx`select id,cancel_requested_at from allrice_jobs where run_id=${row.run_id} and status='waiting_approval' for update`;
      if (!job) return;
      const [wait] = await tx<
        { checkpoint: unknown; generation: number }[]
      >`select checkpoint,generation from allrice_native_question_waits where run_id=${row.run_id} and state='parked' for update`;
      if (!wait) return;
      const checkpoint = NativeQuestionCheckpointSchema.parse(wait.checkpoint);
      const [runtime] =
        await tx`select session_id from allrice_conversation_runtimes where active_run_id=${row.run_id}
        and active_turn_id=${checkpoint.turnId} and thread_generation=${wait.generation} for update`;
      if (!runtime) return;
      const commands = await tx<
        { id: string; message: string }[]
      >`select id,message from allrice_conversation_commands
        where session_id=${runtime.session_id} and expected_turn_id=${checkpoint.turnId} and expected_generation=${wait.generation}
        and state='pending' order by created_at,id limit 30 for update`;
      let valid = false;
      for (const command of commands) {
        if (matchesQuestion(checkpoint, command.message)) {
          valid = true;
          break;
        }
        await tx`update allrice_conversation_commands set state='rejected',error_code='QUESTION_ANSWER_INVALID',updated_at=clock_timestamp() where id=${command.id}`;
      }
      await cancelUnadoptedSteers(tx, String(runtime.session_id));
      if (!valid && !job.cancel_requested_at) return;
      const changed =
        await tx`update allrice_native_question_waits set state='ready' where run_id=${row.run_id} and state='parked' returning question_id`;
      if (!changed.length) return;
      await tx`update allrice_jobs set status='queued',available_at=clock_timestamp(),updated_at=clock_timestamp() where id=${job.id}`;
      await tx`update allrice_runs set state='queued',updated_at=clock_timestamp() where id=${row.run_id}`;
      await refreshTaskClock(tx, row.run_id);
    });
}
