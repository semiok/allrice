import { describe, expect, it } from 'vitest';
import {
  EmployeeRuntimePackageSchema,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import { source } from '../conversation/platform-test-binding.fixture.ts';
import { newNativeGeneration } from '../conversation/current-execution-binding.ts';
import { frozenPackageSkills } from '../skill-bundles.ts';
import {
  runtimePackageChecksum,
  runtimePackageSystemPrompt,
  validatePlatformEmployeeTestExecutionSnapshot,
  verifiedRuntimePackageChecksum,
} from './runtime-package.ts';

type PersonaPackage = Extract<EmployeeRuntimePackage, { schemaVersion: 3 }>;

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  return value;
}

function personaPayload(pkg: PersonaPackage) {
  return {
    schemaVersion: pkg.schemaVersion,
    packageVersion: pkg.packageVersion,
    capabilityFingerprint: pkg.capabilityFingerprint,
    foundation: pkg.foundation,
    platformPolicy: pkg.platformPolicy,
    skills: pkg.skills,
    runtimeManifest: pkg.runtimeManifest,
  };
}

// Fixture-only schema-3 bytes. No production writer or execution compiler is
// introduced; the profile intentionally retains its original legacy prompt.
function personaFixture(format: 'empty' | 'plain' | 'bundled' = 'bundled') {
  const input = source(newNativeGeneration, format);
  const definition = PlatformEmployeeDefinitionSchema.parse(input.definition);
  const profile = PlatformEmployeeRuntimeProfileSchema.parse(
    input.runtimeProfile,
  );
  const legacy = profile.runtimePackage!;
  if (legacy.schemaVersion === 3)
    throw Error('fixture_legacy_package_required');
  const { instructionPrecedence, ...runtimeManifest } = legacy.runtimeManifest;
  void instructionPrecedence;
  const payload = {
    schemaVersion: 3,
    packageVersion: legacy.packageVersion,
    capabilityFingerprint: legacy.capabilityFingerprint,
    foundation: {
      name: definition.name,
      description: definition.description,
      appearance: definition.appearance,
      identity: definition.identity,
    },
    platformPolicy: definition.systemPrompt,
    skills: legacy.skills,
    runtimeManifest,
  };
  const pkg = EmployeeRuntimePackageSchema.parse({
    ...payload,
    checksum: runtimePackageChecksum(payload),
  });
  if (pkg.schemaVersion !== 3) throw Error('fixture_persona_package_required');
  profile.runtimePackage = pkg;
  input.runtimeProfile = profile;
  input.packageChecksum = pkg.checksum;
  return { input, pkg, legacy };
}

function legacyPayload(schemaVersion: 1 | 2) {
  return {
    schemaVersion,
    packageVersion: 'legacy:r1',
    capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
    files: {
      identityMd: 'legacy identity',
      soulMd: 'legacy behavior and safety',
      userMd: 'legacy placeholder',
      agentsMd: 'legacy work rules',
    },
    skills: [],
    runtimeManifest: {
      source: 'allrice-published-runtime',
      harness: 'dsh',
      distributionGeneration: 'synthetic-legacy-generation',
      provider: 'openai-codex',
      model: 'synthetic',
      toolNames: [],
      deniedCapabilities: ['secret:use'],
      skillGovernance: [],
      instructionPrecedence: [
        'platform-hard-policy',
        'identity',
        'behavior',
        'work-rules',
        'tenant-user-context',
        'runtime-authorization',
        'user-request',
        'skill-details',
      ],
    },
  };
}

