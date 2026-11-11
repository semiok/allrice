import type { PersonalMemoryPair } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import type { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import type { EmployeeMemoryScope } from './employee-memory.ts';

type Sql = ReturnType<typeof getDatabase> | TransactionSql;

/** Ordinary private records only. Raw reviews and business-method data retain
 * their own APIs; this predicate grants neither source nor resource access. */
export function ordinaryMemoryPredicate(tx: Sql, scope: EmployeeMemoryScope) {
  return tx`m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
    and m.owner_id=${scope.ownerId} and m.instance_id=${scope.instanceId}
    and m.employee_id=${scope.employeeId} and m.visibility='private'
    and not exists(select 1 from allrice_experience_reviews r where r.memory_id=m.id)
    and not exists(select 1 from allrice_brand_content_experiences b where b.memory_id=m.id)
    and not exists(select 1 from allrice_employee_runs origin
      where origin.organization_id=m.organization_id and origin.workspace_id=m.workspace_id and origin.method_authoring
        and ((m.source_type='message' and m.source_id in (origin.user_message_id,origin.assistant_message_id))
          or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
            where cp.id=m.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))`;
}

export const memoryPairDigest = (pair: PersonalMemoryPair) =>
  runtimePolicyDigest({
    version: 2,
    summary: pair.summary,
    details: pair.details,
  });

/** Complete compatibility body for V1 readers of newly written V2 pairs. */
export const memoryPairContent = (pair: PersonalMemoryPair) =>
  pair.details === null ? pair.summary : `${pair.summary}\n${pair.details}`;
