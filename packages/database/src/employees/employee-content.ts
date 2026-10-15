import { randomUUID } from 'node:crypto';
import {
  EmployeeContentMutationSchema,
  EmployeeContentManifestSchema,
  EmployeeContentReceiptSchema,
  EmployeeContentSetSchema,
  EmployeeEffectiveContentSchema,
  EmployeeRuntimeContentSchema,
  PlatformEmployeeDefinitionSchema,
  UuidSchema,
  employeeContentLimits,
  type EmployeeMethodSharedTarget,
  type RequestContext,
  type EmployeeContentMutation,
  type EmployeeContentManifest,
  type EmployeeContentReference,
  type EmployeeContentSet,
  type EmployeeContentIssue,
  type EmployeeContentValidation,
  type EmployeeContentReceipt,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  getContentAccess,
  readContentPrincipal,
  requireContentMaintenance,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  getEmployeeInstance,
  readEmployeeVersionPublication,
} from './employee-instances.ts';
import {
  resolveEmployeeContentSource,
  parseContentText,
  type ResolvedContentSource,
} from './employee-content-sources.ts';
import {
  EmployeeContentError,
  contentOwnership,
  contentTarget,
  type ContentSql,
  type ContentTx,
  type ContentScope,
  type ContentTarget,
  type ContentSetRow,
  type ContentRevisionRow,
} from './employee-content-model.ts';
import { resolveEmployeeMethodTarget } from './employee-method-target.ts';
export { EmployeeContentError } from './employee-content-model.ts';

// HTTP callers provide a login Session; Worker callers provide current Run
// authority. Never fabricate a login Session ID from the conversation ID.
type EmployeeContentContext = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId' | 'requestId'
> &
  Partial<Pick<RequestContext, 'sessionId'>>;

type ResolvedTarget = {
  employeeId: string;
  versionId: string;
  instanceId: string | null;
};
const emptyManifest: EmployeeContentManifest = {
  schemaVersion: 1,
  common: [],
  scenes: [],
  declaredConflicts: [],
};
function refs(manifest: EmployeeContentManifest) {
  return [...manifest.common, ...manifest.scenes.flatMap((s) => s.references)];
}
function exactKey(ref: EmployeeContentReference) {
  return `${ref.sourceKind}:${ref.contentId}:${ref.revisionId}:${ref.digest}`;
}
function revisionDto(row: ContentRevisionRow) {
  return {
    id: row.id,
    number: row.number,
    digest: row.digest,
    manifest: row.manifest,
    changeSummary: row.change_summary,
    restoredFromRevisionId: row.restored_from_revision_id,
    createdAt: row.created_at.toISOString(),
  };
}
async function readRevision(sql: ContentSql, id: string | null) {
  if (!id) return null;
  const [row] = await sql<
    ContentRevisionRow[]
  >`select * from allrice_employee_content_revisions where id=${id}`;
  if (!row) throw new DataAccessError('not_found');
  return {
    ...row,
    manifest: EmployeeContentManifestSchema.parse(row.manifest),
  };
}
async function setDto(
  context: EmployeeContentContext,
  row: ContentSetRow,
  sql: ContentSql,
): Promise<EmployeeContentSet> {
  const access = await getContentAccess(context, contentOwnership(row), sql);
  if (!access.canRead) throw new DataAccessError('not_found');
  const active = await readRevision(sql, row.active_revision_id);
  // Shared readers see the active publication; drafts remain with maintainers.
  const candidate = access.canMaintain
    ? await readRevision(sql, row.candidate_revision_id)
    : null;
  return EmployeeContentSetSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    ownership: contentOwnership(row),
    target: contentTarget(row),
    revision: row.revision,
    candidate: candidate ? revisionDto(candidate) : null,
    active: active ? revisionDto(active) : null,
    validation: access.canMaintain ? row.validation : null,
    access,
  });
}

