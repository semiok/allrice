import {
  UuidSchema,
  WorkflowSkillFrontmatterSchema,
  type EmployeeContentManifest,
  type EmployeeInstance,
} from '@allrice/contracts';
import type { ContentIdentity } from '../content-maintenance.ts';
import type { ContentSql, ContentTx } from './employee-content-model.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import { PersonalSkillError } from './personal-skill-model.ts';
import { readCurrentEmployeeBaseSkills } from './employee-current-skills.ts';

/** Read only immutable package identity. This is a collision check, never a
 * content grant. Callers authorize the instance first and serialize writes on
 * the existing employee-content organization lock. */
async function namesInManifest(
  sql: ContentSql,
  context: ContentIdentity,
  manifest: EmployeeContentManifest,
) {
  const rows =
    await sql`select scene->>'id' scene_id, a.digest, ref->>'digest' expected_digest,
      a.content ? 'skillPackage' packaged, a.content#>>'{skillPackage,frontmatter,name}' author_name
    from jsonb_array_elements(${sql.json(manifest)}::jsonb->'scenes') scene
    cross join lateral jsonb_array_elements(scene->'references') ref
    left join allrice_company_asset_revisions a on a.id=(ref->>'revisionId')::uuid
      and a.asset_id=(ref->>'contentId')::uuid and a.organization_id=${context.organizationId}
    where ref->>'sourceKind'='procedure'`;
  return rows.flatMap((row) => {
    if (!row.digest || row.digest !== row.expected_digest)
      throw new EmployeeContentError('source_changed');
    if (!row.packaged) return [];
    const sceneId = UuidSchema.parse(row.scene_id);
    const authorName =
      row.author_name === null
        ? null
        : WorkflowSkillFrontmatterSchema.shape.name.parse(row.author_name);
    return [
      { sceneId, authorName, name: authorName ?? `allrice-scene-${sceneId}` },
    ];
  });
}

export async function readPersonalSceneNames(
  sql: ContentSql,
  context: ContentIdentity,
  instanceId: string,
) {
  const [row] = await sql<
    { manifest: EmployeeContentManifest }[]
  >`select r.manifest
    from allrice_employee_content_sets s
    join allrice_employee_content_revisions r on r.id=s.active_revision_id and r.set_id=s.id
    where s.organization_id=${context.organizationId} and s.workspace_id=${context.workspaceId}
      and s.instance_id=${instanceId} and s.scope='personal' and s.owner_id=${context.actor.id}`;
  return row ? namesInManifest(sql, context, row.manifest) : [];
}

export async function assertOrdinarySkillSceneName(
  sql: ContentSql,
  context: ContentIdentity,
  instanceId: string,
  name: string,
) {
  if (
    (await readPersonalSceneNames(sql, context, instanceId)).some(
      (scene) => scene.name === name,
    )
  )
    throw new PersonalSkillError('name_conflict');
}

/** Used by controlled saves and the existing personal draft/restore/activate
 * writer, so a legacy endpoint cannot bypass the same native namespace. */
export async function assertPersonalSceneNames(
  tx: ContentTx,
  context: ContentIdentity,
  instance: EmployeeInstance,
  manifest: EmployeeContentManifest,
  previous: EmployeeContentManifest | undefined,
) {
  const names = await namesInManifest(tx, context, manifest);
  if (!names.length) return;
  const old = previous ? await namesInManifest(tx, context, previous) : [];
  for (const scene of names) {
    const prior = old.find((entry) => entry.sceneId === scene.sceneId);
    if (prior?.authorName && prior.authorName !== scene.authorName)
      throw new EmployeeContentError('version_conflict');
  }
  await assertPersonalSceneNamespace(tx, context, instance, names);
}

/** Current catalogs can change after an author saves. Check the native names
 * again at discovery/load rather than letting DSH silently choose a winner.
 * The caller supplies only currently authorized scenes; exact historical reads
 * retain their content address and do not re-enter today's command namespace. */
export async function assertPersonalSceneNamespace(
  tx: ContentSql,
  context: ContentIdentity,
  instance: EmployeeInstance,
  names: readonly { sceneId: string; name: string }[],
) {
  if (!names.length) return;
  const base = await readCurrentEmployeeBaseSkills(tx, instance);
  const ordinary = await tx<
    { name: string }[]
  >`select i.name from allrice_personal_skill_bindings b
    join allrice_personal_skill_installations i on i.id=b.installation_id and i.state='installed'
    where b.instance_id=${instance.id} and b.organization_id=${context.organizationId}
      and b.workspace_id=${context.workspaceId} and b.owner_id=${context.actor.id} and b.enabled`;
  const occupied = new Map<string, string | null>(
    [...base.nativeSkills, ...ordinary].map((skill) => [skill.name, null]),
  );
  for (const scene of names) {
    if (occupied.has(scene.name) && occupied.get(scene.name) !== scene.sceneId)
      throw new EmployeeContentError('version_conflict');
    occupied.set(scene.name, scene.sceneId);
  }
}
