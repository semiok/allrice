import {
  EmployeeContentManifestSchema,
  PersonalSceneRemoveRequestSchema,
  PersonalSceneRemoveReceiptSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { canUsePersonalEmployeeScenes } from './employee-instance-policy.ts';
import { resolveEmployeeMethodTarget } from './employee-method-target.ts';
import { mutateEmployeeContentInTransaction } from './employee-content.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import { parsePersonalSceneContentRef } from './personal-scene-skills.ts';

/** Withdraw only this scene's private package sources, through existing source
 * revocation. Immutable content, Run history and read receipts remain intact. */
export async function removePersonalSceneSkill(
  contextInput: RequestContext,
  instanceIdInput: string,
  sceneIdInput: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = PersonalSceneRemoveRequestSchema.parse(raw);
  const instanceId = UuidSchema.parse(instanceIdInput);
  const sceneId = UuidSchema.parse(sceneIdInput);
  const pin = parsePersonalSceneContentRef(input.expectedContentRef);
  if (pin.sceneId !== sceneId)
    throw new EmployeeContentError('version_conflict');
  const context = { ...contextInput, workspaceId: input.workspaceId };
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  return db.begin(async (tx) => {
    const authorize = async () => {
      const instance = await getEmployeeInstance(context, instanceId, tx);
      if (!(await canUsePersonalEmployeeScenes(instance, tx)))
        throw new DataAccessError('not_found');
    };
    await authorize();
    const target = await resolveEmployeeMethodTarget(
      context,
      instanceId,
      undefined,
      tx,
    );
    if (pin.setId !== target.setId)
      throw new EmployeeContentError('version_conflict');
    const mutation = {
      setId: target.setId,
      target: target.target,
      ownership: target.ownership,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      operation: 'save_draft' as const,
      changeSummary: '本人删除工作场景及其全部历史包',
      manifest: {
        schemaVersion: 1 as const,
        common: [],
        scenes: [],
        declaredConflicts: [],
      },
      textEdits: [],
    };
    const receipt = await mutateEmployeeContentInTransaction(
      context,
      mutation,
      tx,
      {
        authorize,
        publishOnSave: true,
        inputDigest: runtimePolicyDigest({
          operation: 'remove_personal_scene',
          instanceId,
          sceneId,
          input,
        }),
        buildInput: async (row) => {
          if (!row || row.active_revision_id !== pin.revisionId)
            throw new EmployeeContentError('version_conflict');
          const [active] = await tx<{ manifest: unknown }[]>`
          select manifest from allrice_employee_content_revisions where id=${row.active_revision_id} and set_id=${row.id}`;
          if (!active) throw new EmployeeContentError('source_changed');
          const manifest = EmployeeContentManifestSchema.parse(active.manifest);
          const scene = manifest.scenes.find((item) => item.id === sceneId);
          const procedures =
            scene?.references.filter((ref) => ref.sourceKind === 'procedure') ??
            [];
          if (
            procedures.length !== 1 ||
            procedures[0]!.revisionId !== pin.sourceRevisionId
          )
            throw new EmployeeContentError('version_conflict');
          // Enumerate immutable references, including previously restored or
          // unpublished scene revisions. Never revoke referenced knowledge.
          const references = await tx<
            { asset_id: string; revision_id: string; digest: string }[]
          >`
          select distinct ref->>'contentId' as asset_id,ref->>'revisionId' as revision_id,ref->>'digest' as digest
          from allrice_employee_content_revisions r
          cross join lateral jsonb_array_elements(r.manifest->'scenes') s
          cross join lateral jsonb_array_elements(s->'references') ref
          where r.set_id=${row.id} and s->>'id'=${sceneId} and ref->>'sourceKind'='procedure'`;
          const assets = new Set<string>();
          for (const ref of references) {
            const [revision] = await tx<
              { digest: string; packaged: boolean }[]
            >`
            select digest,content ? 'skillPackage' as packaged from allrice_company_asset_revisions
            where organization_id=${context.organizationId} and asset_id=${ref.asset_id} and id=${ref.revision_id}`;
            if (!revision || revision.digest !== ref.digest)
              throw new EmployeeContentError('source_changed');
            if (revision.packaged) assets.add(ref.asset_id);
          }
          if (!assets.has(procedures[0]!.contentId))
            throw new EmployeeContentError('source_changed');
          const ids = [...assets].sort();
          // Every content mutation uses the same organization transaction gate.
          // Fail closed on legacy sharing instead of revoking another scene.
          const [shared] = await tx`
          select r.id from allrice_employee_content_revisions r
          join allrice_employee_content_sets s on s.id=r.set_id
          where s.organization_id=${context.organizationId} and (
            exists(select 1 from jsonb_array_elements(r.manifest->'common') ref where ref->>'contentId' in ${tx(ids)})
            or exists(select 1 from jsonb_array_elements(r.manifest->'scenes') scene
              cross join lateral jsonb_array_elements(scene->'references') ref
              where (r.set_id<>${row.id} or scene->>'id'<>${sceneId}) and ref->>'contentId' in ${tx(ids)})
          ) limit 1`;
          if (shared) throw new EmployeeContentError('source_changed');
          const sources = await tx<
            {
              id: string;
              content_scope: string;
              content_workspace_id: string | null;
              owner_id: string;
              kind: string;
            }[]
          >`
          select id,content_scope,content_workspace_id,owner_id,kind from allrice_company_assets
          where organization_id=${context.organizationId} and id in ${tx(ids)} order by id for update`;
          if (
            sources.length !== ids.length ||
            sources.some(
              (source) =>
                source.content_scope !== 'personal' ||
                source.content_workspace_id !== context.workspaceId ||
                source.owner_id !== context.actor.id ||
                source.kind !== 'procedure',
            )
          )
            throw new EmployeeContentError('source_changed');
          await tx`update allrice_company_assets set state='archived',revision=revision+1,updated_at=clock_timestamp()
          where organization_id=${context.organizationId} and id in ${tx(ids)} and state<>'archived'`;
          return {
            ...mutation,
            manifest: {
              ...manifest,
              scenes: manifest.scenes.filter((item) => item.id !== sceneId),
            },
          };
        },
        // Monotonic removal neither introduces bytes/references nor republishes
        // any source. Unrelated revoked scenes must not prevent this deletion.
        validateCandidate: async ({ revision }) => ({
          resolved: [],
          validation: {
            valid: true,
            issues: [],
            dependencyDigest: runtimePolicyDigest(revision.manifest),
            semanticConsistency: 'not_proven' as const,
          },
        }),
      },
    );
    return PersonalSceneRemoveReceiptSchema.parse({
      operation: 'remove',
      scope: 'scene_all_history',
      instanceId,
      sceneId,
      requestId: input.requestId,
      revision: receipt.revision,
      removed: true,
    });
  });
}
