import type { TransactionSql } from 'postgres';

/** Legacy production is closed. Keep terminal callers and existing capture
 * markers unchanged; retirement must not rewrite history or re-scan it. */
export async function markExperienceCapturePending(
  tx: TransactionSql,
  runId: string,
) {
  void tx;
  void runId;
}
