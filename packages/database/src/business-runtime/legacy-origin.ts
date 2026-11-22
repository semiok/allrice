import {
  MemoryOriginSelectorProjectionSchema,
  type MemoryOriginSelectorProjection,
  type OrdinaryOriginClassificationProjection,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { DataAccessError } from '../data.ts';

type LegacyOriginScope = { organizationId: string; workspaceId: string };

/** @internal Package-source implementation/test seam, NOT an
 * @allrice/database export or a business authorization API. Do not barrel it.
 *
 * Workflow owns later private use inside the original authorized caller's
 * transaction and scope. This helper neither establishes that authority nor
 * creates/returns a SQL handle, transaction, binding, registry or factory.
 * Its internal parameters do not freeze a caller-assembly signature.
 */
export async function queryLegacyOriginForCaller(
  tx: TransactionSql,
  scope: LegacyOriginScope,
  input: MemoryOriginSelectorProjection,
  signal?: AbortSignal,
): Promise<OrdinaryOriginClassificationProjection> {
  signal?.throwIfAborted();
  const selector = MemoryOriginSelectorProjectionSchema.parse(input);
  if (selector.sourceType !== 'message' && selector.sourceType !== 'checkpoint')
    return { sourceCheck: 'not-applicable', excludedByMethodAuthoring: false };

  // Preserve the old NOT EXISTS exclusion relation exactly. The memory owner
  // retains its own scope/private/lifecycle checks; this reads source facts
  // only, with no memory table, extra owner/employee/native filter or lock.
  const query = tx<{ excluded: boolean }[]>`
    select exists(select 1 from allrice_employee_runs origin
      where origin.organization_id=${scope.organizationId}
        and origin.workspace_id=${scope.workspaceId} and origin.method_authoring
        and ((${selector.sourceType}='message'
            and ${selector.sourceId}::uuid in (origin.user_message_id,origin.assistant_message_id))
          or (${selector.sourceType}='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
            where cp.id=${selector.sourceId}
              and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id))))) excluded`;
  const cancel = () => query.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    // Cancellation requests actual driver cancellation, then still joins the
    // real SQL settlement. Never race it or wait for the enclosing commit.
    const rows = await query;
    signal?.throwIfAborted();
    if (rows.length !== 1 || typeof rows[0]?.excluded !== 'boolean')
      throw new DataAccessError('authorization_denied');
    return {
      sourceCheck: 'checked',
      excludedByMethodAuthoring: rows[0].excluded,
    };
  } catch (error) {
    // A driver acknowledgement of our cancel request must not replace the
    // original signal reason. Unrelated SQL/permission failures stay intact.
    if (
      signal?.aborted &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '57014'
    )
      signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
