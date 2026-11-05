import type { TransactionSql } from 'postgres';
import {
  selectEmployeeDocumentMemories, selectEmployeeUserFacts,
  renderEmployeeMemoryDocument, renderEmployeeUserDocument,
  type EmployeeUserFacts, type MemoryContextItem,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { employeeMemoryReadPredicate } from '../workspace/employee-memory-read.ts';

/** Stable locator, not a capability. Every read must find an issued pin in the
 * current Run and recheck current organization/owner/instance/confirmation. */
export function confirmedMemoryHandle(item: MemoryContextItem) {
  return `experience:${runtimePolicyDigest({
    id: item.id, revision: item.revision, content: item.content,
  })}`;
}

export function employeeMemoryDocument(items: readonly MemoryContextItem[], total: number) {
  return renderEmployeeMemoryDocument(items, total,
    runtimePolicyDigest({ items, eligibleCount: total }));
}

/** Called only after the ordinary chat admission's current principal/instance
 * gate, in its existing binding transaction. No query or vector ranking. */
export async function freezeEmployeeDocuments(
  sql: ReturnType<typeof getDatabase> | TransactionSql,
  scope: { organizationId: string; workspaceId: string; ownerId: string; instanceId: string },
  facts: EmployeeUserFacts,
  sourceTool: boolean,
) {
  const rows = await sql<{ id: string; revision: number; content: string }[]>`
    select m.id,m.revision,m.content from allrice_memories m
    where ${employeeMemoryReadPredicate(sql, scope)}
    order by case when jsonb_typeof(m.metadata->'memoryPinOrder')='number'
      then (m.metadata->>'memoryPinOrder')::numeric end asc nulls last,
      m.updated_at desc,m.id`;
  const memories = selectEmployeeDocumentMemories(rows.map((row) => ({
    id: row.id, revision: row.revision, content: row.content,
    ...(sourceTool ? { sourceHandle: confirmedMemoryHandle(row) } : {}),
  })), rows.length);
  const user = selectEmployeeUserFacts(facts);
  return {
    memories,
    employeeDocuments: {
      user: renderEmployeeUserDocument(user.facts, user.omitted, runtimePolicyDigest(user)),
      memory: employeeMemoryDocument(memories, rows.length),
    },
  };
}
