import { MemorySourceCollectionPolicySchema } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';

export const memorySourcePolicyKey = 'employee_memory_source_policy';
/** No system/legacy fallback: only an explicitly configured organization opts in. */
export async function readMemorySourceCollectionPolicy(
  tx: TransactionSql,
  organizationId: string,
) {
  const [row] = await tx<
    { value: unknown }[]
  >`select value from allrice_settings
    where scope_type='organization' and scope_id=${organizationId} and key=${memorySourcePolicyKey}`;
  const parsed = MemorySourceCollectionPolicySchema.safeParse(row?.value);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}