describe('runtime package data-format readers', () => {
  it.each([
    [
      1,
      'sha256:87fd27f8d62a9dc85fbaeb846a0e2738b4132c5ed09808eec837f823750b2595',
    ],
    [
      2,
      'sha256:0f21b211c81f03ebba987d85bc177c177e81cd9f5fb3f7d04073700fc98294d6',
    ],
  ] as const)(
    'retains the original schema %s signed byte order after JSONB reordering',
    (version, checksum) => {
      const payload = legacyPayload(version);
      // Fixed legacy bytes, not a signature obtained from the new reader.
      expect(runtimePackageChecksum(payload)).toBe(checksum);
      const original = { ...payload, checksum };
      const reordered = reverseKeys(original);
      const before = JSON.stringify(reordered);
      expect(verifiedRuntimePackageChecksum(reordered)).toBe(checksum);
      expect(frozenPackageSkills(reordered)).toEqual([]);
      expect(JSON.stringify(reordered)).toBe(before);
      const parsed = EmployeeRuntimePackageSchema.parse(reordered);
      expect(parsed).not.toHaveProperty('foundation');
      expect(parsed).not.toHaveProperty('platformPolicy');
      expect(
        runtimePackageSystemPrompt({
          platformPolicy: 'platform',
          runtimePackage: parsed,
        }),
      ).toBe(
        '# Platform hard policy\nplatform\n\nlegacy identity\n\nlegacy behavior and safety\n\nlegacy work rules\n\nlegacy placeholder',
      );
    },
  );

  it.each(['empty', 'plain', 'bundled'] as const)(
    'keeps the current %s writer on legacy formats with unchanged instruction files',
    (format) => {
      const input = source(newNativeGeneration, format);
      const profile = PlatformEmployeeRuntimeProfileSchema.parse(
        input.runtimeProfile,
      );
      const pkg = profile.runtimePackage!;
      expect(pkg.schemaVersion).toBe(format === 'bundled' ? 2 : 1);
      expect(pkg).toHaveProperty('files');
      expect(pkg).not.toHaveProperty('foundation');
      expect(pkg).not.toHaveProperty('platformPolicy');
      expect(verifiedRuntimePackageChecksum(reverseKeys(pkg))).toBe(
        pkg.checksum,
      );
      expect(frozenPackageSkills(reverseKeys(pkg))).toEqual(pkg.skills);
      expect(
        validatePlatformEmployeeTestExecutionSnapshot(input).runtimeProfile,
      ).toEqual(profile);
    },
  );

  it('verifies all schema-3 source bytes and frozen bundles after JSONB reordering without inventing old files', () => {
    const { pkg } = personaFixture();
    const reordered = reverseKeys(pkg);
    const before = JSON.stringify(reordered);
    expect(verifiedRuntimePackageChecksum(reordered)).toBe(pkg.checksum);
    expect(frozenPackageSkills(reordered)).toEqual(pkg.skills);
    expect(JSON.stringify(reordered)).toBe(before);
    expect(pkg).not.toHaveProperty('files');
    expect(pkg.runtimeManifest).not.toHaveProperty('instructionPrecedence');
  });

  const sourceChanges: [string, (pkg: PersonaPackage) => void][] = [
    [
      'name',
      (pkg) => {
        pkg.foundation.name += ' changed';
      },
    ],
    [
      'description',
      (pkg) => {
        pkg.foundation.description += ' changed';
      },
    ],
    [
      'appearance',
      (pkg) => {
        pkg.foundation.appearance.avatarValue = 'changed';
      },
    ],
    [
      'role',
      (pkg) => {
        pkg.foundation.identity.role += ' changed';
      },
    ],
    [
      'mission',
      (pkg) => {
        pkg.foundation.identity.mission += ' changed';
      },
    ],
    [
      'workStyle',
      (pkg) => {
        pkg.foundation.identity.workStyle += ' changed';
      },
    ],
    [
      'behaviorRules',
      (pkg) => {
        pkg.foundation.identity.behaviorRules.push('changed');
      },
    ],
    [
      'safetyBoundaries',
      (pkg) => {
        pkg.foundation.identity.safetyBoundaries = [];
      },
    ],
    [
      'expressionStyle',
      (pkg) => {
        pkg.foundation.identity.expressionStyle = 'exploratory';
      },
    ],
    [
      'outputLanguage',
      (pkg) => {
        pkg.foundation.identity.outputLanguage = 'en-US';
      },
    ],
    [
      'platformPolicy',
      (pkg) => {
        pkg.platformPolicy += ' changed';
      },
    ],
  ];

  it.each(sourceChanges)(
    'rejects unsigned %s changes in both package readers',
    (_field, change) => {
      const { pkg } = personaFixture();
      change(pkg);
      expect(verifiedRuntimePackageChecksum(pkg)).toBeNull();
      expect(() => frozenPackageSkills(pkg)).toThrow(
        'runtime_package_checksum_mismatch',
      );
    },
  );

  it.each(sourceChanges)(
    'rejects re-signed %s inconsistent with its frozen platform definition',
    (_field, change) => {
      const { input, pkg } = personaFixture();
      change(pkg);
      pkg.checksum = runtimePackageChecksum(personaPayload(pkg));
      input.packageChecksum = pkg.checksum;
      expect(verifiedRuntimePackageChecksum(pkg)).toBe(pkg.checksum);
      expect(() =>
        validatePlatformEmployeeTestExecutionSnapshot(input),
      ).toThrow('platform_employee_test_persona_source_mismatch');
    },
  );

  it('keeps preview profile checks and explicitly refuses schema-3 execution until the context compiler exists', () => {
    const { input, pkg } = personaFixture();
    expect(() => validatePlatformEmployeeTestExecutionSnapshot(input)).toThrow(
      'platform_employee_test_persona_execution_unsupported',
    );
    expect(() =>
      runtimePackageSystemPrompt({
        platformPolicy: pkg.platformPolicy,
        runtimePackage: pkg,
      }),
    ).toThrow('runtime_package_persona_execution_unsupported');
    const profile = input.runtimeProfile as ReturnType<
      typeof PlatformEmployeeRuntimeProfileSchema.parse
    >;
    profile.credentialReference = 'deployment:substituted';
    expect(() => validatePlatformEmployeeTestExecutionSnapshot(input)).toThrow(
      'platform_employee_test_runtime_snapshot_mismatch',
    );
  });
});
