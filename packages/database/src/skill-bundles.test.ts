import { describe, expect, it } from 'vitest';
import {
  personaRuntimePackageChecksum,
  type PersonaRuntimePackagePayload,
} from './platform-employees/runtime-package-signature.ts';
import {
  localCommandToolchainImageV1,
  SkillBundleSchema,
} from '@allrice/contracts';
import {
  skillBundleChecksum,
  skillBytesChecksum,
  validateSkillBundle,
  readFrozenSkillResource,
  frozenPackageSkills,
} from './skill-bundles.ts';

export function bundleFixture(
  version = '1.0.0',
  text = 'amount_cents must be integers\n',
) {
  const content = '# Reconciliation\n';
  const resource = Buffer.from(text);
  const payload = {
    schemaVersion: 1 as const,
    version,
    contentChecksum: skillBytesChecksum(content),
    sourceRef: `https://example.test/reviewed?content-sha256=${skillBytesChecksum(content).slice(7)}`,
    license: 'Apache-2.0',
    reviewedBy: 'synthetic-reviewer',
    resources: [
      {
        path: 'references/rules.txt',
        mediaType: 'text/plain',
        byteLength: resource.length,
        checksum: skillBytesChecksum(resource),
        contentBase64: resource.toString('base64'),
      },
    ],
    dependencies: [
      { kind: 'tool' as const, name: 'workspace.skill.read' },
      {
        kind: 'runtime' as const,
        name: 'node' as const,
        version: '22.23.2' as const,
        imageDigest: localCommandToolchainImageV1,
      },
    ],
  };
  return {
    content,
    bundle: { ...payload, checksum: skillBundleChecksum(payload) },
  };
}

function personaPackageFixture() {
  const { content, bundle } = bundleFixture();
  const skill = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'reconcile',
    description: 'Synthetic reviewed resource',
    content,
    checksum: skillBytesChecksum(content),
    invocation: { modelInvocable: true, userInvocable: true },
    requiredToolRefs: ['workspace.skill.read'],
    bundle,
  };
  const payload = {
    schemaVersion: 3,
    packageVersion: 'synthetic:r1',
    capabilityFingerprint: `sha256:${'a'.repeat(64)}`,
    foundation: {
      name: 'Synthetic employee',
      description: 'Frozen package reader fixture',
      appearance: { avatarType: 'initials', avatarValue: 'S' },
      identity: {
        role: 'Research partner',
        mission: 'Use the original source',
        workStyle: 'Return evidence',
        behaviorRules: [],
        safetyBoundaries: ['No additional grants'],
        expressionStyle: 'structured',
        outputLanguage: 'zh-CN',
      },
    },
    platformPolicy: 'Preserve platform authority.',
    skills: [skill],
    runtimeManifest: {
      source: 'allrice-published-runtime',
      harness: 'dsh',
      distributionGeneration: 'synthetic-generation',
      provider: 'openai-codex',
      model: 'synthetic',
      toolNames: ['workspace.skill.read'],
      deniedCapabilities: [],
      skillGovernance: [
        {
          id: skill.id,
          name: skill.name,
          source: 'allrice',
          sourceRef: bundle.sourceRef,
          version: bundle.version,
          license: bundle.license,
          reviewStatus: 'reviewed',
          reviewedByLabel: bundle.reviewedBy,
          reviewedAt: '2026-10-01T00:00:00.000Z',
          checksum: skill.checksum,
        },
      ],
    },
  } satisfies PersonaRuntimePackagePayload;
  return { ...payload, checksum: personaRuntimePackageChecksum(payload) };
}

