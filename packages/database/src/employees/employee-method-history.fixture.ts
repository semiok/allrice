import { randomUUID } from 'node:crypto';
import {
  EmployeeContentManifestSchema,
  EmployeeContentMutationSchema,
  EmployeeContentReceiptSchema,
  EmployeeContentTextSchema,
  type EmployeeContentReference,
  type RequestContext,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';

/** Explicit pre-retirement database history. This is not a writer substitute:
 * it does not authorize, validate, perform CAS, or exercise product mutations.
 * Tests must call the real entry point for every behavior under assertion. */
export async function seedHistoricalEmployeeContent(
  db: ReturnType<typeof getDatabase>,
  context: Pick<RequestContext, 'actor' | 'organizationId'>,
  raw: unknown,
  options: {
    active?: boolean;
    inputDigest?: string;
    invalidatePrevious?: boolean;
    requestOperation?: 'save_draft' | 'restore_draft';
    restoredFromRevisionId?: string;
  } = {},
) {
  const input = EmployeeContentMutationSchema.parse(raw);
  if (input.operation !== 'save_draft')
    throw new Error('historical_fixture_requires_save_snapshot');
  return db.begin(async (tx) => {
    const [existing] = await tx<
      { revision: number; active_revision_id: string | null }[]
    >`select revision,active_revision_id from allrice_employee_content_sets where id=${input.setId}`;
    if (!existing) {
      const [target] =
        input.target.kind === 'employee'
          ? [{ employee_id: input.target.employeeId }]
          : await tx<{ employee_id: string }[]>`
              select employee_id from allrice_employee_assignments
              where id=${input.target.instanceId} or id=(
                select assignment_id from allrice_employee_instances where id=${input.target.instanceId})`;
      if (!target) throw new Error('historical_fixture_target_missing');
      await tx`insert into allrice_employee_content_sets
        (id,organization_id,workspace_id,employee_id,instance_id,scope,owner_id,department_id,created_by)
        values(${input.setId},${context.organizationId},${input.workspaceId},${target.employee_id},
          ${input.target.kind === 'instance' ? input.target.instanceId : null},${input.ownership.scope},
          ${input.ownership.scope === 'personal' ? input.ownership.ownerId : null},
          ${input.ownership.scope === 'department' ? input.ownership.departmentId : null},${context.actor.id})`;
    }
    const pins = new Map<string, EmployeeContentReference>();
    for (const edit of input.textEdits) {
      const text = EmployeeContentTextSchema.parse({
        kind: edit.kind,
        title: edit.title,
        body: edit.body,
        ...('skillPackage' in edit ? { skillPackage: edit.skillPackage } : {}),
      });
      const [previous] = await tx<{ revision: number }[]>`
        select revision from allrice_company_assets where id=${edit.contentId}`;
      if (!previous)
        await tx`insert into allrice_company_assets
          (id,organization_id,owner_id,kind,content_scope,content_workspace_id,department_id)
          values(${edit.contentId},${context.organizationId},${context.actor.id},
            ${edit.kind === 'requirement' ? 'execution_requirement' : 'procedure'},
            ${input.ownership.scope},${input.workspaceId},
            ${input.ownership.scope === 'department' ? input.ownership.departmentId : null})`;
      const digest = runtimePolicyDigest(text);
      await tx`insert into allrice_company_asset_revisions
        (id,organization_id,asset_id,number,content,digest,base_asset_revision,created_by)
        values(${edit.revisionId},${context.organizationId},${edit.contentId},${(previous?.revision ?? 0) + 1},${tx.json(text)},
          ${digest},${previous?.revision ?? 0},${context.actor.id})`;
      await tx`update allrice_company_assets set revision=${(previous?.revision ?? 0) + 1},
        latest_revision_id=${edit.revisionId} where id=${edit.contentId}`;
      pins.set(edit.contentId, {
        sourceKind: edit.kind,
        contentId: edit.contentId,
        revisionId: edit.revisionId,
        digest,
      });
    }
    const resolve = (ref: (typeof input.manifest.common)[number]) =>
      ref.sourceKind === 'draft_text' ? pins.get(ref.contentId) : ref;
    const manifest = EmployeeContentManifestSchema.parse({
      ...input.manifest,
      common: input.manifest.common.map(resolve),
      scenes: input.manifest.scenes.map((scene) => ({
        ...scene,
        references: scene.references.map(resolve),
      })),
    });
    const id = randomUUID(),
      digest = runtimePolicyDigest(manifest);
    await tx`insert into allrice_employee_content_revisions
      (id,set_id,number,manifest,digest,change_summary,created_by,restored_from_revision_id)
      values(${id},${input.setId},${(existing?.revision ?? 0) + 1},${tx.json(manifest)},${digest},${input.changeSummary},${context.actor.id},${options.restoredFromRevisionId ?? null})`;
    if (options.active) {
      if (options.invalidatePrevious && existing?.active_revision_id)
        await tx`update allrice_employee_content_publications set invalidated_at=clock_timestamp()
          where set_id=${input.setId} and revision_id=${existing.active_revision_id}`;
      await tx`insert into allrice_employee_content_publications(set_id,revision_id) values(${input.setId},${id})`;
      const refs = new Map(
        [
          ...manifest.common,
          ...manifest.scenes.flatMap((scene) => scene.references),
        ].map((ref) => [`${ref.contentId}:${ref.revisionId}`, ref]),
      );
      for (const ref of refs.values()) {
        if (!pins.has(ref.contentId)) continue;
        await tx`insert into allrice_company_asset_publications(asset_id,revision_id,published_by)
          values(${ref.contentId},${ref.revisionId},${context.actor.id}) on conflict do nothing`;
        await tx`update allrice_company_assets set state='published',published_revision_id=${ref.revisionId},revision=revision+1
          where id=${ref.contentId} and latest_revision_id=${ref.revisionId}`;
      }
    }
    const activeId = options.active ? id : existing?.active_revision_id;
    const [active] = activeId
      ? await tx<{ id: string; digest: string }[]>`
          select id,digest from allrice_employee_content_revisions where id=${activeId}`
      : [];
    const response = EmployeeContentReceiptSchema.parse({
      setId: input.setId,
      revision: (existing?.revision ?? 0) + 1,
      candidate: { id, digest },
      active: active ?? null,
      validation: null,
    });
    await tx`update allrice_employee_content_sets set revision=${response.revision},
      candidate_revision_id=${id},active_revision_id=${active?.id ?? null},validation=null where id=${input.setId}`;
    await tx`insert into allrice_employee_content_requests
      (id,organization_id,workspace_id,actor_id,request_id,set_id,operation,input_digest,response)
      values(${randomUUID()},${context.organizationId},${input.workspaceId},${context.actor.id},${input.requestId},
        ${input.setId},${options.requestOperation ?? 'save_draft'},${options.inputDigest ?? runtimePolicyDigest(input)},${tx.json(response)})`;
    return response;
  });
}
