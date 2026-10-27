const oldGeneration = 'dsh-0.1.5-rc.3-a4c74a9' as const;
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localCommandToolchainImageV1,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeRuntimePackage,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
  runtimePackageSystemPrompt,
} from '../platform-employees/runtime-package.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';
import {
  nativeRootDigest,
  newNativeGeneration,
} from './current-execution-binding.ts';
import {
  assertCurrentPlatformTestOrigin,
  assertPlatformTestExecutionBinding,
  CurrentPlatformTestOriginSchema,
  freezePlatformTestExecutionBinding,
  newCurrentPlatformTestOrigin,
  PlatformTestExecutionBindingSchema,
  validatePlatformTestExecutionSource,
  type PlatformTestExecutionBindingInput,
  type PlatformTestExecutionScope,
  type PlatformTestExecutionSourceInput,
  type PlatformTestPurpose,
} from './current-platform-test-binding.ts';

const artifact = `sha256:${'a'.repeat(64)}`;
beforeEach(() => {
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
});
afterEach(() => vi.unstubAllEnvs());

function scope(): PlatformTestExecutionScope {
  return {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    testId: randomUUID(),
  };
}
function definition(): PlatformEmployeeDefinition {
  return PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'platform-binding-fixture',
    name: 'Binding fixture',
    description: 'Offline source identity fixture',
    appearance: { avatarType: 'initials', avatarValue: 'B' },
    identity: {
      role: 'Fixture',
      mission: 'Check original sources',
      workStyle: 'Return exact evidence',
      behaviorRules: ['Use authorized data only'],
      safetyBoundaries: ['No additional grants'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Preserve source identity and authorization.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'synthetic-original',
      reasoningEffort: 'high',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['workspace.skill.read'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  });
}
// Fixture-only publisher resealing permits deliberate, signed-but-incompatible
// inputs. Production validation still uses the real shared publisher helpers.
function reseal(pkg: EmployeeRuntimePackage) {
  const p = pkg.runtimeManifest;
  pkg.capabilityFingerprint = runtimePackageChecksum({
    distributionGeneration: p.distributionGeneration,
    provider: p.provider,
    model: p.model,
    tools: [...p.toolNames].sort(),
    skills: pkg.skills.map((s) => ({
      name: s.name,
      checksum: s.checksum,
      requiredToolRefs: [...s.requiredToolRefs].sort(),
      ...(s.bundle ? { bundleChecksum: s.bundle.checksum } : {}),
    })),
    deniedCapabilities: [...p.deniedCapabilities].sort(),
  });
  pkg.checksum = runtimePackageChecksum({
    schemaVersion: pkg.schemaVersion,
    packageVersion: pkg.packageVersion,
    capabilityFingerprint: pkg.capabilityFingerprint,
    files: {
      identityMd: pkg.files.identityMd,
      soulMd: pkg.files.soulMd,
      userMd: pkg.files.userMd,
      agentsMd: pkg.files.agentsMd,
    },
    skills: pkg.skills,
    runtimeManifest: pkg.runtimeManifest,
  });
}
function source(
  generation:
    typeof newNativeGeneration | typeof oldGeneration = newNativeGeneration,
  format: 'empty' | 'plain' | 'bundled' = 'plain',
  purpose: PlatformTestPurpose = 'platform_preview',
): PlatformTestExecutionSourceInput {
  const d = definition();
  const content = '# Fixture skill\nRead the reviewed resource only.\n';
  const bytes = Buffer.from('fixture-only\n');
  const bundle = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    contentChecksum: skillBytesChecksum(content),
    sourceRef: 'https://example.test/platform-binding',
    license: 'Apache-2.0',
    reviewedBy: 'fixture-reviewer',
    resources: [
      {
        path: 'references/input.txt',
        mediaType: 'text/plain',
        byteLength: bytes.length,
        checksum: skillBytesChecksum(bytes),
        contentBase64: bytes.toString('base64'),
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
  const skills: Parameters<typeof buildEmployeeRuntimePackage>[0]['skills'] =
    format === 'empty'
      ? []
      : [
          {
            id: randomUUID(),
            name: 'platform-binding-fixture',
            description: 'Actual publisher fixture',
            content,
            checksum: skillBytesChecksum(content),
            model_invocable: true,
            user_invocable: true,
            required_tool_refs: ['workspace.skill.read'],
            source: 'allrice',
            source_ref: bundle.sourceRef,
            version: bundle.version,
            license: bundle.license,
            review_status: 'reviewed',
            reviewed_by_label: bundle.reviewedBy,
            reviewed_at: new Date('2026-10-01T00:00:00.000Z'),
            ...(format === 'bundled'
              ? { bundle: { ...bundle, checksum: skillBundleChecksum(bundle) } }
              : {}),
          },
        ];
  d.capabilities.nativeSkillIds = skills.map((s) => s.id);
  const pkg = buildEmployeeRuntimePackage({
    revision: 7,
    definition: d,
    skills,
  });
  if (generation !== newNativeGeneration) {
    pkg.runtimeManifest.distributionGeneration = generation;
    reseal(pkg);
  }
  const profile = PlatformEmployeeRuntimeProfileSchema.parse({
    schemaVersion: 1,
    harness: 'dsh',
    distributionGeneration: generation,
    employeeKey: d.key,
    provider: d.modelPolicy.provider,
    model: d.modelPolicy.model,
    reasoningEffort: d.modelPolicy.reasoningEffort,
    timeoutMs: d.modelPolicy.timeoutMs,
    credentialReference: d.modelPolicy.credentialReference,
    baseUrl: d.modelPolicy.baseUrl,
    systemPrompt: runtimePackageSystemPrompt({
      platformPolicy: d.systemPrompt,
      runtimePackage: pkg,
    }),
    nativeSkillIds: pkg.skills.map((s) => s.id),
    nativeSkillChecksums: pkg.skills.map((s) => s.checksum),
    toolNames: d.capabilities.toolNames,
    connectorRefs: d.capabilities.connectorRefs,
    securityPolicy: d.securityPolicy,
    runtimePackage: pkg,
  });
  return {
    platformEmployeeId: randomUUID(),
    platformRevisionId: randomUUID(),
    purpose,
    definitionChecksum: runtimePackageChecksum(d),
    definition: d,
    runtimeProfile: profile,
    nativeSkills: pkg.skills,
    packageChecksum: pkg.checksum,
  };
}
function profile(s: PlatformTestExecutionSourceInput) {
  return s.runtimeProfile as ReturnType<
    typeof PlatformEmployeeRuntimeProfileSchema.parse
  >;
}
function resealSource(s: PlatformTestExecutionSourceInput) {
  const p = profile(s),
    pkg = p.runtimePackage!;
  reseal(pkg);
  s.packageChecksum = pkg.checksum;
  s.nativeSkills = pkg.skills;
  p.nativeSkillIds = pkg.skills.map((x) => x.id);
  p.nativeSkillChecksums = pkg.skills.map((x) => x.checksum);
  p.systemPrompt = runtimePackageSystemPrompt({
    platformPolicy: (s.definition as PlatformEmployeeDefinition).systemPrompt,
    runtimePackage: pkg,
  });
  s.definitionChecksum = runtimePackageChecksum(
    PlatformEmployeeDefinitionSchema.parse(s.definition),
  );
}
function frozen(
  s = source(),
  ownScope = scope(),
): PlatformTestExecutionBindingInput {
  const input = { source: s, scope: ownScope };
  return { ...input, origin: newCurrentPlatformTestOrigin(input) };
}
function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseObjectKeys(v)]),
    );
  return value;
}

