import { runtimeFeatureEnabled } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';

/** Called inside the real terminal transaction, including workflow rejection.
 * Input withdrawal and unadopted steering are not execution completions. */
export async function markExperienceCapturePending(
  tx: TransactionSql,
  runId: string,
) {
  if (!runtimeFeatureEnabled('ALLRICE_EXPERIENCE_REVIEW_ENABLED')) return;
  await tx`update allrice_employee_runs set experience_capture_state='pending'
    where run_id=${runId} and experience_capture_state is null and not method_authoring
      and status in ('succeeded','failed','canceled') and completed_at is not null`;
}