async function resolveTarget(
  context: EmployeeContentContext,
  target: ContentTarget,
  sql: ContentSql,
  lock: boolean,
): Promise<ResolvedTarget> {
  let versionId: string;
  const instance =
    target.kind === 'instance'
      ? await getEmployeeInstance(context, target.instanceId, sql)
      : null;
  const [initial] = instance
    ? await sql<{ employee_id: string }[]>`
    select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`
    : [];
  const employeeId =
    target.kind === 'employee'
      ? target.employeeId
      : (initial?.employee_id ?? '');
  if (!employeeId) throw new DataAccessError('not_found');
  // Platform publication and withdrawal use different employee-row orders.
  // As in instance admission, serialize only on the actual assignment (or
  // shared deployment) and then recheck status without another outer row lock.
  let lockLegacyEmployee = false;
  if (target.kind === 'instance') {
    const [assignment] = await sql<
      { employee_id: string; employee_version_id: string }[]
    >`
      select employee_id,employee_version_id from allrice_employee_assignments
      where id=${instance!.assignmentId} and employee_id=${employeeId} and active ${lock ? sql`for share` : sql``}`;
    if (!assignment) throw new DataAccessError('authorization_denied');
    versionId = assignment.employee_version_id;
    if (lock)
      await sql`select id from allrice_employee_instances where id=${target.instanceId} for share`;
    // Publication/revocation may have committed while waiting for the row.
    await getEmployeeInstance(context, target.instanceId, sql);
  } else {
    const [deployment] = await sql<
      { active: boolean; tenant_employee_version_id: string }[]
    >`
      select active,tenant_employee_version_id from allrice_platform_employee_tenant_assignments
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
        and tenant_employee_id=${employeeId} ${lock ? sql`for share` : sql``}`;
    if (deployment && !deployment.active)
      throw new DataAccessError('not_found');
    lockLegacyEmployee = !deployment;
    const [version] = deployment
      ? []
      : await sql<{ id: string }[]>`
      select id from allrice_employee_versions where employee_id=${employeeId}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} order by version desc limit 1`;
    versionId = deployment?.tenant_employee_version_id ?? version?.id ?? '';
    if (!versionId) throw new DataAccessError('not_found');
  }
  const [employee] =
    await sql`select id from allrice_employees where id=${employeeId}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and status='active'
    ${lock && lockLegacyEmployee ? sql`for share` : sql``}`;
  if (!employee) throw new DataAccessError('not_found');
  if (lock && lockLegacyEmployee) {
    const [newDeployment] =
      await sql`select id from allrice_platform_employee_tenant_assignments
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and tenant_employee_id=${employeeId}`;
    if (newDeployment) throw new EmployeeContentError('version_conflict');
  }
  return {
    employeeId,
    versionId,
    instanceId: target.kind === 'instance' ? target.instanceId : null,
  };
}

async function platformContent(
  context: ContentIdentity,
  target: ResolvedTarget,
  sql: ContentSql,
) {
  const source = await readEmployeeVersionPublication(
    {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId!,
      employeeId: target.employeeId,
      versionId: target.versionId,
    },
    sql,
  );
  if (source) {
    const definition = PlatformEmployeeDefinitionSchema.parse(
      source.definition,
    );
    return {
      revisionId: source.revision_id,
      digest: source.checksum,
      requirements: [
        ...definition.identity.behaviorRules,
        ...definition.identity.safetyBoundaries,
      ],
    };
  }
  const [legacy] = await sql<
    { config_checksum: string }[]
  >`select config_checksum from allrice_employee_versions
    where id=${target.versionId} and employee_id=${target.employeeId}`;
  if (!legacy) throw new DataAccessError('not_found');
  return { revisionId: null, digest: legacy.config_checksum, requirements: [] };
}

async function inheritedRows(
  context: ContentIdentity,
  target: ResolvedTarget,
  scope: ContentScope,
  sql: ContentSql,
) {
  const principal = await readContentPrincipal(context, sql);
  if (!principal) throw new DataAccessError('authorization_denied');
  const departmentId =
    scope.scope === 'department' ? scope.departmentId : principal.departmentId;
  return sql<ContentSetRow[]>`select * from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and employee_id=${target.employeeId} and active_revision_id is not null
      and (scope='company' or (scope='department' and department_id=${departmentId} and ${scope.scope !== 'company'})
        or (scope='personal' and instance_id=${target.instanceId} and owner_id=${context.actor.id} and ${scope.scope === 'personal'}))
    order by case scope when 'company' then 0 when 'department' then 1 else 2 end,id`;
}

/** The same resolver powers validation and effective reads. Inherited indexes
 * are additive; a lower manifest cannot delete or replace an upstream entry. */
