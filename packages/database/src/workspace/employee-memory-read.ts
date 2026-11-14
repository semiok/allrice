import type { TransactionSql } from 'postgres';
import type { getDatabase } from '../core/client.ts';
import { ordinaryMemoryPredicate } from './employee-memory-primitives.ts';
import type { EmployeeMemoryScope } from './employee-memory.ts';
type Sql = ReturnType<typeof getDatabase> | TransactionSql;

/** Same ordinary collection as management/quota, narrowed to active records. */
export function personalMemoryIndexReadPredicate(
  sql: Sql,
  scope: EmployeeMemoryScope,
) {
  return sql`${ordinaryMemoryPredicate(sql, scope)}
    and m.archived_at is null and m.lifecycle_state='durable' and m.trust_level='user_confirmed'
    and (m.expires_at is null or m.expires_at>clock_timestamp())`;
}
