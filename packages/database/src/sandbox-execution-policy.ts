import type postgres from 'postgres';
import {
  resolveSandboxExecutionPolicy,
  type SandboxExecutionPolicy,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';

/** The selected row is per field: an unrelated tenant quota override whose
 * sandbox field is NULL still inherits an explicit platform sandbox limit. */
export async function freezeSandboxExecutionPolicy(
  input: { organizationId: string; userId: string },
  sql: postgres.Sql | postgres.TransactionSql = getDatabase(),
): Promise<SandboxExecutionPolicy> {
  const rows = await sql<
    {
      scope_type: 'tenant' | 'user';
      scope_id: string;
      organization_id: string | null;
      max_sandbox_execution_ms: 600000 | 1800000 | 3600000;
    }[]
  >`
    select distinct on (scope_type) scope_type,scope_id,organization_id,max_sandbox_execution_ms
    from allrice_model_resource_limits
    where (organization_id=${input.organizationId} or organization_id is null)
      and max_sandbox_execution_ms is not null
      and ((scope_type='tenant' and scope_id=${input.organizationId})
        or (scope_type='user' and scope_id=${input.userId}))
    order by scope_type,organization_id nulls last`;
  return resolveSandboxExecutionPolicy(
    rows.map((row) => ({
      scope: row.scope_type,
      scopeId: row.scope_id,
      source:
        row.organization_id === null ? 'platform_override' : 'tenant_override',
      maxExecutionMs: row.max_sandbox_execution_ms,
    })),
  );
}
