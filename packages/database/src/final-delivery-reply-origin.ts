import type { RuntimeTaskRef } from '@allrice/contracts';
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

/** SELECT-only control anchors; the caller holds the current Run authority. */
export async function readFinalDeliveryTurnStartsTransaction(
  tx: RuntimeLedgerTransaction,
  {
    task,
    nativeSessionId,
    generation,
    activeTurnId,
  }: {
    task: RuntimeTaskRef;
    nativeSessionId: string;
    generation: number;
    activeTurnId: string | null;
  },
): Promise<FinalDeliveryReplyOrigin | null> {
  if (!finalDeliveryRootIsLocked(tx, task.rootRunId))
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
      payload.generation !== generation ||
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
  if (activeTurnId !== starts.at(-1)!.turnId) finalDeliveryUnavailable();
  return Object.freeze({
    schemaVersion: 1,
    rootRunId: task.rootRunId,
    nativeSessionId,
    starts: Object.freeze(starts),
  });
}
