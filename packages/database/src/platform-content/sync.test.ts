import { describe, expect, it } from 'vitest';

import type { ResolvedPlatformSkill } from './catalog.js';
import { planPlatformSkillSync, type ExistingPlatformSkill } from './sync.js';

function skill(
  overrides: Partial<ResolvedPlatformSkill> = {},
): ResolvedPlatformSkill {
  const checksum = `sha256:${'1'.repeat(64)}`;
  return {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'sample',
    contentFile: 'skills/sample/SKILL.md',
    description: 'Sample',
    content: '# Sample\n',
    version: '1.0.0',
    checksum,
    source: 'allrice',
    sourceRef: `https://github.com/semiok/allrice/tree/main/skills/sample?content-sha256=${checksum.slice(7)}`,
    license: 'Apache-2.0',
    reviewStatus: 'reviewed',
    reviewedByLabel: 'test',
    createdByLabel: 'test',
    modelInvocable: true,
    userInvocable: true,
    requiredToolRefs: ['web.search'],
    enabled: true,
    ...overrides,
  };
}

function existing(
  desired: ResolvedPlatformSkill,
  overrides: Partial<ExistingPlatformSkill> = {},
): ExistingPlatformSkill {
  const { contentFile, createdByLabel, ...row } = desired;
  void contentFile;
  void createdByLabel;
  return { ...row, ...overrides };
}

describe('platform content synchronization plan', () => {
  it('is idempotent when catalog and database operational fields match', () => {
    const desired = skill();
    const plan = planPlatformSkillSync([existing(desired)], [desired]);

    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toEqual([desired]);
  });

  it('updates managed rows without deleting unmanaged platform Skills', () => {
    const desired = skill();
    const unmanaged = existing(
      skill({
        id: '20000000-0000-4000-8000-000000000002',
        name: 'operator-managed',
        contentFile: 'skills/operator-managed/SKILL.md',
      }),
    );
    const plan = planPlatformSkillSync(
      [
        existing(desired, {
          description: 'Old description',
          version: '0.9.0',
        }),
        unmanaged,
      ],
      [desired],
    );

    expect(plan.updates).toEqual([desired]);
    expect(plan.unmanaged).toEqual([unmanaged]);
  });

  it('fails closed on version regression', () => {
    const desired = skill({ version: '1.1.9' });

    expect(() =>
      planPlatformSkillSync(
        [existing(desired, { version: '1.2.0' })],
        [desired],
      ),
    ).toThrow('platform_skill_version_regression:sample:1.2.0->1.1.9');
  });

  it('requires a version bump when reviewed content or provenance changes', () => {
    const desired = skill();

    expect(() =>
      planPlatformSkillSync(
        [existing(desired, { content: '# Previous\n' })],
        [desired],
      ),
    ).toThrow('platform_skill_version_bump_required:sample:1.0.0');
    expect(() =>
      planPlatformSkillSync(
        [
          existing(desired, {
            sourceRef: `${desired.sourceRef}&revision=previous`,
          }),
        ],
        [desired],
      ),
    ).toThrow('platform_skill_version_bump_required:sample:1.0.0');
  });

  it('allows reviewed content changes only with a higher version', () => {
    const desired = skill({ version: '1.0.1' });
    const plan = planPlatformSkillSync(
      [existing(desired, { version: '1.0.0', content: '# Previous\n' })],
      [desired],
    );

    expect(plan.updates).toEqual([desired]);
  });

  it('allows same-version changes to operational enablement without reversioning content', () => {
    const desired = skill({ enabled: false });
    const plan = planPlatformSkillSync(
      [existing(desired, { enabled: true })],
      [desired],
    );

    expect(plan.updates).toEqual([desired]);
  });

  it('fails closed when a stable Skill id or name is reused', () => {
    const desired = skill();

    expect(() =>
      planPlatformSkillSync(
        [existing(desired, { id: '20000000-0000-4000-8000-000000000002' })],
        [desired],
      ),
    ).toThrow('platform_skill_identity_conflict:sample');
  });
});
