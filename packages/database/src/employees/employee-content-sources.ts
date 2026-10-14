import {
  EmployeeContentTextSchema,
  KnowledgeDefinitionSchema,
  KnowledgeAclEntrySchema,
  type ContentOwnership,
  type EmployeeContentReference,
  type EmployeeResolvedContent,
  type EmployeeContentIssue,
} from '@allrice/contracts';
import {
  getContentAccess,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  readReferenceSelection,
  ReferenceRuntimeError,
} from '../reference-runtime.ts';
import { resolveEffectiveKnowledgeAcl } from '../capabilities/capability-registry.ts';
import {
  canReferenceScope,
  type ContentScope,
  type ContentSql,
} from './employee-content-model.ts';

export type ResolvedContentSource = {
  dto: EmployeeResolvedContent;
  dependency: unknown;
  issue?: EmployeeContentIssue;
  publish?: { contentId: string; revisionId: string };
};
function unavailable(
  ref: EmployeeContentReference,
  code: EmployeeContentIssue['code'] = 'source_unavailable',
): ResolvedContentSource {
  return {
    dto: {
      reference: ref,
      available: false,
      ownership: null,
      canMaintain: false,
    },
    dependency: { ref, unavailable: code },
    issue: {
      code,
      contentId: ref.contentId,
      message: '引用的资料不可用、已变化或超出当前范围。',
    },
  };
}
type ResolveInput = {
  context: ContentIdentity;
  employeeId: string;
  ownership: ContentScope;
  ref: EmployeeContentReference;
  sql: ContentSql;
  lock: boolean;
  allowDraft: boolean;
  frozenPublication?: boolean;
};

/** Exact source revisions are reused; neither a scene nor a content set grants
 * tools, file access, capability bindings, or memory approval. */