describe('P18 immutable reviewed Skill bundles', () => {
  it('reads exact reviewed bundle resources from a signed PERSONA package without a second instruction-file catalog', () => {
    const pkg = personaPackageFixture();
    const before = structuredClone(pkg);
    const skills = frozenPackageSkills(pkg);
    expect(
      readFrozenSkillResource(skills, 'reconcile', 'references/rules.txt'),
    ).toMatchObject({
      version: pkg.skills[0]!.bundle.version,
      bundleChecksum: pkg.skills[0]!.bundle.checksum,
      contentBase64: pkg.skills[0]!.bundle.resources[0]!.contentBase64,
    });
    expect(pkg).toEqual(before);
    expect(pkg).not.toHaveProperty('files');
  });

  it('keeps inner resource and governance validation even when a schema-3 outer package is re-signed', () => {
    const corrupt = personaPackageFixture();
    corrupt.skills[0]!.bundle.resources[0]!.contentBase64 =
      Buffer.from('changed').toString('base64');
    const { checksum, ...payload } = corrupt;
    expect(checksum).not.toBe(personaRuntimePackageChecksum(payload));
    corrupt.checksum = personaRuntimePackageChecksum(payload);
    expect(() => frozenPackageSkills(corrupt)).toThrow(
      'skill_bundle_checksum_mismatch',
    );

    const mismatched = personaPackageFixture();
    mismatched.runtimeManifest.skillGovernance[0]!.sourceRef =
      'https://example.test/substituted';
    const { checksum: original, ...changed } = mismatched;
    expect(original).not.toBe(personaRuntimePackageChecksum(changed));
    mismatched.checksum = personaRuntimePackageChecksum(changed);
    expect(() => frozenPackageSkills(mismatched)).toThrow(
      'skill_bundle_governance_mismatch',
    );
  });

  it('verifies body/resources/governance and leaves scripts inert', () => {
    const { content, bundle } = bundleFixture();
    expect(validateSkillBundle(bundle, content)).toEqual(bundle);
    expect(() =>
      validateSkillBundle({ ...bundle, license: 'changed' }, content),
    ).toThrow('checksum');
    expect(() => validateSkillBundle(bundle, content + 'change')).toThrow(
      'checksum',
    );
    const skill = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'reconcile',
      description: 'test',
      content,
      checksum: skillBytesChecksum(content),
      invocation: { modelInvocable: true, userInvocable: true },
      requiredToolRefs: ['workspace.skill.read'],
      bundle,
    };
    expect(
      readFrozenSkillResource([skill], 'reconcile', 'references/rules.txt')
        .contentBase64,
    ).toBe(bundle.resources[0]!.contentBase64);
    expect(() =>
      readFrozenSkillResource([skill], 'other', 'references/rules.txt'),
    ).toThrow('frozen_run');
    expect(() =>
      readFrozenSkillResource([skill], 'reconcile', '../config'),
    ).toThrow('not_found');
  });
  it.each([
    '/etc/passwd',
    '../secret',
    'references/../secret',
    'assets//x',
    'scripts/./x',
    'scripts/a\\b',
    'hooks/start.js',
    'scripts/\u0000.js',
  ])('denies unsafe path %s', (path) => {
    const { bundle } = bundleFixture();
    expect(
      SkillBundleSchema.safeParse({
        ...bundle,
        resources: [{ ...bundle.resources[0], path }],
      }).success,
    ).toBe(false);
  });
  it('rejects tampered bytes even when the outer bundle is rehashed', () => {
    const { bundle, content } = bundleFixture();
    const { checksum, ...payload } = bundle;
    expect(checksum).toBe(skillBundleChecksum(payload));
    const edited = {
      ...payload,
      resources: [
        {
          ...bundle.resources[0]!,
          contentBase64: Buffer.from('changed').toString('base64'),
        },
      ],
    };
    expect(() =>
      validateSkillBundle(
        { ...edited, checksum: skillBundleChecksum(edited) },
        content,
      ),
    ).toThrow('resource_checksum');
  });
  it('rejects duplicate casefold paths, unknown dependencies and implicit hooks', () => {
    const { bundle } = bundleFixture();
    expect(
      SkillBundleSchema.safeParse({
        ...bundle,
        resources: [
          bundle.resources[0],
          { ...bundle.resources[0], path: 'references/RULES.txt' },
        ],
      }).success,
    ).toBe(false);
    expect(
      SkillBundleSchema.safeParse({
        ...bundle,
        hooks: { start: 'scripts/x.js' },
      }).success,
    ).toBe(false);
    expect(
      SkillBundleSchema.safeParse({
        ...bundle,
        dependencies: [{ kind: 'npm', name: 'evil', version: 'latest' }],
      }).success,
    ).toBe(false);
  });
  it('changes resource identity even if SKILL.md is unchanged', () => {
    const a = bundleFixture(),
      b = bundleFixture('1.0.1', 'updated reference\n');
    expect(a.bundle.contentChecksum).toBe(b.bundle.contentChecksum);
    expect(a.bundle.checksum).not.toBe(b.bundle.checksum);
  });
});
