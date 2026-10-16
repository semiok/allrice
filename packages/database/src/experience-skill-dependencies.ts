import type postgres from 'postgres';
import {
  PersonalSkillSnapshotSchema,
  type ExperienceEvidence,
  type PersonalSkillPin,
  type PersonalSkillSnapshot,
} from '@allrice/contracts';
import type { ContentIdentity } from './content-maintenance.ts';
import type { getDatabase } from './core/client.ts';
import { ExperienceError } from './experience.ts';
import {
  assertFrozenPersonalSkills,
  assertPersonalSkillsReadable,
  freezePersonalSkillsInTransaction,
} from './employees/personal-skills.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

type Sql = postgres.TransactionSql | ReturnType<typeof getDatabase>;
type Source = { evidence: Pick<ExperienceEvidence, 'skills' | 'truncated'> };
const deny = (): never => {
  throw new ExperienceError('source_changed');
};

/** Conflicting historical versions are not silently collapsed into the latest. */
export function experienceSkillDependencies(
  instanceId: string,
  sources: Source[],
) {
  const pins = new Map<string, PersonalSkillPin>();
  for (const source of sources) {
    if (source.evidence.truncated) return deny();
    for (const { pin } of source.evidence.skills) {
      const prior = pins.get(pin.bindingId);
      if (
        pin.instanceId !== instanceId ||
        (prior && runtimePolicyDigest(prior) !== runtimePolicyDigest(pin))
      )
        return deny();
      pins.set(pin.bindingId, pin);
    }
  }
  if (!pins.size) return undefined;
  if (pins.size > 8) return deny();
  const index = {
    schemaVersion: 1 as const,
    instanceId,
    skills: [...pins.values()].sort((a, b) =>
      a.bindingId.localeCompare(b.bindingId),
    ),
  };
  return PersonalSkillSnapshotSchema.parse({
    ...index,
    checksum: runtimePolicyDigest(index),
  });
}

/** Historical readability intentionally permits older versions. Executable
 * experience additionally requires the currently installed version. */
export async function assertExperienceSkillsCurrent(
  sql: Sql,
  who: ContentIdentity,
  dependencies: PersonalSkillSnapshot,
) {
  await assertPersonalSkillsReadable(who, dependencies, sql);
  for (const pin of dependencies.skills) {
    const [current] =
      await sql`select current_version_id from allrice_personal_skill_installations
      where id=${pin.installationId} and organization_id=${who.organizationId} and owner_id=${who.actor.id} and state='installed'`;
    if (current?.current_version_id !== pin.versionId) return deny();
  }
}

/** A queued Run may still carry a different immutable Skill version even when
 * the installation has changed. Never combine a proof with that other version. */
export function experienceSkillsMatchRun(
  dependencies: PersonalSkillSnapshot,
  raw: unknown,
) {
  const parsed = PersonalSkillSnapshotSchema.safeParse(raw);
  if (!parsed.success) return false;
  const { checksum, ...index } = parsed.data;
  return (
    runtimePolicyDigest(index) === checksum &&
    index.instanceId === dependencies.instanceId &&
    dependencies.skills.every((p) =>
      index.skills.some(
        (s) => runtimePolicyDigest(s) === runtimePolicyDigest(p),
      ),
    )
  );
}

export async function freezeExperienceSkills(
  tx: postgres.TransactionSql,
  who: ContentIdentity,
  instanceId: string,
  sources: Source[],
) {
  const personalSkills = experienceSkillDependencies(instanceId, sources);
  if (!personalSkills) return undefined;
  const frozen = await freezePersonalSkillsInTransaction(
    tx,
    who,
    { id: instanceId },
    { nativeSkills: [] },
  );
  if (!experienceSkillsMatchRun(personalSkills, frozen.personalSkills))
    return deny();
  const nativeSkills = frozen.nativeSkills.filter((s) =>
    personalSkills.skills.some((pin) => pin.versionId === s.id),
  );
  assertFrozenPersonalSkills(personalSkills, nativeSkills, instanceId);
  // The isolated case supports native Skill instructions only. Resources,
  // scripts, file/network grants are not inferred from a successful count.
  if (
    nativeSkills.some(
      (s) =>
        s.personal?.packageChecksum || s.requiredToolRefs.length || s.bundle,
    )
  )
    return deny();
  return { personalSkills, nativeSkills };
}