export async function resolveEmployeeContentSource(
  input: ResolveInput,
): Promise<ResolvedContentSource> {
  const { context, ownership, ref, sql, lock, allowDraft } = input;
  if (['requirement', 'procedure', 'company_rule'].includes(ref.sourceKind)) {
    const [row] = await sql<
      {
        kind: string;
        content_scope: ContentScope['scope'];
        organization_id: string;
        owner_id: string;
        department_id: string | null;
        content_workspace_id: string | null;
        revision: number;
        latest_revision_id: string;
        published_revision_id: string | null;
        state: string;
        digest: string;
        content: unknown;
        published: boolean;
      }[]
    >`select a.*,r.digest,r.content,
      exists(select 1 from allrice_company_asset_publications p where p.asset_id=a.id and p.revision_id=r.id) as published
      from allrice_company_assets a join allrice_company_asset_revisions r on r.asset_id=a.id and r.id=${ref.revisionId}
      where a.id=${ref.contentId} and a.organization_id=${context.organizationId}
        and (a.content_workspace_id is null or a.content_workspace_id=${context.workspaceId})
      ${lock ? sql`for share of a,r` : sql``}`;
    const kind =
      ref.sourceKind === 'requirement'
        ? 'execution_requirement'
        : ref.sourceKind === 'company_rule'
          ? 'rule'
          : 'procedure';
    if (
      !row ||
      row.kind !== kind ||
      ['paused', 'withdrawn', 'archived'].includes(row.state)
    )
      return unavailable(ref);
    const sourceOwnership: ContentScope =
      row.content_scope === 'personal'
        ? {
            scope: 'personal',
            organizationId: row.organization_id,
            ownerId: row.owner_id,
          }
        : row.content_scope === 'department'
          ? {
              scope: 'department',
              organizationId: row.organization_id,
              departmentId: row.department_id!,
            }
          : { scope: 'company', organizationId: row.organization_id };
    const access = await getContentAccess(context, sourceOwnership, sql, lock);
    if (!access.canRead) return unavailable(ref);
    if (!canReferenceScope(ownership, sourceOwnership))
      return unavailable(ref, 'source_scope_mismatch');
    if (row.digest !== ref.digest) return unavailable(ref, 'source_changed');
    if (
      ref.sourceKind === 'company_rule' &&
      !input.frozenPublication &&
      row.published_revision_id !== ref.revisionId
    )
      return unavailable(ref, 'source_changed');
    const draft =
      !row.published &&
      allowDraft &&
      ref.sourceKind !== 'company_rule' &&
      access.canMaintain &&
      row.latest_revision_id === ref.revisionId &&
      runtimePolicyDigest(sourceOwnership) === runtimePolicyDigest(ownership);
    if (!row.published && !draft) return unavailable(ref);
    if (row.published && row.state !== 'published') return unavailable(ref);
    const text = row.content as { title?: string; body?: string };
    if (typeof text.title !== 'string' || typeof text.body !== 'string')
      return unavailable(ref);
    return {
      dto: {
        reference: ref,
        available: true,
        ownership: sourceOwnership,
        canMaintain: access.canMaintain,
        title: text.title,
        body: text.body,
      },
      dependency: {
        ref,
        state: row.state,
        revision: row.revision,
        latest: row.latest_revision_id,
        published: row.published_revision_id,
        sourceOwnership,
      },
      ...(draft
        ? { publish: { contentId: ref.contentId, revisionId: ref.revisionId } }
        : {}),
    };
  }
  if (ref.sourceKind === 'knowledge') {
    const [managed] = await sql`select id from allrice_knowledge_sources
      where id=${ref.contentId} and ownership is not null`;
    if (managed) {
      try {
        const { selection } = await readReferenceSelection(
          context,
          ref.revisionId,
          sql,
          lock,
        );
        if (selection.sourceId !== ref.contentId) return unavailable(ref);
        if (selection.digest !== ref.digest)
          return unavailable(ref, 'source_changed');
        if (!canReferenceScope(ownership, selection.ownership))
          return unavailable(ref, 'source_scope_mismatch');
        const access = await getContentAccess(
          context,
          selection.ownership,
          sql,
          lock,
        );
        return {
          dto: {
            reference: ref,
            available: true,
            ownership: selection.ownership,
            canMaintain: access.canMaintain,
            title: selection.fileName,
            body: selection.purpose,
            referenceFile: selection,
          },
          dependency: { ref, selection },
        };
      } catch (error) {
        if (error instanceof ReferenceRuntimeError) return unavailable(ref);
        throw error;
      }
    }
  }
  if (ref.sourceKind === 'knowledge' || ref.sourceKind === 'workflow') {
    const knowledge = ref.sourceKind === 'knowledge';
    const sourceTable = knowledge
      ? 'allrice_knowledge_sources'
      : 'allrice_workflows';
    const revisionTable = knowledge
      ? 'allrice_knowledge_revisions'
      : 'allrice_workflow_revisions';
    const sourceColumn = knowledge ? 'knowledge_source_id' : 'workflow_id';
    const bindingTable = knowledge
      ? 'allrice_employee_knowledge_bindings'
      : 'allrice_employee_workflow_bindings';
    const bindingColumn = knowledge
      ? 'knowledge_revision_id'
      : 'workflow_revision_id';
    const [row] = await sql<
      {
        name: string;
        description: string;
        definition: unknown;
        checksum: string;
        binding_id: string;
      }[]
    >`select r.name,r.description,r.definition,r.checksum,b.id as binding_id
      from ${sql(sourceTable)} s join ${sql(revisionTable)} r on r.${sql(sourceColumn)}=s.id
      join ${sql(bindingTable)} b on b.${sql(bindingColumn)}=r.id and b.employee_id=${input.employeeId}
      where s.id=${ref.contentId} and r.id=${ref.revisionId} and s.organization_id=${context.organizationId}
        and s.workspace_id=${context.workspaceId} and s.status='active' and r.status='published' and b.enabled
        ${knowledge ? sql`and s.ownership is null` : sql``}
      ${lock ? sql`for share of s,r,b` : sql``}`;
    if (!row) return unavailable(ref);
    if (row.checksum !== ref.digest) return unavailable(ref, 'source_changed');
    let aclDependency: unknown = null;
    if (knowledge) {
      const entries = await sql<
        { principal_type: string; principal_id: string; permission: string }[]
      >`
        select principal_type,principal_id,permission from allrice_knowledge_acl_entries
        where knowledge_revision_id=${ref.revisionId} order by id ${lock ? sql`for share` : sql``}`;
      const effective = resolveEffectiveKnowledgeAcl(
        entries.map((a) =>
          KnowledgeAclEntrySchema.parse({
            principalType: a.principal_type,
            principalId: a.principal_id,
            permission: a.permission,
          }),
        ),
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId!,
          employeeId: input.employeeId,
          actorId: context.actor.id,
        },
      );
      if (!effective.length) return unavailable(ref);
      if (
        ownership.scope !== 'personal' &&
        !effective.some(
          (a) =>
            a.principalType === 'organization' ||
            a.principalType === 'workspace',
        )
      )
        return unavailable(ref, 'source_scope_mismatch');
      const definition = KnowledgeDefinitionSchema.parse(row.definition);
      // Existing registry ACL applies to metadata. File/connector retrieval
      // must still pass its own reader; no original file bytes are exposed here.
      // User-bound sources cannot become shared by saving a reference.
      if (
        ownership.scope !== 'personal' &&
        (definition.connectorBindingId ||
          definition.resourceRef.startsWith('file:'))
      )
        return unavailable(ref, 'source_scope_mismatch');
      aclDependency = effective;
    }
    return {
      dto: {
        reference: ref,
        available: true,
        title: row.name,
        body: row.description,
        ownership: null,
        canMaintain: false,
      },
      dependency: { ref, binding: row.binding_id, acl: aclDependency },
    };
  }
  const [memory] = await sql<
    {
      owner_id: string;
      visibility: string;
      content: string;
      revision: number;
      trust_level: string;
      lifecycle_state: string;
      expires_at: Date | null;
    }[]
  >`select m.owner_id,m.visibility,r.content,r.revision,r.trust_level,r.lifecycle_state,m.expires_at
    from allrice_memories m join allrice_memory_revisions r on r.memory_id=m.id and r.revision=m.revision
    where m.id=${ref.contentId} and r.id=${ref.revisionId} and m.organization_id=${context.organizationId}
      and m.workspace_id=${context.workspaceId} and m.employee_id=${input.employeeId} and m.archived_at is null
      and m.lifecycle_state='durable' and m.trust_level in ('user_confirmed','platform_verified')
      and (m.expires_at is null or m.expires_at>clock_timestamp())
      and (m.visibility<>'private' or m.owner_id=${context.actor.id})
      and not exists(select 1 from allrice_experience_reviews e where e.memory_id=m.id and e.status<>'approved')
    ${lock ? sql`for share of m,r` : sql``}`;
  if (!memory) return unavailable(ref);
  // Workspace memory is not a new company/department publication. MET183
  // provides automatic accumulation; this adapter only references existing trust.
  if (ownership.scope !== 'personal')
    return unavailable(ref, 'source_scope_mismatch');
  const digest = runtimePolicyDigest({
    memoryId: ref.contentId,
    revisionId: ref.revisionId,
    revision: memory.revision,
    content: memory.content,
  });
  if (digest !== ref.digest) return unavailable(ref, 'source_changed');
  const sourceOwnership: ContentOwnership | null =
    memory.visibility === 'private'
      ? {
          scope: 'personal',
          organizationId: context.organizationId,
          ownerId: memory.owner_id,
        }
      : null;
  return {
    dto: {
      reference: ref,
      available: true,
      title: '已确认经验',
      body: memory.content,
      ownership: sourceOwnership,
      canMaintain: false,
    },
    dependency: {
      ref,
      revision: memory.revision,
      visibility: memory.visibility,
      expiresAt: memory.expires_at?.toISOString() ?? null,
    },
  };
}

export function parseContentText(input: unknown) {
  return EmployeeContentTextSchema.parse(input);
}