async function assemble(
  context: EmployeeContentContext,
  target: ResolvedTarget,
  ownership: ContentScope,
  sql: ContentSql,
  candidate?: { row: ContentSetRow; revision: ContentRevisionRow },
  lock = false,
) {
  const platform = await platformContent(context, target, sql);
  const rows = await inheritedRows(context, target, ownership, sql);
  if (candidate) {
    const existing = rows.findIndex((r) => r.id === candidate.row.id);
    if (existing >= 0) rows[existing] = candidate.row;
    else rows.push(candidate.row);
  }
  const issues: EmployeeContentIssue[] = [],
    common: EmployeeContentReference[] = [];
  const scenes: EmployeeContentManifest['scenes'] = [];
  const dependencies: unknown[] = [{ versionId: target.versionId, platform }];
  const sources = new Map<string, ResolvedContentSource>();
  const identities = new Map<string, string>();
  const append = (
    list: EmployeeContentReference[],
    ref: EmployeeContentReference,
  ) => {
    if (!list.some((old) => exactKey(old) === exactKey(ref))) list.push(ref);
  };
  for (const row of rows) {
    if (
      !(await getContentAccess(context, contentOwnership(row), sql, lock))
        .canRead
    )
      continue;
    const rev =
      row.id === candidate?.row.id
        ? candidate.revision
        : await readRevision(sql, row.active_revision_id);
    if (!rev) continue;
    dependencies.push({ id: row.id, revisionId: rev.id, digest: rev.digest });
    if (rev.manifest.declaredConflicts.length)
      issues.push({
        code: 'declared_conflict',
        message: '存在尚未解决的内容冲突。',
      });
    const sourceRefs = [
      ...new Map(refs(rev.manifest).map((r) => [exactKey(r), r])).values(),
    ].sort((a, b) => exactKey(a).localeCompare(exactKey(b)));
    for (const ref of sourceRefs) {
      const identity = `${ref.sourceKind}:${ref.contentId}`,
        previous = identities.get(identity);
      if (previous && previous !== exactKey(ref))
        issues.push({
          code: 'mandatory_rule_conflict',
          contentId: ref.contentId,
          message: '同一内容引用了不同版本；请先统一来源版本。',
        });
      identities.set(identity, exactKey(ref));
      // Validate the source against EACH owning layer, even when a personal
      // user could independently read the same source through another grant.
      const resolved = await resolveEmployeeContentSource({
        context,
        employeeId: target.employeeId,
        ownership: contentOwnership(row),
        ref,
        sql,
        lock,
        allowDraft: row.id === candidate?.row.id,
      });
      if (resolved.issue) issues.push(resolved.issue);
      dependencies.push({ layer: row.id, source: resolved.dependency });
      const old = sources.get(exactKey(ref));
      if (!old || !resolved.dto.available) sources.set(exactKey(ref), resolved);
    }
    for (const ref of rev.manifest.common) append(common, ref);
    for (const scene of rev.manifest.scenes) {
      const existing = scenes.find((s) => s.id === scene.id);
      if (
        existing &&
        (existing.name !== scene.name ||
          existing.appliesWhen !== scene.appliesWhen)
      )
        issues.push({
          code: 'scene_conflict',
          sceneId: scene.id,
          message: '继承场景的名称或适用条件不一致。',
        });
      const merged = existing ?? { ...scene, references: [] };
      for (const ref of scene.references) append(merged.references, ref);
      if (!existing) scenes.push(merged);
    }
  }
  const resolved = [...sources.values()];
  if (
    scenes.length > employeeContentLimits.scenes ||
    sources.size > employeeContentLimits.references ||
    resolved.reduce((n, s) => n + Buffer.byteLength(s.dto.body ?? ''), 0) >
      employeeContentLimits.textBytes
  )
    issues.push({
      code: 'content_budget_exceeded',
      message: '合并后的场景或内容超过预算，请精简后重试。',
    });
  const validation: EmployeeContentValidation = {
    valid: !issues.length,
    issues,
    dependencyDigest: runtimePolicyDigest(dependencies),
    semanticConsistency: 'not_proven',
  };
  return { platform, rows, common, scenes, resolved, validation };
}

