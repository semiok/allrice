import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { refreshTaskClock } from './task-clock.ts';
import { cancelAssistantRootTransaction } from './assistant-runtime.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';
import { verifiedRootSubscription } from './subscription-token-accounting.ts';
import {
  initialProgressState,
  observeProgress,
  type ProgressState,
} from './task-progress-policy.ts';

const id = z.string().min(1).max(240),
  digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check'), nativeSessionId: id }).strict(),
  z
    .object({
      action: z.literal('start'),
      nativeSessionId: id,
      callId: id,
      kind: z.enum(['model', 'tool']),
      name: z.string().max(160).optional(),
      argumentsDigest: digest.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      nativeSessionId: id,
      callId: id,
      kind: z.enum(['model', 'tool']),
      resultDigest: digest,
      outcome: z.enum([
        'success',
        'error',
        'empty',
        'poll',
        'control',
        'retry',
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal('decide'),
      nativeSessionId: id,
      pauseId: z.uuid(),
      decision: z.enum(['continue', 'cancel']),
    })
    .strict(),
]);

/** Worker-only port bound to an already authorized Run, never a browser tool.
 * The adapter additionally binds native IDs to its live owned root/tree. */
export function createTaskProgressRuntime(
  input: {
    context: ExecutionContext;
    worker: { jobId: string; workerId: string; leaseToken: string };
  },
  db = getDatabase(),
) {
  const { context, worker } = input,
    runId = context.runId;
  return async (raw: unknown): Promise<Record<string, unknown>> => {
    const p = Request.parse(raw);
    return db.begin(async (tx) => {
      await refreshTaskClock(tx, runId); // root -> clock -> job
      const [clock] =
        await tx`select 1 from allrice_task_clocks where run_id=${runId}`;
      if (!clock) throw Error('task_progress_not_enrolled');
      const [job] =
        await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
        where j.id=${worker.jobId} and j.run_id=${runId} and j.worker_id=${worker.workerId} and j.lease_token=${worker.leaseToken}
          and j.status='running' and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null
          and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId!} and r.owner_id=${context.delegatedBy.id}
        for update of j`;
      if (!job) throw Error('task_progress_lease_lost');
      if (
        !(await verifiedRootSubscription(
          tx,
          {
            rootRunId: runId,
            scope: {
              organizationId: context.organizationId,
              workspaceId: context.workspaceId!,
            },
          },
          runtimeLedgerInputDigest,
        ))
      )
        throw Error('task_progress_subscription_required');
      await tx`insert into allrice_task_progress(run_id) values(${runId}) on conflict do nothing`;
      const [row] = await tx<
        { state: ProgressState; pause_id: string | null; canceled: boolean }[]
      >`select * from allrice_task_progress where run_id=${runId} for update`;
      if (row!.canceled) throw Error('task_progress_canceled');
      let state = row!.state,
        pauseId = row!.pause_id;
      if (p.action === 'start') {
        if (p.kind === 'tool' && (!p.name || !p.argumentsDigest))
          throw Error('task_progress_tool_identity_required');
        if (p.kind === 'model' && pauseId) throw Error('task_progress_paused');
        const added =
          await tx`insert into allrice_task_calls(run_id,native_session_id,call_id,kind,name,arguments_digest)
          values(${runId},${p.nativeSessionId},${p.callId},${p.kind},${p.name ?? null},${p.argumentsDigest ?? null}) on conflict do nothing returning call_id`;
        if (!added.length) throw Error('task_progress_call_unknown_no_replay');
      } else if (p.action === 'finish') {
        const [call] =
          await tx`select * from allrice_task_calls where run_id=${runId} and native_session_id=${p.nativeSessionId} and call_id=${p.callId} and kind=${p.kind} for update`;
        if (!call) throw Error('task_progress_call_missing');
        if (call.finished_at) {
          if (
            call.result_digest !== p.resultDigest ||
            call.outcome !== p.outcome
          )
            throw Error('task_progress_receipt_conflict');
        } else {
          await tx`update allrice_task_calls set finished_at=clock_timestamp(),result_digest=${p.resultDigest},outcome=${p.outcome}
            where run_id=${runId} and native_session_id=${p.nativeSessionId} and call_id=${p.callId} and kind=${p.kind}`;
          if (p.kind === 'tool')
            state = observeProgress(state, {
              name: call.name,
              argumentsDigest: call.arguments_digest,
              resultDigest: p.resultDigest,
              outcome: p.outcome,
            });
          if (state.reason && !pauseId) pauseId = randomUUID();
        }
      } else if (p.action === 'decide') {
        const [prior] =
          await tx`select decision from allrice_task_progress_decisions where run_id=${runId} and pause_id=${p.pauseId}`;
        if (prior && prior.decision !== p.decision)
          throw Error('task_progress_decision_conflict');
        if (!prior) {
          if (p.pauseId !== pauseId) throw Error('task_progress_stale_pause');
          await tx`insert into allrice_task_progress_decisions(run_id,pause_id,decision,actor_id) values(${runId},${p.pauseId},${p.decision},${context.delegatedBy.id})`;
          if (p.decision === 'cancel') {
            await tx`update allrice_task_progress set canceled=true where run_id=${runId}`;
            await cancelAssistantRootTransaction(tx, runId, randomUUID());
            await tx`update allrice_jobs set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where id=${worker.jobId}`;
          } else {
            state = initialProgressState();
            pauseId = null;
          }
        }
      }
      await tx`update allrice_task_progress set state=${tx.json(JSON.parse(JSON.stringify(state)))},pause_id=${pauseId},updated_at=clock_timestamp() where run_id=${runId}`;
      await refreshTaskClock(tx, runId);
      return {
        paused: !!pauseId,
        pauseId,
        reason: state.reason,
        recent: state.history
          .slice(-3)
          .map((f) => ({ tool: f.name, outcome: f.outcome })),
        canceled: p.action === 'decide' && p.decision === 'cancel',
      };
    });
  };
}
