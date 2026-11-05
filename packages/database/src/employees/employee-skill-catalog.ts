import {
  PersonalSkillDefinitionSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  hiddenSystemSkillNames,
  platformSkillDisplayName,
} from '../platform-content/skill-display.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { readCurrentEmployeeBaseSkills } from './employee-current-skills.ts';
import {
  PersonalSkillError,
  personalSkillItems,
  validPackage,
} from './personal-skill-model.ts';

/** A current display projection, never a grant or a stored Run snapshot.
 * Read-only isolation keeps every row in one view without blocking writers. */
export async function getEmployeeSkillCatalog(
  context: RequestContext,
  instanceIdInput: string,
) {
  const instanceId = UuidSchema.parse(instanceIdInput);
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      const principal = await readContentPrincipal(context, tx);
      if (!principal) throw new DataAccessError('authorization_denied');
      const instance = await getEmployeeInstance(context, instanceId, tx);
      const base = await readCurrentEmployeeBaseSkills(tx, instance);
      const names = new Set(base.nativeSkills.map((s) => s.name));
      const personalSkills = [];
      for (const skill of await personalSkillItems(context, tx)) {
        const binding = skill.bindings.find(
          (b) => b.instanceId === instanceId && b.enabled,
        );
        if (skill.state !== 'installed' || !binding) continue;
        if (names.has(skill.name))
          throw new PersonalSkillError('name_conflict');
        names.add(skill.name);
        const [row] =
          await tx`select definition,resource_manifest from allrice_personal_skill_versions
        where id=${skill.versionId} and installation_id=${skill.id} and organization_id=${context.organizationId} and owner_id=${context.actor.id}`;
        if (!row) throw new PersonalSkillError('unavailable');
        const definition = PersonalSkillDefinitionSchema.parse(row.definition);
        if (
          definition.name !== skill.name ||
          runtimePolicyDigest(definition) !== skill.definitionChecksum
        )
          throw new PersonalSkillError('unavailable');
        validPackage(
          row.resource_manifest,
          skill.packageChecksum ?? null,
          skill.definitionChecksum,
        );
        personalSkills.push({
          kind: 'personal' as const,
          name: skill.name,
          displayName:
            authorString(definition.metadata?.displayName) ?? skill.name,
          description: definition.description,
          version: authorString(definition.metadata?.version),
          installationVersion: skill.version,
          installationId: skill.id,
          versionId: skill.versionId,
          revision: skill.revision,
          binding,
          source: skill.source,
          canUninstall: principal.writable,
          definitionChecksum: skill.definitionChecksum,
          ...(skill.packageChecksum
            ? {
                packageChecksum: skill.packageChecksum,
                resourceCount: skill.resourceCount,
              }
            : {}),
        });
      }
      return {
        instanceId,
        canInstall: principal.writable,
        platformSkills: base.nativeSkills
          .filter((s) => !hiddenSystemSkillNames.has(s.name))
          .map((skill) => ({
            kind: 'platform' as const,
            id: skill.id,
            name: skill.name,
            displayName: platformSkillDisplayName(skill),
            description: skill.description,
            version: base.versions.get(skill.id) ?? null,
            checksum: skill.checksum,
            canUninstall: false as const,
          })),
        personalSkills: personalSkills.sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      };
    },
  );
}

function authorString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}