describe('platform test source compatibility through the actual package builder', () => {
  for (const generation of [newNativeGeneration] as const)
    for (const format of ['empty', 'plain', 'bundled'] as const)
      for (const purpose of [
        'platform_preview',
        'method_candidate',
        'experience_validation',
      ] as const)
        it(`${generation}/${format}/${purpose} keeps its original source and independently binds current execution`, () => {
          const s = source(generation, format, purpose),
            original = JSON.stringify(s);
          const input = frozen(s),
            binding = freezePlatformTestExecutionBinding(input);
          expect(binding.source).toMatchObject({
            kind: 'platform_test_snapshot',
            definitionSchema: 1,
            purpose,
            platformEmployeeId: s.platformEmployeeId,
            platformRevisionId: s.platformRevisionId,
            packageSchema: format === 'bundled' ? 2 : 1,
            packageChecksum: s.packageChecksum,
            declaredGeneration: generation,
          });
          expect(binding.execution).toEqual({
            artifactId: artifact,
            generation: newNativeGeneration,
            profileId: 'restricted',
          });
          expect(binding.scope).toEqual(input.scope);
          expect(binding.source.definitionChecksum).toBe(s.definitionChecksum);
          expect(binding.source.definitionChecksum).not.toBe(
            binding.source.packageChecksum,
          );
          expect(JSON.stringify(s)).toBe(original);
          expect(assertPlatformTestExecutionBinding(binding, input)).toEqual(
            binding,
          );
        });

  it('restores publisher checksum semantics after JSONB reordering without changing origin or binding', () => {
    const input = frozen(
      source(newNativeGeneration, 'bundled', 'method_candidate'),
    );
    const binding = freezePlatformTestExecutionBinding(input);
    const reordered = reverseObjectKeys(
      input,
    ) as PlatformTestExecutionBindingInput;
    expect(
      assertPlatformTestExecutionBinding(reverseObjectKeys(binding), reordered),
    ).toEqual(binding);
  });

  it('rejects profile/package generation disagreement before translating to current', () => {
    const s = source(newNativeGeneration);
    profile(s).runtimePackage!.runtimeManifest.distributionGeneration =
      oldGeneration;
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_PLATFORM_TEST_GENERATION_MISMATCH',
    );
  });

  it('rejects connector declaration changes without treating them as new authority', () => {
    const s = source();
    profile(s).connectorRefs = ['substituted-connector'];
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_PLATFORM_TEST_CONNECTOR_DECLARATION_MISMATCH',
    );
  });

  it('does not inherit another historical generation merely because its package schema parses', () => {
    const s = source();
    Object.assign(profile(s), {
      distributionGeneration: 'dsh-0.1.1-rc.2-b150a55',
    });
    profile(s).runtimePackage!.runtimeManifest.distributionGeneration =
      'dsh-0.1.1-rc.2-b150a55';
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow();
  });

  it('rejects absent packages rather than making a synthetic package from a platform definition', () => {
    const s = source();
    profile(s).runtimePackage = null;
    s.packageChecksum = null;
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'platform_employee_test_runtime_package_missing',
    );
  });

  it('rejects real bundled content relabeled as a schema1 package even with a recomputed outer signature', () => {
    const s = source(newNativeGeneration, 'bundled');
    profile(s).runtimePackage!.schemaVersion = 1;
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'legacy_package_contains_bundle',
    );
  });

  it('rejects a validly re-signed package whose model differs from its frozen source declarations', () => {
    const s = source();
    profile(s).runtimePackage!.runtimeManifest.model = 'substituted-model';
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_EXECUTION_SOURCE_DECLARATION_MISMATCH',
    );
  });

  it('rejects package policy broadening even if its checksum is recomputed', () => {
    const s = source();
    profile(s).runtimePackage!.runtimeManifest.deniedCapabilities = [];
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_EXECUTION_SOURCE_DECLARATION_MISMATCH',
    );
  });

  it('rejects unknown tools agreed upon by profile and definition as well as the re-signed package', () => {
    const s = source(newNativeGeneration, 'empty');
    (s.definition as PlatformEmployeeDefinition).capabilities.toolNames = [
      'fixture.not-a-real-tool',
    ];
    profile(s).toolNames = ['fixture.not-a-real-tool'];
    profile(s).runtimePackage!.runtimeManifest.toolNames = [
      'fixture.not-a-real-tool',
    ];
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_EXECUTION_SOURCE_TOOL_INVALID',
    );
  });

  it('rejects a changed reviewed resource and a re-signed outer package', () => {
    const s = source(newNativeGeneration, 'bundled');
    const resource =
      profile(s).runtimePackage!.skills[0]!.bundle!.resources[0]!;
    resource.contentBase64 = Buffer.from('tampered-data\n').toString('base64');
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow();
  });

  it('rejects governance substitution independent of an intact resource bundle', () => {
    const s = source(newNativeGeneration, 'bundled');
    profile(s).runtimePackage!.runtimeManifest.skillGovernance[0]!.sourceRef =
      'https://example.test/substituted';
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'skill_bundle_governance_mismatch',
    );
  });

  it('checks original definition, package and actual frozen skill bytes separately', () => {
    const original = source();
    const badDefinition = structuredClone(original);
    badDefinition.definitionChecksum = `sha256:${'0'.repeat(64)}`;
    expect(() => validatePlatformTestExecutionSource(badDefinition)).toThrow(
      'CURRENT_PLATFORM_TEST_DEFINITION_CHECKSUM_MISMATCH',
    );
    const badPackage = structuredClone(original);
    badPackage.packageChecksum = `sha256:${'0'.repeat(64)}`;
    expect(() => validatePlatformTestExecutionSource(badPackage)).toThrow(
      'platform_employee_test_package_checksum_mismatch',
    );
    const badSkill = structuredClone(original);
    (badSkill.nativeSkills as { content: string }[])[0]!.content =
      '# Different';
    expect(() => validatePlatformTestExecutionSource(badSkill)).toThrow(
      'platform_employee_test_skill_checksum_mismatch',
    );
  });

  it.each(['missing', 'duplicate'] as const)(
    'rejects %s Skill declarations even when the definition checksum is valid',
    (change) => {
      const s = source(newNativeGeneration, 'plain');
      const d = s.definition as PlatformEmployeeDefinition;
      d.capabilities.nativeSkillIds =
        change === 'missing'
          ? []
          : [
              ...d.capabilities.nativeSkillIds,
              ...d.capabilities.nativeSkillIds,
            ];
      s.definitionChecksum = runtimePackageChecksum(
        PlatformEmployeeDefinitionSchema.parse(d),
      );
      expect(() => validatePlatformTestExecutionSource(s)).toThrow(
        'CURRENT_PLATFORM_TEST_SKILL_DECLARATION_MISMATCH',
      );
    },
  );
  it('rejects a known Skill dependency absent from the original tool declaration', () => {
    const s = source(newNativeGeneration, 'plain');
    (s.definition as PlatformEmployeeDefinition).capabilities.toolNames = [];
    profile(s).toolNames = [];
    profile(s).runtimePackage!.runtimeManifest.toolNames = [];
    resealSource(s);
    expect(() => validatePlatformTestExecutionSource(s)).toThrow(
      'CURRENT_PLATFORM_TEST_SKILL_TOOL_DECLARATION_MISMATCH',
    );
  });
  it('rejects a tenant definition schema and an unsupported purpose', () => {
    const s = source();
    expect(() =>
      validatePlatformTestExecutionSource({
        ...s,
        definition: { ...(s.definition as object), schemaVersion: 2 },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformTestExecutionSource({
        ...s,
        purpose: 'ordinary_chat' as PlatformTestPurpose,
      }),
    ).toThrow();
  });
});

