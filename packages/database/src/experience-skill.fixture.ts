import { randomUUID } from 'node:crypto';
import type { PersonalSkillPin } from '@allrice/contracts';
import { skillBytesChecksum } from './skill-bundles.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

/** Synthetic instructions only; never imports private user Skill content. */
export function experienceSkillFixture(
  identity: Partial<PersonalSkillPin> = {},
) {
  const content =
    '# Attendance counting\n核对原始名单中的到场、未到人数与成员，分别列出。缺少名单或状态不明时说明缺失，不推算。';
  const definition = {
    name: 'attendance-counting',
    description: '核对有明确状态的合成名单。',
    content,
    checksum: skillBytesChecksum(content),
    invocation: { modelInvocable: true, userInvocable: true },
  };
  const pin: PersonalSkillPin = {
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    instanceId: randomUUID(),
    installationId: randomUUID(),
    versionId: randomUUID(),
    bindingId: randomUUID(),
    bindingEpoch: 1,
    definitionChecksum: runtimePolicyDigest(definition),
    ...identity,
  };
  const index = {
    schemaVersion: 1 as const,
    instanceId: pin.instanceId,
    skills: [pin],
  };
  return {
    pin,
    definition,
    personalSkills: { ...index, checksum: runtimePolicyDigest(index) },
    nativeSkill: {
      ...definition,
      id: pin.versionId,
      personal: pin,
      requiredToolRefs: [],
    },
  };
}
