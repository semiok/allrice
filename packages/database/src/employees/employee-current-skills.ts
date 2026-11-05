import {
  EmployeeManifestSchema,
  type EmployeeInstance,
  type DshNativeSkillSnapshot,
} from '@allrice/contracts';
import type { ContentSql, ContentTx } from './employee-content-model.ts';
import { DataAccessError } from '../data.ts';
import { frozenPackageSkills, validateFrozenSkill } from '../skill-bundles.ts';
import { freezeEmployeeBaseSkills } from './employee-base-skills.ts';

/** Current instance publication + current platform catalog, with the same
 * legacy fallback as Run admission. Does not create or consult a Run, freeze
 * grants, or confer tool permissions. Caller first authorizes the instance. */
export async function readCurrentEmployeeBaseSkills(
  sql: ContentSql,
  instance: EmployeeInstance,
): Promise<Awaited<ReturnType<typeof readBaseInTransaction>>> {
  return 'begin' in sql
    ? sql.begin('isolation level repeatable read read only', (tx) =>
        readBaseInTransaction(tx, instance),
      )
    : readBaseInTransaction(sql, instance);
}

async function readBaseInTransaction(
  tx: ContentTx,
  instance: EmployeeInstance,
) {
  const [row] = await tx`
    select manifest,employee_id from allrice_employee_versions
    where id=${instance.source.employeeVersionId}
      and organization_id=${instance.organizationId}
      and workspace_id=${instance.workspaceId}`;
  if (!row) throw new DataAccessError('not_found');
  const manifest = EmployeeManifestSchema.parse(row.manifest);
  let original: DshNativeSkillSnapshot[];
  const versions = new Map<string, string>();
  if (manifest.schemaVersion === 2 && manifest.runtimePackage) {
    original = frozenPackageSkills(manifest.runtimePackage);
    for (const entry of manifest.runtimePackage.runtimeManifest.skillGovernance)
      versions.set(entry.id, entry.version);
  } else {
    const skills = await tx`
      select s.* from allrice_employee_dsh_skill_bindings b
      join allrice_dsh_skills s on s.id=b.skill_id
        and s.organization_id=b.organization_id and s.workspace_id=b.workspace_id
      where b.organization_id=${instance.organizationId}
        and b.workspace_id=${instance.workspaceId} and b.employee_id=${row.employee_id}
        and b.enabled and s.enabled order by s.name,s.id`;
    for (const skill of skills) versions.set(skill.id, skill.version);
    original = skills.map((skill) =>
      validateFrozenSkill({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        checksum: skill.checksum,
        invocation: {
          modelInvocable: skill.model_invocable,
          userInvocable: skill.user_invocable,
        },
        requiredToolRefs: skill.required_tool_refs,
        ...(skill.bundle ? { bundle: skill.bundle } : {}),
      }),
    );
  }
  const current = await freezeEmployeeBaseSkills(original, tx);
  for (const entry of current.catalog?.skills ?? [])
    versions.set(entry.id, entry.version);
  return { ...current, versions };
}
