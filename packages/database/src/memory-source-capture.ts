import type { TransactionSql } from 'postgres';

/** Version of the producer, not a lifecycle state. Old pending/ignored rows
 * are never upgraded. The collector separately enforces the policy watermark. */
export const memorySourceProducer = 'memory_source_v2';

export function memorySourceCaptureEnabled(
  environment: Record<string, string | undefined> = process.env,
) {
  return environment.ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED === '1';
}

export async function markMemorySourcePending(
  tx: TransactionSql,
  runId: string,
) {
  if (!memorySourceCaptureEnabled()) return;
  await tx`update allrice_employee_runs set memory_source_capture_state='pending',
      memory_source_capture_reason=${memorySourceProducer}
    where run_id=${runId} and memory_source_capture_state is null and not method_authoring
      and status in ('succeeded','failed','canceled') and completed_at is not null`;
}