async function saveTextEdits(
  context: EmployeeContentContext,
  input: Extract<EmployeeContentMutation, { operation: 'save_draft' }>,
  tx: ContentTx,
) {
  const mapped = new Map<string, EmployeeContentReference>();
  for (const edit of [...input.textEdits].sort((a, b) =>
    a.contentId.localeCompare(b.contentId),
  )) {
    const text = parseContentText({
      kind: edit.kind,
      title: edit.title,
      body: edit.body,
    });
    const kind =
      edit.kind === 'requirement' ? 'execution_requirement' : 'procedure';
    const [old] = await tx<
      {
        organization_id: string;
        owner_id: string;
        department_id: string | null;
        content_scope: ContentScope['scope'];
        content_workspace_id: string | null;
        kind: string;
        revision: number;
        state: string;
      }[]
    >`
      select * from allrice_company_assets where id=${edit.contentId} for update`;
    if (old) {
      const stored = contentOwnership({ ...old, scope: old.content_scope });
      if (
        old.organization_id !== context.organizationId ||
        old.content_workspace_id !== context.workspaceId ||
        runtimePolicyDigest(stored) !== runtimePolicyDigest(input.ownership) ||
        old.kind !== kind
      )
        throw new DataAccessError('not_found');
      if (
        old.revision !== edit.expectedRevision ||
        ['archived', 'paused', 'withdrawn'].includes(old.state)
      )
        throw new EmployeeContentError('version_conflict');
    } else {
      if (edit.expectedRevision !== 0)
        throw new EmployeeContentError('version_conflict');
      await tx`insert into allrice_company_assets(id,organization_id,owner_id,kind,content_scope,content_workspace_id,department_id)
        values(${edit.contentId},${context.organizationId},${context.actor.id},${kind},${input.ownership.scope},${context.workspaceId},
          ${input.ownership.scope === 'department' ? input.ownership.departmentId : null})`;
    }
    const digest = runtimePolicyDigest(text),
      next = (old?.revision ?? 0) + 1;
    await tx`insert into allrice_company_asset_revisions
      (id,organization_id,asset_id,number,content,digest,base_asset_revision,created_by)
      values(${edit.revisionId},${context.organizationId},${edit.contentId},${next},${tx.json(text)},${digest},${edit.expectedRevision},${context.actor.id})`;
    await tx`update allrice_company_assets set revision=${next},latest_revision_id=${edit.revisionId},updated_at=clock_timestamp() where id=${edit.contentId}`;
    mapped.set(edit.contentId, {
      sourceKind: edit.kind,
      contentId: edit.contentId,
      revisionId: edit.revisionId,
      digest,
    });
  }
  return EmployeeContentManifestSchema.parse({
    ...input.manifest,
    common: input.manifest.common.map((r) =>
      r.sourceKind === 'draft_text' ? mapped.get(r.contentId)! : r,
    ),
    scenes: input.manifest.scenes.map((s) => ({
      ...s,
      references: s.references.map((r) =>
        r.sourceKind === 'draft_text' ? mapped.get(r.contentId)! : r,
      ),
    })),
  });
}

export async function mutateEmployeeContent(
  contextInput: EmployeeContentContext,
  raw: unknown,
  db = getDatabase(),
): Promise<EmployeeContentReceipt> {
  const input = EmployeeContentMutationSchema.parse(raw);
  const context = { ...contextInput, workspaceId: input.workspaceId };
  return db.begin((tx) =>
    mutateEmployeeContentInTransaction(context, input, tx),
  );
}

/** Internal composition point for controlled chat edits. Stable original input
 * is checked before merging a partial edit against the latest candidate. */
