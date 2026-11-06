import { runtimeFeatureEnabled } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';

/** Version of the producer, not a lifecycle state. Old pending/ignored rows
 * are never upgraded. The collector separately enforces the policy watermark. */
export const memorySourceProducer = 'memory_source_v2';

export async function markMemorySourcePending(
  tx: TransactionSql,
  runId: string,
) {
  if (!runtimeFeatureEnabled('ALLRICE_EXPERIENCE_REVIEW_ENABLED')) return;
  await tx`update allrice_employee_runs set experience_capture_state='pending',
      experience_capture_reason=${memorySourceProducer}
    where run_id=${runId} and experience_capture_state is null and not method_authoring
      and status in ('succeeded','failed','canceled') and completed_at is not null`;
}
