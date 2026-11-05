import type { TransactionSql } from 'postgres';
import type { Visibility, WorkspaceMemorySchema } from '@allrice/contracts';
import type { z } from 'zod';
import type { getDatabase } from '../core/client.ts';
import { memorySearchPatterns } from '../memory/search-patterns.ts';
import type { EmployeeMemoryScope } from './employee-memory.ts';

type WorkspaceMemory = z.infer<typeof WorkspaceMemorySchema>;
type Sql = ReturnType<typeof getDatabase> | TransactionSql;
type ReadScope = Pick<
  EmployeeMemoryScope,
  'organizationId' | 'workspaceId' | 'ownerId' | 'instanceId'
>;

/** Row eligibility for alias m, after the caller's current principal/instance
 * gate. A legacy review is never a substitute for personal confirmation or
 * current instance ownership. This predicate grants no permission by itself. */
export function employeeMemoryReadPredicate(sql: Sql, scope: ReadScope) {
  return sql`
    m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
    and m.owner_id=${scope.ownerId} and m.instance_id=${scope.instanceId}
    and m.archived_at is null and m.lifecycle_state='durable' and m.trust_level='user_confirmed'
    and (m.expires_at is null or m.expires_at>clock_timestamp())
    and not exists(select 1 from allrice_experience_reviews review where review.memory_id=m.id
      and (review.origin_kind in ('incremental','derived') or review.status<>'approved'
        or exists(select 1 from allrice_employee_runs origin where origin.run_id=review.run_id and origin.method_authoring)))
    and not exists(select 1 from allrice_brand_content_experiences brand where brand.memory_id=m.id)
    and not exists(select 1 from allrice_employee_runs origin
      where origin.organization_id=m.organization_id and origin.workspace_id=m.workspace_id and origin.method_authoring
        and ((m.source_type='message' and m.source_id in (origin.user_message_id,origin.assistant_message_id))
          or (m.source_type='checkpoint' and exists(select 1 from allrice_context_checkpoints cp
            where cp.id=m.source_id and cp.covered_through_message_id in (origin.user_message_id,origin.assistant_message_id)))))
  `;
}

type SearchRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  visibility: Visibility;
  revision: number;
  content: string;
  source_type: WorkspaceMemory['sourceType'];
  source_id: string | null;
  lifecycle_state: WorkspaceMemory['lifecycleState'];
  memory_class: WorkspaceMemory['memoryClass'];
  trust_level: WorkspaceMemory['trust'];
  confidence: number | string;
  source_label: string;
  captured_at: Date;
  updated_at: Date;
  relevance_score: number;
};

/** Explicit search reads confirmed rows directly; chunks/embeddings are not
 * prerequisites. Patterns only tokenize and escape a literal retrieval query,
 * never infer the speaker's intent, consent or authority. */
export async function searchConfirmedEmployeeMemories(
  sql: Sql,
  scope: ReadScope,
  query: string,
  limit: number,
) {
  const { exact, patterns } = memorySearchPatterns(query);
  if (!patterns.length) return [];
  return sql<SearchRow[]>`
    select m.id,m.organization_id,m.workspace_id,m.owner_id,m.visibility,m.revision,
      m.content,m.source_type,m.source_id,m.lifecycle_state,m.memory_class,m.trust_level,
      m.confidence,m.source_label,m.captured_at,m.updated_at,
      (select count(*)::float / ${patterns.length} from unnest(${patterns}::text[]) term(pattern)
        where m.content ilike term.pattern) as relevance_score
    from allrice_memories m
    where ${employeeMemoryReadPredicate(sql, scope)}
      and m.content ilike any(${patterns}::text[])
    order by (m.content ilike ${exact}) desc, relevance_score desc, m.updated_at desc, m.id
    limit ${Math.min(Math.max(limit, 1), 20)}
  `;
}