describe('independent test birth and immutable readback', () => {
  it('refuses a birth without the release primary', () => {
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
    expect(() => frozen()).toThrow();
  });
  // MET-221: the birth records the release primary as provenance; the retired
  // new-root ID is neither read nor required.
  it.each([undefined, `sha256:${'b'.repeat(64)}`])(
    'records only the release primary (retired new-root ID %s)',
    (retired) => {
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', retired);
      const input = frozen();
      expect(input.origin).toMatchObject({ artifactId: artifact });
      expect(
        freezePlatformTestExecutionBinding(input).execution.artifactId,
      ).toBe(artifact);
    },
  );
  it('new test IDs use the new approved artifact while the old test keeps its frozen executor', () => {
    const s = source(newNativeGeneration, 'plain', 'method_candidate');
    const old = frozen(s),
      before = freezePlatformTestExecutionBinding(old);
    const nextArtifact = `sha256:${'c'.repeat(64)}`;
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', nextArtifact);
    const next = frozen(s, { ...old.scope, testId: randomUUID() });
    expect(freezePlatformTestExecutionBinding(next).execution.artifactId).toBe(
      nextArtifact,
    );
    expect(assertPlatformTestExecutionBinding(before, old)).toEqual(before);
    expect(before.execution.artifactId).toBe(artifact);
  });
  it.each(['organizationId', 'workspaceId', 'ownerId', 'testId'] as const)(
    'rejects %s substitution even after the attacker recomputes the binding digest',
    (field) => {
      const input = frozen(),
        binding = freezePlatformTestExecutionBinding(input);
      const { digest: ignored, ...payload } = binding;
      void ignored;
      const altered = {
        ...payload,
        scope: { ...binding.scope, [field]: randomUUID() },
      };
      expect(() =>
        assertPlatformTestExecutionBinding(
          { ...altered, digest: nativeRootDigest(altered) },
          input,
        ),
      ).toThrow('CURRENT_PLATFORM_TEST_EXECUTION_BINDING_MISMATCH');
    },
  );
  it.each(['platformEmployeeId', 'platformRevisionId'] as const)(
    'rejects %s replacement against the original persisted origin',
    (field) => {
      const input = frozen();
      expect(() =>
        freezePlatformTestExecutionBinding({
          ...input,
          source: { ...input.source, [field]: randomUUID() },
        }),
      ).toThrow('CURRENT_PLATFORM_TEST_ORIGIN_SOURCE_MISMATCH');
    },
  );
  it('cannot relabel a method test as an experience proof', () => {
    const input = frozen(
      source(newNativeGeneration, 'plain', 'method_candidate'),
    );
    expect(() =>
      freezePlatformTestExecutionBinding({
        ...input,
        source: { ...input.source, purpose: 'experience_validation' },
      }),
    ).toThrow('CURRENT_PLATFORM_TEST_ORIGIN_SOURCE_MISMATCH');
  });
  it('has no fake Run, Session or lease authority in the durable test binding', () => {
    const binding = freezePlatformTestExecutionBinding(frozen());
    expect(Object.keys(binding.scope).sort()).toEqual([
      'organizationId',
      'ownerId',
      'testId',
      'workspaceId',
    ]);
    expect(() =>
      PlatformTestExecutionBindingSchema.parse({
        ...binding,
        scope: { ...binding.scope, runId: randomUUID() },
      }),
    ).toThrow();
    expect(() =>
      PlatformTestExecutionBindingSchema.parse({
        ...binding,
        leaseToken: randomUUID(),
      }),
    ).toThrow();
  });
  it('carries only the execution tuple, never source model/tool declarations as new grants', () => {
    const binding = freezePlatformTestExecutionBinding(frozen());
    expect(Object.keys(binding.execution).sort()).toEqual([
      'artifactId',
      'generation',
      'profileId',
    ]);
    expect(() =>
      PlatformTestExecutionBindingSchema.parse({
        ...binding,
        execution: {
          ...binding.execution,
          model: 'authorized-per-run-model',
          toolNames: [],
        },
      }),
    ).toThrow();
  });
  it('does not mint or fill bindings for historical NULL/v1 roots', () => {
    const input = frozen();
    expect(() =>
      freezePlatformTestExecutionBinding({ ...input, origin: null }),
    ).toThrow();
    expect(() =>
      freezePlatformTestExecutionBinding({
        ...input,
        origin: { ...(input.origin as object), schemaVersion: 1 },
      }),
    ).toThrow();
    expect(() => assertPlatformTestExecutionBinding(null, input)).toThrow();
  });
  it('rejects chat identity, technical profile, rootSeed mismatch and an altered artifact tuple', () => {
    const input = frozen(),
      original = CurrentPlatformTestOriginSchema.parse(input.origin);
    for (const change of [
      { contextKind: 'chat' },
      { profileId: 'technical' },
      { rootSeed: randomUUID() },
    ])
      expect(() =>
        assertCurrentPlatformTestOrigin({ ...original, ...change }, input),
      ).toThrow();
    const b = freezePlatformTestExecutionBinding(input);
    const { digest: ignored, ...payload } = b;
    void ignored;
    const changed = {
      ...payload,
      execution: { ...b.execution, artifactId: `sha256:${'d'.repeat(64)}` },
    };
    expect(() =>
      assertPlatformTestExecutionBinding(
        { ...changed, digest: nativeRootDigest(changed) },
        input,
      ),
    ).toThrow('CURRENT_PLATFORM_TEST_EXECUTION_BINDING_MISMATCH');
  });
});
