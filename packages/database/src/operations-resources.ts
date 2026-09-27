import {
  WorkerOperationsSchema,
  type WorkerOperations,
  type OperationsInventory,
} from '@allrice/contracts';
import { getDiagnosticsDatabase } from './core/client.ts';

const prefix = 'worker-operations:';

export async function recordWorkerOperations(
  input: WorkerOperations,
  sql = getDiagnosticsDatabase(),
) {
  const value = WorkerOperationsSchema.parse(input);
  await sql`insert into allrice_runtime_metadata(key,value,updated_at)
    values(${prefix + value.workerId},${sql.json(value)},clock_timestamp())
    on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at`;
}

export async function removeWorkerOperations(
  workerId: string,
  sql = getDiagnosticsDatabase(),
) {
  await sql`delete from allrice_runtime_metadata where key=${prefix + workerId}`;
}

/** Admin-only caller. Never query the Docker socket or run host commands from Web. */
export async function readOperationsInventory(
  sql = getDiagnosticsDatabase(),
): Promise<OperationsInventory> {
  const rows = await sql<
    { value: unknown; updated_at: Date; online: boolean; checked_at: Date }[]
  >`
    select value,updated_at,updated_at > statement_timestamp()-interval '90 seconds' as online,
      statement_timestamp() as checked_at
    from allrice_runtime_metadata where starts_with(key,${prefix})
      and updated_at > statement_timestamp()-interval '7 days'
    order by updated_at desc limit 100`;
  const workers: OperationsInventory['workers'] = [];
  // A crash leaves a stale row. Keep the latest stale host only when it has no
  // live Worker; shared physical backends are separately deduplicated in UI.
  const hosts = new Set<string>();
  for (const row of rows) {
    const parsed = WorkerOperationsSchema.safeParse(row.value);
    if (!parsed.success || (!row.online && hosts.has(parsed.data.hostname)))
      continue;
    hosts.add(parsed.data.hostname);
    workers.push({
      ...parsed.data,
      observedAt: row.updated_at.toISOString(),
      online: row.online,
    });
  }
  return {
    checkedAt: rows[0]?.checked_at.toISOString() ?? new Date().toISOString(),
    workers,
  };
}
