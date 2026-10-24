/** Isolated SQL test support only. Synthetic source receipts do not claim
 * that a native journal or model executed. No lifecycle is created by a read. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Sql, TransactionSql } from 'postgres';
import { expect, vi } from 'vitest';
import * as client from '../core/client.ts';

type Subject = { org: string; workspace: string; user: string; chat: string };
export async function appendDiagnosticReceipt(
  db: Sql,
  f: Subject,
  receipt: {
    runId: string;
    nativeSessionId: string;
    attempt: number;
    generation: number;
    turn: number;
    seq: number;
  },
) {
  const [schema] = await db`select current_schema() name`;
  if (!/^p25_[a-f0-9]{32}$/.test(schema!.name))
    throw Error('Owned isolated diagnostic fixture schema required');
  const [run] = await db`select run_id from allrice_employee_runs
    where run_id=${receipt.runId} and session_id=${f.chat}
      and organization_id=${f.org} and workspace_id=${f.workspace} and owner_id=${f.user}`;
  if (!run) throw Error('Diagnostic receipt fixture Run scope mismatch');
  const [head] = await db`select coalesce(max(sequence),-1)+1 next
    from allrice_run_events where run_id=${receipt.runId}`;
  const common = {
    source: 'dsh',
    threadId: receipt.nativeSessionId,
    generation: receipt.generation,
    attempt: receipt.attempt,
  };
  const values = [
    {
      type: 'turn.started',
      payload: {
        ...common,
        turnId: `${receipt.nativeSessionId}:turn:${receipt.turn}`,
      },
    },
    {
      type: 'assistant.text.completed',
      payload: {
        ...common,
        sourceEventId: `dsh:${receipt.seq}`,
        sourceEventType: 'assistant/message',
        nativePayload: {
          turn: receipt.turn,
          text: 'SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT',
        },
      },
    },
  ];
  for (const [offset, event] of values.entries())
    await db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${receipt.runId},${Number(head!.next) + offset},${event.type},${db.json(event.payload)})`;
}

export async function snapshotDiagnosticSql(
  db: Sql | TransactionSql,
  f: Subject,
) {
  const [row] = await db<{ value: unknown }[]>`with run_ids as (
    select run_id from allrice_employee_runs where session_id=${f.chat}
      and organization_id=${f.org} and workspace_id=${f.workspace} and owner_id=${f.user}
  ), owners as (
    select runtime_id,worker_boot_id from allrice_dsh_runtime_close_observations
    where observation_kind='owned' and payload->'context'->>'contextId'=${f.chat}
      and payload->'context'->>'organizationId'=${f.org}
      and payload->'context'->>'workspaceId'=${f.workspace}
      and payload->'context'->>'ownerId'=${f.user}
  ) select jsonb_build_object(
    'chat',(select to_jsonb(c) from allrice_chat_sessions c where c.id=${f.chat}),
    'employeeRuns',(select coalesce(jsonb_agg(to_jsonb(e) order by e.run_id),'[]') from allrice_employee_runs e where e.run_id in(select run_id from run_ids)),
    'runs',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from allrice_runs r where r.id in(select run_id from run_ids)),
    'jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]') from allrice_jobs j where j.run_id in(select run_id from run_ids)),
    'roots',(select coalesce(jsonb_agg(to_jsonb(r) order by r.root_run_id),'[]') from allrice_runtime_roots r where r.root_run_id in(select run_id from run_ids)),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.run_id,e.sequence),'[]') from allrice_run_events e where e.run_id in(select run_id from run_ids)),
    'runtime',(select to_jsonb(r) from allrice_conversation_runtimes r where r.session_id=${f.chat}),
    'pins',(select coalesce(jsonb_agg(to_jsonb(b) order by b.native_session_id),'[]') from allrice_native_session_bindings b where b.context_kind='chat' and b.context_id=${f.chat}),
    'transitions',(select coalesce(jsonb_agg(to_jsonb(t) order by t.sequence),'[]') from allrice_native_chat_executor_transitions t where t.context_id=${f.chat}),
    'retirements',(select coalesce(jsonb_agg(to_jsonb(r) order by r.context_id),'[]') from allrice_native_context_retirements r where r.context_kind='chat' and r.context_id=${f.chat}),
    'closeObservations',(select coalesce(jsonb_agg(to_jsonb(o) order by o.runtime_id,o.worker_boot_id,o.observation_kind),'[]') from allrice_dsh_runtime_close_observations o join owners using(runtime_id,worker_boot_id))
  ) value`;
  return row!.value;
}

/** The diagnostic gets a real READ ONLY transaction through the existing
 * getDatabase test seam. All fixture admission/lease/bind work stays outside. */
export async function diagnosticReadOnly<T>(
  db: Sql,
  f: Subject,
  read: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const before = await snapshotDiagnosticSql(db, f);
  try {
    const result = await db.begin('read only', async (tx) => {
      const [mode] = await tx`show transaction_read_only`;
      expect(mode!.transaction_read_only).toBe('on');
      const previous = client.getDatabase();
      const database = vi
        .spyOn(client, 'getDatabase')
        .mockReturnValue(
          tx as unknown as ReturnType<typeof client.getDatabase>,
        );
      try {
        // Box the result so postgres does not apply its array unwrapping type
        // to a generic callback result.
        return { value: await read(tx) };
      } finally {
        database.mockReturnValue(previous);
      }
    });
    return result.value;
  } finally {
    expect(await snapshotDiagnosticSql(db, f)).toEqual(before);
  }
}

export async function snapshotDiagnosticFiles(
  pins: readonly { path: string }[],
) {
  return Promise.all(
    pins.map(async ({ path }) => {
      const bytes = await readFile(path),
        metadata = await stat(path);
      return {
        path,
        bytes: bytes.length,
        mtimeMs: metadata.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
}
