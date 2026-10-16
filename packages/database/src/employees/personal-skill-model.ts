import {
  PersonalSkillPackageSchema,
  PersonalSkillItemSchema,
  type PersonalSkillPackage,
} from '@allrice/contracts';
import { DataAccessError } from '../data.ts';
import type { ContentIdentity } from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import type { ContentSql } from './employee-content-model.ts';

export class PersonalSkillError extends Error {
  constructor(
    readonly code:
      | 'intent_required'
      | 'source_invalid'
      | 'name_conflict'
      | 'limit'
      | 'conflict'
      | 'unavailable',
  ) {
    super(`personal_skill_${code}`);
  }
}
export const unavailable = (): never => {
  throw new PersonalSkillError('unavailable');
};
export const owner = (context: ContentIdentity) =>
  context.actor.type === 'user' ? context.actor.id : unavailable();

export function packageVersionChecksum(
  definitionChecksum: string,
  manifest: PersonalSkillPackage,
) {
  return runtimePolicyDigest({
    definitionChecksum,
    sourcePath: manifest.sourcePath,
    resources: manifest.resources,
  });
}
export function validPackage(
  raw: unknown,
  checksum: string | null,
  definitionChecksum: string,
) {
  if (raw === null && checksum === null) return undefined;
  const manifest = PersonalSkillPackageSchema.parse(raw);
  const { checksum: manifestChecksum, ...payload } = manifest;
  if (
    runtimePolicyDigest(payload) !== manifestChecksum ||
    packageVersionChecksum(definitionChecksum, manifest) !== checksum
  )
    return unavailable();
  return manifest;
}

export async function personalSkillItems(
  context: ContentIdentity,
  sql: ContentSql,
  id?: string,
) {
  const rows = await sql`
    select i.*,v.version,v.source,v.definition,v.definition_checksum,v.resource_manifest,v.package_checksum from allrice_personal_skill_installations i
    join allrice_personal_skill_versions v on v.id=i.current_version_id
    where i.organization_id=${context.organizationId} and i.owner_id=${owner(context)}
      and (${id ?? null}::uuid is null or i.id=${id ?? null}) order by i.created_at desc limit 128`;
  const bindings = rows.length
    ? await sql`select b.*,emp.name as employee_name,e.profile from allrice_personal_skill_bindings b
    join allrice_employee_instances e on e.id=b.instance_id and e.archived_at is null
    join allrice_employee_assignments a on a.id=e.assignment_id and a.active
    join allrice_employees emp on emp.id=a.employee_id
    where b.installation_id in ${sql(rows.map((r) => r.id))} and b.organization_id=${context.organizationId}
      and b.owner_id=${owner(context)} and b.workspace_id=${context.workspaceId} order by b.id`
    : [];
  const readable = new Map<string, boolean>();
  const results = [];
  for (const row of rows) {
    const visible = [];
    for (const b of bindings.filter((b) => b.installation_id === row.id)) {
      if (!readable.has(b.instance_id)) {
        try {
          await getEmployeeInstance(context, b.instance_id, sql);
          readable.set(b.instance_id, true);
        } catch (error) {
          if (!(error instanceof DataAccessError)) throw error;
          readable.set(b.instance_id, false);
        }
      }
      if (!readable.get(b.instance_id)) continue;
      visible.push({
        id: b.id,
        instanceId: b.instance_id,
        workspaceId: b.workspace_id,
        enabled: b.enabled,
        epoch: b.epoch,
        label: b.profile?.name ?? b.employee_name,
      });
    }
    // The library belongs to the person, independently of a revoked binding.
    results.push(
      PersonalSkillItemSchema.parse({
        id: row.id,
        name: row.name,
        description: row.definition.description,
        revision: row.revision,
        state: row.state,
        versionId: row.current_version_id,
        version: row.version,
        source: row.source,
        definitionChecksum: row.definition_checksum,
        ...(row.package_checksum
          ? {
              packageChecksum: row.package_checksum,
              resourceCount: row.resource_manifest.resources.length,
            }
          : {}),
        compatibility: 'instruction_format_checked',
        businessVerification: 'not_verified',
        bindings: visible,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }),
    );
  }
  return results;
}