export async function mutateEmployeeContentInTransaction(
  context: EmployeeContentContext,
  input: EmployeeContentMutation,
  tx: ContentTx,
  options: {
    inputDigest?: string;
    authorize?: () => Promise<void>;
    buildInput?: (
      row: ContentSetRow | undefined,
    ) => Promise<EmployeeContentMutation>;
  } = {},
): Promise<EmployeeContentReceipt> {
  await requireContentMaintenance(context, input.ownership, tx);
  // Short company transaction gate serializes absent-layer insertion and
  // cross-layer validation without a check-then-insert/activation race.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${context.organizationId}`},0))`;
  const target = await resolveTarget(context, input.target, tx, true);
  if (
    input.ownership.scope === 'personal' &&
    input.ownership.ownerId !== context.actor.id
  )
    throw new DataAccessError('authorization_denied');
  await options.authorize?.();
  let [row] = await tx<
    ContentSetRow[]
  >`select * from allrice_employee_content_sets where id=${input.setId} for update`;
  if (
    row &&
    (row.organization_id !== context.organizationId ||
      row.workspace_id !== context.workspaceId ||
      runtimePolicyDigest(contentOwnership(row)) !==
        runtimePolicyDigest(input.ownership) ||
      runtimePolicyDigest(contentTarget(row)) !==
        runtimePolicyDigest(input.target))
  )
    throw new DataAccessError('not_found');
  const inputDigest = options.inputDigest ?? runtimePolicyDigest(input);
  const [previous] = await tx<
    { input_digest: string; response: unknown }[]
  >`select input_digest,response from allrice_employee_content_requests
      where organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and actor_id=${context.actor.id} and request_id=${input.requestId}`;
  if (previous) {
    if (previous.input_digest !== inputDigest)
      throw new EmployeeContentError('request_conflict');
    return EmployeeContentReceiptSchema.parse(previous.response);
  }
  if ((row?.revision ?? 0) !== input.expectedRevision)
    throw new EmployeeContentError('version_conflict');
  if (options.buildInput)
    input = EmployeeContentMutationSchema.parse(await options.buildInput(row));
  if (!row) {
    if (input.operation !== 'save_draft')
      throw new DataAccessError('not_found');
    const [inserted] = await tx<
      ContentSetRow[]
    >`insert into allrice_employee_content_sets
        (id,organization_id,workspace_id,employee_id,instance_id,scope,owner_id,department_id,created_by)
        values(${input.setId},${context.organizationId},${context.workspaceId},${target.employeeId},${target.instanceId},${input.ownership.scope},
          ${input.ownership.scope === 'personal' ? input.ownership.ownerId : null},
          ${input.ownership.scope === 'department' ? input.ownership.departmentId : null},${context.actor.id})
        on conflict do nothing returning *`;
    if (!inserted) throw new EmployeeContentError('version_conflict');
    row = inserted;
  }
  const next = row.revision + 1;
  let candidate: ContentRevisionRow,
    validation: EmployeeContentValidation | null = null;
  let active = await readRevision(tx, row.active_revision_id);
  if (input.operation === 'save_draft' || input.operation === 'restore_draft') {
    let manifest: EmployeeContentManifest;
    if (input.operation === 'save_draft')
      manifest = await saveTextEdits(context, input, tx);
    else {
      const source = await readRevision(tx, input.sourceRevisionId);
      if (!source || source.set_id !== row.id)
        throw new DataAccessError('not_found');
      const [invalidated] =
        await tx`select revision_id from allrice_employee_content_publications
          where set_id=${row.id} and revision_id=${source.id} and invalidated_at is not null`;
      if (invalidated) throw new EmployeeContentError('source_changed');
      manifest = source.manifest;
    }
    const id = randomUUID(),
      digest = runtimePolicyDigest(manifest);
    // Unpublished edits continue the restored candidate's lineage. Otherwise a
    // no-op save could erase the fresh-test requirement before activation.
    const restoredFrom =
      input.operation === 'restore_draft'
        ? input.sourceRevisionId
        : row.candidate_revision_id !== row.active_revision_id
          ? ((await readRevision(tx, row.candidate_revision_id))
              ?.restored_from_revision_id ?? null)
          : null;
    const [revision] = await tx<
      ContentRevisionRow[]
    >`insert into allrice_employee_content_revisions
        (id,set_id,number,manifest,digest,change_summary,created_by,restored_from_revision_id)
        values(${id},${row.id},${next},${tx.json(manifest)},${digest},${input.changeSummary},${context.actor.id},
        ${restoredFrom}) returning *`;
    candidate = revision!;
  } else {
    const saved = await readRevision(tx, row.candidate_revision_id);
    if (
      !saved ||
      saved.id !== input.candidateRevisionId ||
      saved.digest !== input.candidateDigest
    )
      throw new EmployeeContentError('version_conflict');
    candidate = saved;
    const result = await assemble(
      context,
      target,
      input.ownership,
      tx,
      { row, revision: candidate },
      true,
    );
    validation = result.validation;
    if (input.operation === 'activate') {
      if (!row.validation?.valid)
        throw new EmployeeContentError('validation_required');
      if (!validation.valid)
        throw new EmployeeContentError('validation_failed');
      if (row.validation.dependencyDigest !== validation.dependencyDigest)
        throw new EmployeeContentError('source_changed');
      if (input.invalidatePrevious && active && active.id !== candidate.id)
        await tx`update allrice_employee_content_publications set invalidated_at=clock_timestamp()
            where set_id=${row.id} and revision_id=${active.id} and invalidated_at is null`;
      // A revoked publication cannot be resurrected by re-activating the
      // same revision. A corrected version needs its own immutable revision.
      const [revoked] =
        await tx`select revision_id from allrice_employee_content_publications
          where set_id=${row.id} and revision_id=${candidate.id} and invalidated_at is not null`;
      if (revoked) throw new EmployeeContentError('source_changed');
      await tx`insert into allrice_employee_content_publications(set_id,revision_id)
          values(${row.id},${candidate.id}) on conflict do nothing`;
      for (const source of result.resolved)
        if (source.publish) {
          await tx`insert into allrice_company_asset_publications(asset_id,revision_id,published_by)
            values(${source.publish.contentId},${source.publish.revisionId},${context.actor.id}) on conflict do nothing`;
          await tx`update allrice_company_assets set state='published',published_revision_id=${source.publish.revisionId},revision=revision+1,updated_at=clock_timestamp()
            where id=${source.publish.contentId} and latest_revision_id=${source.publish.revisionId}`;
        }
      active = candidate;
    }
  }
  await tx`update allrice_employee_content_sets set revision=${next},candidate_revision_id=${candidate.id},active_revision_id=${active?.id ?? null},
      validation=${validation ? tx.json(validation) : null},updated_at=clock_timestamp() where id=${row.id}`;
  const response = EmployeeContentReceiptSchema.parse({
    setId: row.id,
    revision: next,
    candidate: { id: candidate.id, digest: candidate.digest },
    active: active ? { id: active.id, digest: active.digest } : null,
    validation,
  });
  await tx`insert into allrice_employee_content_requests(id,organization_id,workspace_id,actor_id,request_id,set_id,operation,input_digest,response)
      values(${randomUUID()},${context.organizationId},${context.workspaceId},${context.actor.id},${input.requestId},${row.id},${input.operation},${inputDigest},${tx.json(response)})`;
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values(${context.organizationId},${context.workspaceId},${context.actor.id},${`employee.content.${input.operation}`},'employee_content_set',${row.id},'allowed','current_scope_authority',${context.requestId})`;
  return response;
}

/** Freeze only active indexes at the Run's exact employee version. Scene
 * bodies stay unloaded; an unrelated stale scene cannot block an ordinary task. */
export async function freezeEmployeeRuntimeContent(
  context: ContentIdentity,
  input: { instanceId: string; employeeId: string; employeeVersionId: string },
  sql: ContentSql = getDatabase(),
) {
  const instance = await getEmployeeInstance(context, input.instanceId, sql);
  const [assignment] =
    await sql`select employee_id from allrice_employee_assignments
    where id=${instance.assignmentId} and employee_id=${input.employeeId}`;
  if (!assignment) throw new DataAccessError('authorization_denied');
  const target = {
    employeeId: input.employeeId,
    versionId: input.employeeVersionId,
    instanceId: input.instanceId,
  };
  const platform = await platformContent(context, target, sql);
  const rows = await inheritedRows(
    context,
    target,
    {
      scope: 'personal',
      organizationId: context.organizationId,
      ownerId: context.actor.id,
    },
    sql,
  );
  const layers = [];
  for (const row of rows) {
    const revision = await readRevision(sql, row.active_revision_id);
    if (!revision) continue;
    layers.push({
      setId: row.id,
      revisionId: revision.id,
      digest: revision.digest,
      ownership: contentOwnership(row),
      common: revision.manifest.common,
      ...(revision.manifest.scenes.length
        ? { scenes: revision.manifest.scenes }
        : {}),
    });
  }
  const index = {
    schemaVersion: 1 as const,
    ...input,
    platform: { revisionId: platform.revisionId, digest: platform.digest },
    layers,
  };
  return EmployeeRuntimeContentSchema.parse({
    ...index,
    checksum: runtimePolicyDigest(index),
  });
}

export async function getEmployeeContentSet(
  context: EmployeeContentContext,
  idInput: string,
  db = getDatabase(),
) {
  const id = UuidSchema.parse(idInput);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const [row] = await tx<
      ContentSetRow[]
    >`select * from allrice_employee_content_sets where id=${id}
      and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}`;
    if (!row) throw new DataAccessError('not_found');
    await resolveTarget(context, contentTarget(row), tx, false);
    const set = await setDto(context, row, tx),
      manifest =
        set.candidate?.manifest ?? set.active?.manifest ?? emptyManifest;
    const sources: ResolvedContentSource[] = [];
    for (const ref of [
      ...new Map(refs(manifest).map((r) => [exactKey(r), r])).values(),
    ])
      sources.push(
        await resolveEmployeeContentSource({
          context,
          employeeId: row.employee_id,
          ownership: contentOwnership(row),
          ref,
          sql: tx,
          lock: false,
          allowDraft: set.access.canMaintain,
        }),
      );
    return { set, sources: sources.map((s) => s.dto) };
  });
}

/** Maintainer history contains immutable reference indexes, never source bodies.
 * Reading a source or enabling a restored candidate still requires current ACL. */
export async function getEmployeeContentHistory(
  context: EmployeeContentContext,
  idInput: string,
  beforeRevision?: number,
) {
  return getDatabase().begin(
    'isolation level repeatable read read only',
    (tx) =>
      getEmployeeContentHistoryInTransaction(
        context,
        idInput,
        beforeRevision,
        tx,
      ),
  );
}

export async function getEmployeeContentHistoryInTransaction(
  context: EmployeeContentContext,
  idInput: string,
  beforeRevision: number | undefined,
  tx: ContentTx,
) {
  const id = UuidSchema.parse(idInput);
  if (
    beforeRevision !== undefined &&
    (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
  )
    throw new EmployeeContentError('version_conflict');
  const [row] = await tx<
    ContentSetRow[]
  >`select * from allrice_employee_content_sets
      where id=${id} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}`;
  if (!row) throw new DataAccessError('not_found');
  const access = await getContentAccess(context, contentOwnership(row), tx);
  if (!access.canMaintain) throw new DataAccessError('not_found');
  await resolveTarget(context, contentTarget(row), tx, false);
  const rows = await tx<
    (ContentRevisionRow & { invalidated_at: Date | null })[]
  >`
      select r.*,p.invalidated_at from allrice_employee_content_revisions r
      left join allrice_employee_content_publications p on p.set_id=r.set_id and p.revision_id=r.id
      where r.set_id=${id} ${beforeRevision === undefined ? tx`` : tx`and r.number<${beforeRevision}`}
      order by r.number desc limit 101`;
  return {
    setId: id,
    revision: row.revision,
    activeRevisionId: row.active_revision_id,
    candidateRevisionId: row.candidate_revision_id,
    revisions: rows.slice(0, 100).map((r) => ({
      ...revisionDto(r),
      invalidatedAt: r.invalidated_at?.toISOString() ?? null,
    })),
    nextBeforeRevision: rows.length > 100 ? rows[99]!.number : null,
  };
}

export async function getEffectiveEmployeeContent(
  context: EmployeeContentContext,
  instanceIdInput: string,
  db = getDatabase(),
) {
  const instanceId = UuidSchema.parse(instanceIdInput);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const target = await resolveTarget(
      context,
      { kind: 'instance', instanceId },
      tx,
      false,
    );
    const result = await assemble(
      context,
      target,
      {
        scope: 'personal',
        organizationId: context.organizationId,
        ownerId: context.actor.id,
      },
      tx,
    );
    const layers = [];
    for (const row of result.rows)
      if ((await getContentAccess(context, contentOwnership(row), tx)).canRead)
        layers.push(await setDto(context, row, tx));
    return EmployeeEffectiveContentSchema.parse({
      instanceId,
      employeeId: target.employeeId,
      platform: result.platform,
      layers,
      common: result.common,
      scenes: result.scenes,
      sources: result.resolved.map((s) => s.dto),
      validation: result.validation,
    });
  });
}

/** Chat inspection never leaks a maintainer's upstream draft through the
 * effective view. Candidate inspection is limited to this private instance. */
export async function inspectEmployeeMethodContent(
  context: EmployeeContentContext,
  instanceId: string,
  view: 'effective' | 'candidate',
  tx: ContentTx,
  sharedTarget?: EmployeeMethodSharedTarget,
) {
  const selection = await resolveEmployeeMethodTarget(
    context,
    instanceId,
    sharedTarget,
    tx,
  );
  const shared = selection.sharedTarget
    ? { sharedTarget: selection.sharedTarget, audience: selection.audience }
    : {};
  const target = await resolveTarget(context, selection.target, tx, false);
  if (view === 'effective') {
    const result = await assemble(context, target, selection.ownership, tx);
    return {
      view,
      instanceId,
      ...shared,
      platform: result.platform,
      common: result.common,
      scenes: result.scenes,
      sources: result.resolved.map((s) => s.dto),
      validation: result.validation,
      layers: await Promise.all(
        result.rows.map(async (row) => ({
          ownership: contentOwnership(row),
          active: await readRevision(tx, row.active_revision_id).then((r) =>
            r ? revisionDto(r) : null,
          ),
        })),
      ),
    };
  }
  const [row] = await tx<
    ContentSetRow[]
  >`select * from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and id=${selection.setId}`;
  if (!row)
    return {
      view,
      instanceId,
      ...shared,
      setId: selection.sharedTarget ? selection.setId : null,
      revision: 0,
      candidate: null,
      active: null,
      sources: [],
      candidateTests: [],
    };
  const candidate = await readRevision(tx, row.candidate_revision_id);
  const active = await readRevision(tx, row.active_revision_id);
  const sources = [];
  for (const ref of new Map(
    refs(candidate?.manifest ?? emptyManifest).map((r) => [exactKey(r), r]),
  ).values())
    sources.push(
      (
        await resolveEmployeeContentSource({
          context,
          employeeId: row.employee_id,
          ownership: contentOwnership(row),
          ref,
          sql: tx,
          lock: false,
          allowDraft: true,
        })
      ).dto,
    );
  const tests = candidate
    ? await tx`select t.test_id,t.scene_id,t.case_id,p.status
    from allrice_employee_method_tests t join allrice_platform_employee_test_runs p on p.id=t.test_id and p.purpose='method_candidate'
    where t.organization_id=${context.organizationId} and t.workspace_id=${context.workspaceId} and t.owner_id=${context.actor.id}
      and t.instance_id=${instanceId} and t.set_id=${row.id} and t.candidate_revision_id=${candidate.id} and t.candidate_digest=${candidate.digest}
    order by t.created_at desc,t.test_id limit 32`
    : [];
  return {
    view,
    instanceId,
    ...shared,
    setId: row.id,
    revision: row.revision,
    candidate: candidate ? revisionDto(candidate) : null,
    active: active ? { id: active.id, digest: active.digest } : null,
    sources,
    // Discovery only. test_status/activation rechecks dependency and authority;
    // a stored 'succeeded' state alone is not a current passing assertion.
    candidateTests: tests.map((t) => ({
      testId: t.test_id,
      sceneId: t.scene_id,
      caseId: t.case_id,
      status: t.status,
    })),
  };
}

/** Same layer/source resolver as effective content, with exactly one candidate
 * substituted. Tests freeze this overlay separately from the published package. */
export async function freezeEmployeeMethodActivationCandidate(
  context: EmployeeContentContext,
  input: {
    instanceId: string;
    sharedTarget?: EmployeeMethodSharedTarget;
    expectedRevision: number;
    candidateRevisionId: string;
    candidateDigest: string;
  },
  tx: ContentTx,
) {
  const selection = await resolveEmployeeMethodTarget(
    context,
    input.instanceId,
    input.sharedTarget,
    tx,
  );
  const target = await resolveTarget(context, selection.target, tx, true);
  const [row] = await tx<
    ContentSetRow[]
  >`select * from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and id=${selection.setId} for share`;
  if (!row) throw new DataAccessError('not_found');
  if (
    row.revision !== input.expectedRevision ||
    row.candidate_revision_id !== input.candidateRevisionId
  )
    throw new EmployeeContentError('version_conflict');
  const revision = await readRevision(tx, row.candidate_revision_id);
  if (!revision || revision.digest !== input.candidateDigest)
    throw new EmployeeContentError('version_conflict');
  const result = await assemble(
    context,
    target,
    contentOwnership(row),
    tx,
    { row, revision },
    true,
  );
  if (!result.validation.valid)
    throw new EmployeeContentError('validation_failed');
  const active = await readRevision(tx, row.active_revision_id);
  if (
    selection.sharedTarget &&
    (revision.restored_from_revision_id ||
      runtimePolicyDigest(revision.manifest.common) !==
        runtimePolicyDigest(active?.manifest.common ?? []) ||
      revision.manifest.scenes.some((scene) =>
        scene.references.some(
          (ref) => !['requirement', 'procedure'].includes(ref.sourceKind),
        ),
      ))
  )
    throw new EmployeeContentError('validation_failed');
  return {
    ...(selection.sharedTarget
      ? { sharedTarget: selection.sharedTarget, audience: selection.audience }
      : {}),
    setId: row.id,
    setRevision: row.revision,
    candidateRevisionId: revision.id,
    candidateDigest: revision.digest,
    dependencyDigest: result.validation.dependencyDigest,
    employeeId: target.employeeId,
    employeeVersionId: target.versionId,
    activeRevisionId: active?.id ?? null,
    restoredFromRevisionId: revision.restored_from_revision_id,
    activeManifest: active?.manifest ?? emptyManifest,
    manifest: revision.manifest,
    sources: result.resolved.map((s) => s.dto),
    common: result.common,
    scenes: result.scenes,
  };
}

export async function freezeEmployeeMethodCandidate(
  context: EmployeeContentContext,
  input: Parameters<typeof freezeEmployeeMethodActivationCandidate>[1] & {
    sceneId: string;
  },
  tx: ContentTx,
) {
  const result = await freezeEmployeeMethodActivationCandidate(
    context,
    input,
    tx,
  );
  const scene = result.scenes.find((s) => s.id === input.sceneId);
  if (!scene || !result.manifest.scenes.some((s) => s.id === scene.id))
    throw new EmployeeContentError('source_changed');
  const selected = new Set(
    [...result.common, ...scene.references].map(exactKey),
  );
  const sources = result.sources.filter((s) =>
    selected.has(exactKey(s.reference)),
  );
  return {
    ...(result.sharedTarget
      ? { sharedTarget: result.sharedTarget, audience: result.audience }
      : {}),
    setId: result.setId,
    setRevision: result.setRevision,
    candidateRevisionId: result.candidateRevisionId,
    candidateDigest: result.candidateDigest,
    dependencyDigest: result.dependencyDigest,
    employeeId: result.employeeId,
    employeeVersionId: result.employeeVersionId,
    scene,
    common: result.common,
    sources,
  };
}
