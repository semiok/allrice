import type { RuntimeTaskRef } from '@allrice/contracts';
import type { AssistantWorkerLease } from './assistant-runtime.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import {
  finalDeliveryRootIsLocked,
  finalDeliveryUnavailable,
} from './final-delivery-commit.ts';

/** Control references only. A native host must match the real journal and mint
 * a fresh completion capability; this value never authorizes completion. */
export interface FinalDeliveryReplyOrigin {
  readonly schemaVersion: 1;
  readonly rootRunId: string;
  readonly nativeSessionId: string;
  readonly starts: readonly {
    readonly runEventId: string;
    readonly runEventSequence: number;
    readonly turnId: string;
  }[];
}

/** Internal SELECT-only reader. The runtime owns the common root lock, current
 * lease/clock/authority checks before AND after this bounded same-Run read. */
export async function readFinalDeliveryReplyOriginTransaction(
  tx: RuntimeLedgerTransaction,
  input: {
    task: RuntimeTaskRef;
    worker: AssistantWorkerLease;
    nativeSessionId: string;
    attempt: number;
  },
): Promise<FinalDeliveryReplyOrigin | null> {
  const { task, worker, nativeSessionId, attempt } = input;
  if (
    task.runId !== task.rootRunId ||
    task.parentRunId !== null ||
    !task.chatSessionId ||
    !nativeSessionId ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(worker.generation) ||
    worker.generation < 1 ||
    !finalDeliveryRootIsLocked(tx, task.rootRunId)
  )
    finalDeliveryUnavailable();
  const [identity] = await tx<
    {
      attempt: number;
      native_session_id: string;
      thread_id: string | null;
      active_turn_id: string | null;
      thread_generation: number;
      generation: string;
      fence: string;
    }[]
  >`select j.attempt,i.native_session_id,c.thread_id,c.active_turn_id,c.thread_generation,a.generation,a.fence
    from allrice_jobs j
    join allrice_runs u on u.id=j.run_id and u.organization_id=j.organization_id and u.workspace_id=j.workspace_id
    join allrice_employee_runs e on e.run_id=u.id and e.organization_id=u.organization_id
      and e.workspace_id=u.workspace_id and e.owner_id=u.owner_id
    join allrice_assistant_roots a on a.root_run_id=u.id and a.worker_job_id=j.id
      and a.worker_id=j.worker_id and a.revoked_at is null
    join allrice_assistant_instances i on i.run_id=u.id and i.root_run_id=u.id and i.parent_run_id is null
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id
      and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id and c.active_run_id=u.id
      and c.state='running' and c.worker_id=j.worker_id
    join allrice_native_session_bindings n on n.native_session_id=i.native_session_id
      and n.organization_id=e.organization_id and n.workspace_id=e.workspace_id and n.owner_id=e.owner_id
      and n.context_kind='chat' and n.context_id=e.session_id and n.storage_context_key=e.session_id::text
      and n.profile_id='restricted'
    where j.id=${worker.jobId} and j.run_id=${task.rootRunId}
      and j.organization_id=${task.scope.organizationId} and j.workspace_id=${task.scope.workspaceId}
      and e.session_id=${task.chatSessionId} and u.project_id is not distinct from ${task.scope.projectId}::uuid
      and j.worker_id=${worker.workerId} and j.lease_token=${worker.leaseToken}
      and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp()
      and (j.drain_deadline_at is null or j.drain_deadline_at>clock_timestamp())
      and u.state in ('running','queued','waiting_approval')
    for share of j,u,e,a,i,c,n`;
  if (
    !identity ||
    identity.attempt !== attempt ||
    identity.native_session_id !== nativeSessionId ||
    identity.thread_id !== nativeSessionId ||
    Number(identity.thread_generation) !== worker.generation ||
    Number(identity.generation) !== worker.generation ||
    Number(identity.fence) !== (worker.fence ?? 1)
  )
    finalDeliveryUnavailable();
  // Do not filter malformed/foreign turn records away: an inconsistent anchor
  // in this Run is uncertainty. No all-session lookup or historical backfill.
  const rows = await tx<
    {
      id: string;
      sequence: number;
      payload: {
        source?: unknown;
        threadId?: unknown;
        turnId?: unknown;
        generation?: unknown;
      };
    }[]
  >`select id,sequence,payload from allrice_run_events
    where run_id=${task.rootRunId} and organization_id=${task.scope.organizationId}
      and workspace_id=${task.scope.workspaceId} and event_type='turn.started'
    order by sequence limit 201`;
  if (!rows.length) return null;
  if (rows.length > 200) finalDeliveryUnavailable();
  const starts: FinalDeliveryReplyOrigin['starts'][number][] = [];
  const turns = new Set<string>(),
    ids = new Set<string>();
  let lastSequence = -1;
  const prefix = `${nativeSessionId}:turn:`;
  for (const row of rows) {
    const payload = row.payload;
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence <= lastSequence ||
      payload?.source !== 'dsh' ||
      payload.threadId !== nativeSessionId ||
      payload.generation !== worker.generation ||
      typeof payload.turnId !== 'string' ||
      !payload.turnId.startsWith(prefix) ||
      !/^[1-9][0-9]*$/.test(payload.turnId.slice(prefix.length)) ||
      !Number.isSafeInteger(Number(payload.turnId.slice(prefix.length))) ||
      turns.has(payload.turnId)
    )
      finalDeliveryUnavailable();
    starts.push(
      Object.freeze({
        runEventId: row.id,
        runEventSequence: row.sequence,
        turnId: payload.turnId,
      }),
    );
    turns.add(payload.turnId);
    ids.add(row.id);
    lastSequence = row.sequence;
  }
  if (identity.active_turn_id !== starts.at(-1)!.turnId)
    finalDeliveryUnavailable();
  return Object.freeze({
    schemaVersion: 1,
    rootRunId: task.rootRunId,
    nativeSessionId,
    starts: Object.freeze(starts),
  });
}
