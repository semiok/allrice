import { randomUUID } from 'node:crypto';
import {
  EmployeeContentMutationSchema,
  EmployeeContentManifestSchema,
  EmployeeContentTextSchema,
  EmployeeContentReceiptSchema,
  EmployeeContentSetSchema,
  EmployeeEffectiveContentSchema,
  EmployeeDetailsSchema,
  EmployeeDetailsProfileSchema,
  EmployeeInstanceProfileSchema,
  EmployeeManifestSchema,
  DefaultPartnerProfile,
  EmployeeRuntimeContentSchema,
  PlatformEmployeeDefinitionSchema,
  UuidSchema,
  employeeContentLimits,
  type RequestContext,
  type EmployeeContentMutation,
  type EmployeeContentManifest,
  type EmployeeContentReference,
  type EmployeeContentSet,
  type EmployeeContentIssue,
  type EmployeeContentValidation,
  type EmployeeContentReceipt,
  type EmployeeInstance,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';
import type { OrganizationSharedReader } from '../organization-shared-reader.ts';
import { getDatabase } from '../core/client.ts';
import { runtimePackageChecksum } from '../platform-employees/runtime-package.ts';
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
import {
  isBaseRiceInstance,
  canUsePersonalEmployeeScenes,
} from './employee-instance-policy.ts';
import { assertPersonalSceneNames } from './personal-scene-names.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';
import { assertEmployeeContentRetirement } from './employee-content-retirement.ts';
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
function scopedRefs(manifest: EmployeeContentManifest) {
  return [
    ...manifest.common.map((ref) => ({ ref, sceneId: null as string | null })),
    ...manifest.scenes.flatMap((scene) =>
      scene.references.map((ref) => ({ ref, sceneId: scene.id })),
    ),
  ];
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
  const personalAllowed =
    scope.scope === 'personal' && target.instanceId !== null;
  return sql<ContentSetRow[]>`select * from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and employee_id=${target.employeeId} and active_revision_id is not null
      and (scope='company' or (scope='department' and department_id=${departmentId} and ${scope.scope !== 'company'})
        or (scope='personal' and instance_id=${target.instanceId} and owner_id=${context.actor.id} and ${personalAllowed}))
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
  requireAllLayers = false,
  sharedReader?: OrganizationSharedReader,
) {
  if (sharedReader && (candidate || lock || ownership.scope === 'personal'))
    throw new DataAccessError('authorization_denied');
  const platform = await platformContent(context, target, sql);
  const rows = sharedReader
    ? await sql<ContentSetRow[]>`select * from allrice_employee_content_sets
        where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
          and employee_id=${target.employeeId} and active_revision_id is not null
          and instance_id is null and (scope='company' or (scope='department' and department_id=${sharedReader.departmentId}))
        order by case scope when 'company' then 0 else 1 end,id`
    : await inheritedRows(context, target, ownership, sql);
  if (candidate) {
    const existing = rows.findIndex((r) => r.id === candidate.row.id);
    if (existing >= 0) rows[existing] = candidate.row;
    else rows.push(candidate.row);
    // A first company publication must precede existing department overlays,
    // just as it will after activation. Never append it below the department.
    const order = { company: 0, department: 1, personal: 2 };
    rows.sort(
      (a, b) => order[a.scope] - order[b.scope] || a.id.localeCompare(b.id),
    );
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
    const access = sharedReader
      ? sharedReader.access(contentOwnership(row))
      : await getContentAccess(context, contentOwnership(row), sql, lock);
    if (!access.canRead) {
      if (requireAllLayers) throw new DataAccessError('authorization_denied');
      continue;
    }
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
    const sourceRefs = scopedRefs(rev.manifest).sort((a, b) =>
      `${a.sceneId ?? ''}/${exactKey(a.ref)}`.localeCompare(
        `${b.sceneId ?? ''}/${exactKey(b.ref)}`,
      ),
    );
    for (const { ref, sceneId } of sourceRefs) {
      const identity = `${ref.sourceKind}:${ref.contentId}`,
        previous = identities.get(identity);
      // Independent scenes may pin different revisions of a reference. Check
      // Knowledge after merging all layers, within each effective scene view.
      // Requirements and other rule-bearing sources retain their existing gate.
      if (
        ref.sourceKind !== 'knowledge' &&
        previous &&
        previous !== exactKey(ref)
      )
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
        instanceId: target.instanceId ?? undefined,
        sceneId,
        ownership: contentOwnership(row),
        ref,
        sql,
        lock,
        allowDraft: row.id === candidate?.row.id,
        sharedReader,
      });
      if (resolved.issue) issues.push(resolved.issue);
      // Validate the complete candidate, including exact procedure revisions
      // reused without textEdits. Otherwise removing a resource's source could
      // publish an unreadable package. Active/runtime reads are unchanged.
      if (
        row.id === candidate?.row.id &&
        ref.sourceKind === 'procedure' &&
        resolved.dto.available
      ) {
        const [source] = await sql<{ content: unknown }[]>`
          select content from allrice_company_asset_revisions
          where organization_id=${context.organizationId} and asset_id=${ref.contentId}
            and id=${ref.revisionId} and content ? 'skillPackage'`;
        if (source) {
          const text = EmployeeContentTextSchema.safeParse(source.content);
          try {
            if (
              !text.success ||
              !('skillPackage' in text.data) ||
              runtimePolicyDigest(source.content) !== ref.digest
            )
              throw new EmployeeContentError('validation_failed');
            validateSceneSkillPackage(text.data.skillPackage, text.data.body, [
              ...rev.manifest.common,
              ...(sceneId
                ? rev.manifest.scenes.find((scene) => scene.id === sceneId)!
                    .references
                : []),
            ]);
          } catch {
            issues.push({
              code: 'source_changed',
              contentId: ref.contentId,
              ...(sceneId ? { sceneId } : {}),
              message: '场景技能包与其正文、资源或资料引用不一致。',
            });
          }
        }
      }
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
  const checkKnowledgeVersions = (
    references: EmployeeContentReference[],
    sceneId?: string,
  ) => {
    const versions = new Map<string, string>();
    for (const ref of references) {
      if (ref.sourceKind !== 'knowledge') continue;
      const previous = versions.get(ref.contentId);
      if (previous && previous !== exactKey(ref))
        issues.push({
          code: 'mandatory_rule_conflict',
          contentId: ref.contentId,
          ...(sceneId ? { sceneId } : {}),
          message:
            '同一执行场景引用了同一资料的不同版本；请先统一该场景与通用内容的来源版本。',
        });
      versions.set(ref.contentId, exactKey(ref));
    }
  };
  checkKnowledgeVersions(common);
  for (const scene of scenes)
    checkKnowledgeVersions([...common, ...scene.references], scene.id);
  const resolved = [...sources.values()];
  if (
    scenes.length > employeeContentLimits.scenes ||
    sources.size > employeeContentLimits.references ||
    resolved.reduce(
      (n, s) =>
        n +
        Buffer.byteLength(s.dto.body ?? '') -
        (ownership.scope === 'personal' ? (s.personalPackageBytes ?? 0) : 0),
      0,
    ) > employeeContentLimits.textBytes ||
    (ownership.scope === 'personal' &&
      resolved.reduce((n, s) => n + (s.personalPackageBytes ?? 0), 0) >
        employeeContentLimits.personalSceneBodyBytes)
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

/** A common edit affects the entire shared execution view, including scenes
 * inherited from the company. The server owns this bounded, immutable list;
 * neither the authoring model nor the limited test-history query defines it. */
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
      ...('skillPackage' in edit ? { skillPackage: edit.skillPackage } : {}),
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
  const manifest = EmployeeContentManifestSchema.parse({
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
  for (const edit of input.textEdits) {
    if (!('skillPackage' in edit)) continue;
    const owns = (ref: EmployeeContentReference) =>
      ref.contentId === edit.contentId && ref.revisionId === edit.revisionId;
    if (manifest.common.some(owns))
      validateSceneSkillPackage(edit.skillPackage, edit.body, manifest.common);
    for (const scene of manifest.scenes) {
      if (scene.references.some(owns))
        validateSceneSkillPackage(edit.skillPackage, edit.body, [
          ...manifest.common,
          ...scene.references,
        ]);
    }
  }
  return manifest;
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
    /** Controlled chat saves publish in the same transaction, without a draft gate. */
    publishOnSave?: boolean;
    inputDigest?: string;
    authorize?: () => Promise<void>;
    buildInput?: (
      row: ContentSetRow | undefined,
    ) => Promise<EmployeeContentMutation>;
    /** A server-owned personal package validator; never selected by raw input.
     * It keeps personal saves out of the shared additive assembly path. */
    validateCandidate?: (candidate: {
      row: ContentSetRow;
      revision: ContentRevisionRow;
      target: ResolvedTarget;
    }) => Promise<{
      validation: EmployeeContentValidation;
      resolved: ResolvedContentSource[];
    }>;
  } = {},
): Promise<EmployeeContentReceipt> {
  if (
    options.publishOnSave &&
    (!options.authorize ||
      (input.operation !== 'save_draft' && input.operation !== 'restore_draft'))
  )
    throw new DataAccessError('authorization_denied');
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
  // Rice is admitted only through the existing controlled package
  // writers. Do not expose the legacy raw draft/activate HTTP interface.
  if (
    input.ownership.scope === 'personal' &&
    target.instanceId &&
    !options.authorize &&
    (await isBaseRiceInstance(
      await getEmployeeInstance(context, target.instanceId, tx),
      tx,
    ))
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
  let active = await readRevision(tx, row?.active_revision_id ?? null);
  if (input.operation === 'save_draft')
    await assertEmployeeContentRetirement(
      context.organizationId,
      active?.manifest ?? emptyManifest,
      input.manifest,
      input.textEdits,
      tx,
    );
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
  const validateNames = async (manifest: EmployeeContentManifest) => {
    if (input.ownership.scope !== 'personal' || !target.instanceId) return;
    const instance = await getEmployeeInstance(context, target.instanceId, tx);
    if (await canUsePersonalEmployeeScenes(instance, tx))
      await assertPersonalSceneNames(
        tx,
        context,
        instance,
        manifest,
        active?.manifest,
      );
  };
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
      await assertEmployeeContentRetirement(
        context.organizationId,
        active?.manifest ?? emptyManifest,
        manifest,
        [],
        tx,
      );
    }
    await validateNames(manifest);
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
    if (options.publishOnSave) {
      const result = options.validateCandidate
        ? await options.validateCandidate({ row, revision: candidate, target })
        : await assemble(
            context,
            target,
            input.ownership,
            tx,
            { row, revision: candidate },
            true,
            true,
          );
      validation = result.validation;
      if (!validation.valid)
        throw new EmployeeContentError('validation_failed');
      // A company save also changes existing department combinations. Check
      // their structural/source conflicts, without reading anyone's private
      // methods or requiring paid business tests.
      if (input.ownership.scope === 'company') {
        const departments = await tx<{ department_id: string }[]>`
          select distinct department_id from allrice_employee_content_sets
          where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
            and employee_id=${target.employeeId} and scope='department' and active_revision_id is not null`;
        for (const department of departments) {
          const combined = await assemble(
            context,
            target,
            {
              scope: 'department',
              organizationId: context.organizationId,
              departmentId: department.department_id,
            },
            tx,
            { row, revision: candidate },
            true,
            true,
          );
          if (!combined.validation.valid)
            throw new EmployeeContentError('validation_failed');
        }
      }
      await publishContentRevision(
        context,
        row,
        candidate,
        result.resolved,
        tx,
      );
      active = candidate;
    }
  } else {
    const saved = await readRevision(tx, row.candidate_revision_id);
    if (
      !saved ||
      saved.id !== input.candidateRevisionId ||
      saved.digest !== input.candidateDigest
    )
      throw new EmployeeContentError('version_conflict');
    candidate = saved;
    await assertEmployeeContentRetirement(
      context.organizationId,
      active?.manifest ?? emptyManifest,
      candidate.manifest,
      [],
      tx,
    );
    await validateNames(candidate.manifest);
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
      await publishContentRevision(
        context,
        row,
        candidate,
        result.resolved,
        tx,
      );
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
      values(${context.organizationId},${context.workspaceId},${context.actor.id},${options.publishOnSave ? 'employee.content.save_and_publish' : `employee.content.${input.operation}`},'employee_content_set',${row.id},'allowed','current_scope_authority',${context.requestId})`;
  return response;
}

async function publishContentRevision(
  context: EmployeeContentContext,
  row: ContentSetRow,
  revision: ContentRevisionRow,
  sources: ResolvedContentSource[],
  tx: ContentTx,
) {
  await tx`insert into allrice_employee_content_publications(set_id,revision_id)
    values(${row.id},${revision.id}) on conflict do nothing`;
  for (const source of sources)
    if (source.publish) {
      await tx`insert into allrice_company_asset_publications(asset_id,revision_id,published_by)
        values(${source.publish.contentId},${source.publish.revisionId},${context.actor.id}) on conflict do nothing`;
      await tx`update allrice_company_assets set state='published',published_revision_id=${source.publish.revisionId},revision=revision+1,updated_at=clock_timestamp()
        where id=${source.publish.contentId} and latest_revision_id=${source.publish.revisionId}`;
    }
}

/** Freeze only active indexes at the Run's exact employee version. Scene
 * bodies stay unloaded; an unrelated stale scene cannot block an ordinary task. */
export async function freezeEmployeeRuntimeContent(
  context: ContentIdentity,
  input: {
    instanceId: string;
    employeeId: string;
    employeeVersionId: string;
    personalScenes?: true;
  },
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
  if (
    input.personalScenes &&
    !(await canUsePersonalEmployeeScenes(instance, sql))
  )
    throw new DataAccessError('authorization_denied');
  const rows = input.personalScenes
    ? []
    : await inheritedRows(
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
    for (const { ref, sceneId } of scopedRefs(manifest))
      sources.push(
        await resolveEmployeeContentSource({
          context,
          employeeId: row.employee_id,
          instanceId: row.instance_id ?? undefined,
          sceneId,
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
    return readEffectiveContent(context, target, instanceId, tx);
  });
}

/** Published-only source for the C1 catalog. It deliberately never returns a
 * candidate, maintenance privilege, or runtime snapshot. Call in a read-only
 * transaction so publication, current authority and bytes share one view. */
export async function readPublishedEmployeeSceneLayers(
  context: EmployeeContentContext,
  instanceIdInput: string,
  tx: ContentTx,
  pin?: { setId: string; revisionId: string },
) {
  const instanceId = UuidSchema.parse(instanceIdInput);
  if (pin) {
    UuidSchema.parse(pin.setId);
    UuidSchema.parse(pin.revisionId);
  }
  const target = await resolveTarget(
    context,
    { kind: 'instance', instanceId },
    tx,
    false,
  );
  const rows = await inheritedRows(
    context,
    target,
    {
      scope: 'personal',
      organizationId: context.organizationId,
      ownerId: context.actor.id,
    },
    tx,
  );
  if (pin && !rows.some((row) => row.id === pin.setId))
    throw new DataAccessError('not_found');
  const layers = [];
  for (const row of rows) {
    const ownership = contentOwnership(row);
    if (!(await getContentAccess(context, ownership, tx)).canRead)
      throw new DataAccessError('not_found');
    const revision = await readRevision(
      tx,
      pin?.setId === row.id ? pin.revisionId : row.active_revision_id,
    );
    if (
      !revision ||
      revision.set_id !== row.id ||
      runtimePolicyDigest(revision.manifest) !== revision.digest
    )
      throw new DataAccessError('not_found');
    const [publication] = await tx<{ published_at: Date }[]>`
      select published_at from allrice_employee_content_publications
      where set_id=${row.id} and revision_id=${revision.id} and invalidated_at is null`;
    if (!publication) throw new DataAccessError('not_found');
    layers.push({
      setId: row.id,
      ownership,
      revision: revisionDto(revision),
      publishedAt: publication.published_at.toISOString(),
    });
  }
  return { instanceId, employeeId: target.employeeId, layers };
}

/** Current owner/instance authority is independent from exact content identity.
 * This reader never consults inheritedRows or another instance's personal set. */
export async function readPersonalEmployeeSceneLayer(
  context: EmployeeContentContext,
  instanceIdInput: string,
  sql: ContentSql,
  pin?: { setId: string; revisionId: string },
  lock = false,
) {
  const instanceId = UuidSchema.parse(instanceIdInput);
  const target = await resolveTarget(
    context,
    { kind: 'instance', instanceId },
    sql,
    lock,
  );
  const instance = await getEmployeeInstance(context, instanceId, sql);
  if (!(await canUsePersonalEmployeeScenes(instance, sql)))
    throw new DataAccessError('not_found');
  const [row] = await sql<ContentSetRow[]>`
    select * from allrice_employee_content_sets
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and employee_id=${target.employeeId} and instance_id=${instanceId}
      and scope='personal' and owner_id=${context.actor.id}
    ${lock ? sql`for share` : sql``}`;
  const base = {
    instanceId,
    employeeId: target.employeeId,
    revision: row?.revision ?? 0,
  };
  if (pin && (!row || row.id !== pin.setId))
    throw new DataAccessError('not_found');
  if (!row || (!pin && !row.active_revision_id))
    return { ...base, layer: null };
  const ownership = contentOwnership(row);
  if (!(await getContentAccess(context, ownership, sql, lock)).canRead)
    throw new DataAccessError('not_found');
  const revision = await readRevision(
    sql,
    pin?.revisionId ?? row.active_revision_id,
  );
  if (
    !revision ||
    revision.set_id !== row.id ||
    runtimePolicyDigest(revision.manifest) !== revision.digest
  )
    throw new DataAccessError('not_found');
  const [publication] = await sql<{ published_at: Date }[]>`
    select published_at from allrice_employee_content_publications
    where set_id=${row.id} and revision_id=${revision.id} and invalidated_at is null
    ${lock ? sql`for share` : sql``}`;
  if (!publication) throw new DataAccessError('not_found');
  return {
    ...base,
    layer: {
      setId: row.id,
      ownership,
      revision: revisionDto(revision),
      publishedAt: publication.published_at.toISOString(),
    },
  };
}

async function readEffectiveContent(
  context: EmployeeContentContext,
  target: ResolvedTarget,
  instanceId: string,
  tx: ContentTx,
  sharedReader?: OrganizationSharedReader,
) {
  const result = await assemble(
    context,
    target,
    sharedReader
      ? { scope: 'company', organizationId: context.organizationId }
      : {
          scope: 'personal',
          organizationId: context.organizationId,
          ownerId: context.actor.id,
        },
    tx,
    undefined,
    false,
    false,
    sharedReader,
  );
  const layers = [];
  for (const row of result.rows) {
    if (sharedReader) {
      const access = sharedReader.access(contentOwnership(row));
      if (!access.canRead) continue;
      const active = await readRevision(tx, row.active_revision_id);
      if (!active) continue;
      layers.push({
        id: row.id,
        workspaceId: row.workspace_id,
        ownership: contentOwnership(row),
        target: contentTarget(row),
        revision: active.number,
        candidate: null,
        active: revisionDto(active),
        validation: null,
        access,
      });
    } else if (
      (await getContentAccess(context, contentOwnership(row), tx)).canRead
    )
      layers.push(await setDto(context, row, tx));
  }
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
}

async function readDetailsProfile(
  context: EmployeeContentContext,
  target: ResolvedTarget,
  instance: Pick<
    EmployeeInstance,
    'id' | 'kind' | 'revision' | 'source' | 'profile'
  >,
  tx: ContentTx,
  canMaintainPersonal: boolean,
  ownerView = true,
) {
  const instanceId = instance.id;
  const [row] = await tx<
    {
      manifest: unknown;
      name: string;
      description: string;
      workspace_id: string;
    }[]
  >`
      select manifest,name,description,workspace_id from allrice_employee_versions
      where id=${target.versionId} and employee_id=${target.employeeId}
        and organization_id=${context.organizationId} and workspace_id=${context.workspaceId}`;
  if (!row) throw new DataAccessError('not_found');
  const parsed = EmployeeManifestSchema.safeParse(row.manifest);
  const manifest = parsed.success ? parsed.data : null;
  // Current detail authority was checked above. A missing/unverified platform
  // default must not revoke an otherwise readable tenant detail or relabel its
  // existing source. Only this projection checks the new platform evidence;
  // the shared publication reader's Run/Session consumers keep their contract.
  let platformDefinition: PlatformEmployeeDefinition | undefined;
  let defaultSource: EmployeeInstance['source'] | undefined =
    instance.source.kind === 'tenant_version' &&
    instance.source.employeeVersionId === target.versionId
      ? instance.source
      : undefined;
  if (
    instance.source.kind === 'platform' &&
    instance.source.employeeVersionId === target.versionId
  ) {
    const publication = await readEmployeeVersionPublication(
      {
        organizationId: context.organizationId,
        workspaceId: row.workspace_id,
        employeeId: target.employeeId,
        versionId: target.versionId,
      },
      tx,
    );
    const definition = PlatformEmployeeDefinitionSchema.safeParse(
      publication?.definition,
    );
    if (
      publication &&
      definition.success &&
      publication.platform_employee_id === instance.source.templateId &&
      publication.revision_id === instance.source.templateRevisionId &&
      publication.revision === instance.source.templateRevision &&
      publication.checksum === instance.source.templateChecksum &&
      runtimePackageChecksum(definition.data) === publication.checksum
    ) {
      platformDefinition = definition.data;
      defaultSource = instance.source;
    }
  }
  // The legacy parser can supply PartnerProfile defaults. Only an explicit
  // original declaration may contribute a tenant expression baseline here.
  const rawPartner =
    row.manifest !== null &&
    typeof row.manifest === 'object' &&
    'partnerProfile' in row.manifest
      ? row.manifest.partnerProfile
      : undefined;
  const rawExpression =
    rawPartner !== null &&
    typeof rawPartner === 'object' &&
    'communicationStyle' in rawPartner
      ? rawPartner.communicationStyle
      : undefined;
  const tenantExpression =
    EmployeeInstanceProfileSchema.shape.expressionStyle.safeParse(
      rawExpression,
    );
  const defaultExpression =
    platformDefinition?.identity.expressionStyle ??
    (manifest && tenantExpression.success ? tenantExpression.data : undefined);
  const baseIdentity =
    manifest?.schemaVersion === 2
      ? manifest.identity
      : {
          role: manifest?.partnerProfile.role ?? DefaultPartnerProfile.role,
          mission:
            manifest?.partnerProfile.mission ?? DefaultPartnerProfile.mission,
          workStyle:
            manifest?.description ||
            row.description ||
            DefaultPartnerProfile.mission,
          behaviorRules: [],
          safetyBoundaries: [],
        };
  const personal = instance.profile;
  const rice =
    ownerView &&
    instance.kind === 'general' &&
    (await isBaseRiceInstance(
      await getEmployeeInstance(context, instance.id, tx),
      tx,
    ));
  const custom = instance.kind === 'custom' || rice ? personal : {};
  const defaults = {
    name: platformDefinition?.name ?? manifest?.name ?? row.name,
    description:
      platformDefinition?.description ??
      manifest?.description ??
      row.description,
    appearance:
      platformDefinition?.appearance ??
      (manifest?.schemaVersion === 2 ? manifest.appearance : undefined),
    role: platformDefinition?.identity.role ?? baseIdentity.role,
    mission: platformDefinition?.identity.mission ?? baseIdentity.mission,
    workStyle: platformDefinition?.identity.workStyle ?? baseIdentity.workStyle,
    ...(defaultExpression !== undefined
      ? { expressionStyle: defaultExpression }
      : {}),
  };
  return EmployeeDetailsProfileSchema.parse({
    instanceId,
    kind: instance.kind,
    revision: instance.revision,
    source: instance.source,
    name: custom.name ?? defaults.name,
    description: custom.description ?? defaults.description,
    appearance: custom.appearance
      ? { ...defaults.appearance, ...custom.appearance }
      : defaults.appearance,
    identity: {
      ...baseIdentity,
      role: custom.role ?? defaults.role,
      mission: custom.mission ?? defaults.mission,
      workStyle: custom.workStyle ?? defaults.workStyle,
    },
    expressionStyle: ownerView
      ? (personal.expressionStyle ?? defaultExpression)
      : undefined,
    personalFields: Object.keys(
      instance.kind === 'custom' || rice
        ? personal
        : {
            ...(personal.expressionStyle
              ? { expressionStyle: personal.expressionStyle }
              : {}),
          },
    ),
    canMaintainPersonal,
    editableFields: !canMaintainPersonal
      ? []
      : instance.kind === 'custom' || rice
        ? EmployeeInstanceProfileSchema.keyof().options
        : ['expressionStyle'],
    // Shared administration has no owner profile permissions or default-reset control.
    isDefaultRice: ownerView ? rice : undefined,
    canArchive: ownerView && canMaintainPersonal && !rice,
    defaults,
    overrides: personal,
    ...(defaultSource !== undefined ? { defaultSource } : {}),
  });
}

/** Shared administration projection: actual assigned template, published
 * company/department layers, no personal profile, candidate or private index. */
export async function getOrganizationSharedEmployeeDetails(
  reader: OrganizationSharedReader,
  instance: Pick<EmployeeInstance, 'id' | 'kind' | 'revision' | 'source'>,
  employeeId: string,
  tx: ContentTx,
) {
  const target: ResolvedTarget = {
    employeeId,
    versionId: instance.source.employeeVersionId,
    instanceId: null,
  };
  return EmployeeDetailsSchema.parse({
    profile: await readDetailsProfile(
      reader.context,
      target,
      { ...instance, profile: {} },
      tx,
      false,
      false,
    ),
    content: await readEffectiveContent(
      reader.context,
      target,
      instance.id,
      tx,
      reader,
    ),
  });
}

/** Read the current persona and content in the same snapshot. Workspace lists
 * can be stale after chat customization or publication and are not authority. */
export async function getEmployeeDetails(
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
    const instance = await getEmployeeInstance(context, instanceId, tx);
    const principal = await readContentPrincipal(context, tx);
    return EmployeeDetailsSchema.parse({
      profile: await readDetailsProfile(
        context,
        target,
        instance,
        tx,
        principal?.writable === true,
      ),
      content: await readEffectiveContent(context, target, instanceId, tx),
    });
  });
}
