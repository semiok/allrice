import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DSH_MISSING_FROZEN_GENERATION,
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  localCommandToolchainImageV1,
  PlatformEmployeeDefinitionSchema,
  SessionModelSnapshotSchema,
  withEmployeeCustomizationTools,
  type EmployeeDefinition,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../employees/employee-config.ts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
} from '../platform-employees/runtime-package.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';
import {
  assertCurrentEmployeeChatOrigin,
  assertEmployeeRunExecutionBinding,
  CurrentEmployeeChatOriginSchema,
  EmployeeRunExecutionBindingSchema,
  freezeEmployeeRunExecutionBinding,
  nativeRootDigest,
  newCurrentEmployeeChatOrigin,
  newNativeGeneration,
  validateEmployeeExecutionSource,
  type EmployeeExecutionSourceInput,
  type EmployeeRunExecutionBindingInput,
} from './current-execution-binding.ts';

const artifact = `sha256:${'a'.repeat(64)}`;
const timestamp = '2026-10-01T00:00:00.000Z';
beforeEach(() => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
});
afterEach(() => vi.unstubAllEnvs());
function definitionOnly(): EmployeeExecutionSourceInput {
  const manifest = employeeManifest({
    key: 'current-binding-fixture',
    name: 'Synthetic binding',
    description: 'Deterministic test fixture only',
    toolNames: ['workspace.skill.read'],
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'synthetic',
      reasoningEffort: 'high',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic',
      baseUrl: null,
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      connectorIdentityModes: [],
      approvalPolicy: 'confirm_side_effects',
      deniedCapabilities: [],
    },
  });
  return {
    employeeVersionId: randomUUID(),
    configChecksum: employeeManifestChecksum(manifest),
    manifest,
  };
}
function reseal(pkg: EmployeeRuntimePackage) {
  // Match the immutable publisher's original field order, including files.
  // A parsed/JSONB object's enumeration order is not its signed payload.
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
  return pkg;
}
function fingerprint(pkg: EmployeeRuntimePackage) {
  const p = pkg.runtimeManifest;
  pkg.capabilityFingerprint = runtimePackageChecksum({
    distributionGeneration: p.distributionGeneration,
    provider: p.provider,
    model: p.model,
    tools: [...p.toolNames].sort(),
    skills: pkg.skills.map((skill) => ({
      name: skill.name,
      checksum: skill.checksum,
      requiredToolRefs: [...skill.requiredToolRefs].sort(),
      ...(skill.bundle ? { bundleChecksum: skill.bundle.checksum } : {}),
    })),
    deniedCapabilities: [...p.deniedCapabilities].sort(),
  });
  return reseal(pkg);
}
function packaged(
  generation: string = newNativeGeneration,
): EmployeeExecutionSourceInput {
  const input = definitionOnly();
  const manifest = EmployeeDefinitionSchema.parse(input.manifest);
  const content = '# Synthetic task\nRead the reviewed resource.\n';
  const bytes = Buffer.from('synthetic-only\n');
  const bundlePayload = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    contentChecksum: skillBytesChecksum(content),
    sourceRef: 'https://example.test/reviewed-source',
    license: 'Apache-2.0',
    reviewedBy: 'fixture-reviewer',
    resources: [
      {
        path: 'references/rules.txt',
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
  const { harness: unusedHarness, ...modelPolicy } = manifest.runtimePolicy;
  void unusedHarness;
  const definition = PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: manifest.key,
    name: manifest.name,
    description: manifest.description,
    appearance: manifest.appearance,
    identity: {
      ...manifest.identity,
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: manifest.systemPrompt,
    modelPolicy,
    capabilities: {
      nativeSkillIds: [],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: manifest.capabilityBindings.toolNames,
      connectorRefs: [],
    },
    securityPolicy: { ...manifest.securityPolicy, bridgeAccess: 'none' },
  });
  const pkg = buildEmployeeRuntimePackage({
    revision: 1,
    definition,
    skills: [
      {
        id: randomUUID(),
        name: 'synthetic-reference',
        description: 'Synthetic resource fixture',
        content,
        checksum: skillBytesChecksum(content),
        model_invocable: true,
        user_invocable: true,
        required_tool_refs: ['workspace.skill.read'],
        source: 'allrice',
        source_ref: bundlePayload.sourceRef,
        version: bundlePayload.version,
        license: bundlePayload.license,
        review_status: 'reviewed',
        reviewed_by_label: bundlePayload.reviewedBy,
        reviewed_at: new Date(timestamp),
        bundle: {
          ...bundlePayload,
          checksum: skillBundleChecksum(bundlePayload),
        },
      },
    ],
  });
  pkg.runtimeManifest.distributionGeneration = generation;
  fingerprint(pkg);
  manifest.runtimePackage = pkg;
  return { ...input, manifest, configChecksum: pkg.checksum };
}
function manifestOf(source: EmployeeExecutionSourceInput): EmployeeDefinition {
  return source.manifest as EmployeeDefinition;
}
function packageOf(
  source: EmployeeExecutionSourceInput,
): EmployeeRuntimePackage {
  return manifestOf(source).runtimePackage!;
}
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, jsonbOrder(v)]),
    );
  return value;
}
function chat(source = definitionOnly()) {
  const input = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: randomUUID(),
    source,
  };
  return { input, origin: newCurrentEmployeeChatOrigin(input) };
}
function run(
  source = definitionOnly(),
  existing = chat(source),
): EmployeeRunExecutionBindingInput {
  const manifest = EmployeeDefinitionSchema.parse(source.manifest);
  const scope = {
    organizationId: existing.input.organizationId,
    workspaceId: existing.input.workspaceId,
    ownerId: existing.input.ownerId,
    sessionId: existing.input.sessionId,
    runId: randomUUID(),
  };
  const executionSnapshot = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 2,
    employee: {
      id: randomUUID(),
      key: manifest.key,
      versionId: source.employeeVersionId,
      revision: 1,
      definitionChecksum: source.configChecksum,
      definition: manifest,
    },
    assignment: {
      id: randomUUID(),
      userId: scope.ownerId,
      assignedBy: null,
      assignedAt: timestamp,
    },
    runtimePolicy: manifest.runtimePolicy,
    capabilitySnapshot: {
      declaredCapabilities: manifest.capabilities,
      grantedCapabilities: manifest.capabilities.filter(
        (item) => !manifest.securityPolicy.deniedCapabilities.includes(item),
      ),
      bindings: manifest.capabilityBindings,
      skillBindings: [],
      agentSkills: [],
      workflows: [],
      knowledge: [],
      resolvedForActorId: scope.ownerId,
    },
    tenantContext: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      actorId: scope.ownerId,
      policySnapshotId: randomUUID(),
    },
    userProfile: { schemaVersion: 1, displayName: null, preferences: {} },
    createdAt: timestamp,
  });
  return { origin: existing.origin, scope, source, executionSnapshot };
}

describe('current employee source policy: immutable original identities', () => {
  it.each([null, DSH_MISSING_FROZEN_GENERATION, newNativeGeneration])(
    'validates original source %s without rewriting it or fabricating a package',
    (generation) => {
      const input =
        generation === null ? definitionOnly() : packaged(generation);
      const before = structuredClone(input);
      const { source, sourcePolicy } = validateEmployeeExecutionSource(input);
      expect(input).toEqual(before);
      expect(source).toMatchObject({
        employeeVersionId: input.employeeVersionId,
        configChecksum: input.configChecksum,
        manifestDigest: nativeRootDigest(input.manifest),
        declaredGeneration: generation,
        packageSchema: generation === null ? null : 2,
        packageChecksum: generation === null ? null : input.configChecksum,
      });
      expect(sourcePolicy.variant).toBe(
        generation === null
          ? 'definition_only'
          : generation === newNativeGeneration
            ? 'current_published_package_v2'
            : 'legacy_published_package_v2',
      );
      expect(chat(input).origin.artifactId).toBe(artifact);
      expect(chat(input).origin.distributionGeneration).toBe(
        newNativeGeneration,
      );
    },
  );
  it.each([false, true])(
    'keeps config/package checksums valid after JSONB object key reorder (packaged %s)',
    (hasPackage) => {
      const input = hasPackage
        ? packaged(DSH_MISSING_FROZEN_GENERATION)
        : definitionOnly();
      expect(
        validateEmployeeExecutionSource({
          ...input,
          manifest: jsonbOrder(input.manifest),
        }),
      ).toEqual(validateEmployeeExecutionSource(input));
    },
  );
  it('distinguishes canonical raw missing package from explicit null without creating content', () => {
    const input = definitionOnly(),
      raw = { ...manifestOf(input) };
    delete (raw as Partial<EmployeeDefinition>).runtimePackage;
    const left = validateEmployeeExecutionSource(input),
      right = validateEmployeeExecutionSource({ ...input, manifest: raw });
    expect(left.sourcePolicy).toEqual(right.sourcePolicy);
    expect(left.source.manifestDigest).not.toBe(right.source.manifestDigest);
    expect(right.source.packageChecksum).toBeNull();
    expect(right.source.configChecksum).toBe(input.configChecksum);
  });
  it('does not accept a forged config hash or silently discard unknown source keys', () => {
    const input = definitionOnly();
    expect(() =>
      validateEmployeeExecutionSource({ ...input, configChecksum: artifact }),
    ).toThrow('CHECKSUM_MISMATCH');
    expect(() =>
      validateEmployeeExecutionSource({
        ...input,
        manifest: { ...manifestOf(input), executable: '/host/path' },
      }),
    ).toThrow();
    expect(() =>
      validateEmployeeExecutionSource({
        ...input,
        manifest: { ...manifestOf(input), schemaVersion: 1 },
      }),
    ).toThrow();
  });
  it('rejects schema1 packages and unreviewed generations even when validly rehashed', () => {
    const source = packaged();
    packageOf(source).schemaVersion = 1;
    source.configChecksum = reseal(packageOf(source)).checksum;
    expect(() => validateEmployeeExecutionSource(source)).toThrow(
      'PACKAGE_SCHEMA_UNSUPPORTED',
    );
    expect(() =>
      validateEmployeeExecutionSource(packaged('dsh-unreviewed')),
    ).toThrow('GENERATION_UNSUPPORTED');
  });
  it('requires the original package hash, declaration and capability fingerprint to agree', () => {
    const hash = packaged();
    manifestOf(hash).runtimePackage!.checksum = artifact;
    hash.configChecksum = artifact;
    expect(() => validateEmployeeExecutionSource(hash)).toThrow(
      'CHECKSUM_MISMATCH',
    );
    const declaration = packaged();
    manifestOf(declaration).capabilityBindings.toolNames = [];
    expect(() => validateEmployeeExecutionSource(declaration)).toThrow(
      'DECLARATION_MISMATCH',
    );
    const capability = packaged();
    packageOf(capability).capabilityFingerprint = artifact;
    capability.configChecksum = reseal(packageOf(capability)).checksum;
    expect(() => validateEmployeeExecutionSource(capability)).toThrow(
      'CAPABILITY_FINGERPRINT_MISMATCH',
    );
  });
  it.each([
    'unknown-tool',
    'bad-resource',
    'bad-runtime',
    'bad-governance',
    'bad-path',
  ] as const)('rejects %s even with a resigned outer package', (change) => {
    const input = packaged(),
      pkg = packageOf(input),
      skill = pkg.skills[0]!,
      bundle = skill.bundle!;
    if (change === 'unknown-tool')
      skill.requiredToolRefs = ['workspace.not-a-real-tool'];
    if (change === 'bad-resource')
      bundle.resources[0]!.contentBase64 =
        Buffer.from('changed').toString('base64');
    if (change === 'bad-runtime')
      bundle.dependencies = [
        {
          kind: 'runtime',
          name: 'node',
          version: '22.23.2',
          imageDigest: artifact,
        },
      ];
    if (change === 'bad-governance')
      pkg.runtimeManifest.skillGovernance[0]!.name = 'other-name';
    if (change === 'bad-path')
      bundle.resources[0]!.path = 'references/../private';
    const { checksum: unused, ...payload } = bundle;
    void unused;
    bundle.checksum = skillBundleChecksum(payload);
    input.configChecksum = fingerprint(pkg).checksum;
    expect(() => validateEmployeeExecutionSource(input)).toThrow();
  });
  it('rejects duplicate skill/governance identities instead of picking the first match', () => {
    const input = packaged(),
      pkg = packageOf(input);
    pkg.runtimeManifest.skillGovernance.push(
      structuredClone(pkg.runtimeManifest.skillGovernance[0]!),
    );
    input.configChecksum = reseal(pkg).checksum;
    expect(() => validateEmployeeExecutionSource(input)).toThrow(
      'GOVERNANCE_INVALID',
    );
  });
});

describe('current employee v2 birth and per-Run binding', () => {
  it.each(['new-missing', 'primary-missing', 'mismatch'] as const)(
    'requires explicit current approval: %s',
    (change) => {
      if (change === 'new-missing')
        vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
      if (change === 'primary-missing')
        vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
      if (change === 'mismatch')
        vi.stubEnv(
          'ALLRICE_DSH_NATIVE_ARTIFACT_ID',
          `sha256:${'b'.repeat(64)}`,
        );
      expect(() => chat()).toThrow();
    },
  );
  it('keeps a birth source immutable and validates original scope and provenance', () => {
    const { input, origin } = chat(packaged(DSH_MISSING_FROZEN_GENERATION));
    expect(assertCurrentEmployeeChatOrigin(jsonbOrder(origin), input)).toEqual(
      origin,
    );
    expect(() =>
      assertCurrentEmployeeChatOrigin(origin, {
        ...input,
        ownerId: randomUUID(),
      }),
    ).toThrow('SOURCE_MISMATCH');
    expect(() =>
      assertCurrentEmployeeChatOrigin(origin, {
        ...input,
        source: { ...input.source, employeeVersionId: randomUUID() },
      }),
    ).toThrow('SOURCE_MISMATCH');
    expect(() =>
      CurrentEmployeeChatOriginSchema.parse({
        ...origin,
        frozenIdentity: { kind: 'employee_package', checksum: artifact },
      }),
    ).toThrow();
    expect(() =>
      CurrentEmployeeChatOriginSchema.parse({
        ...origin,
        sourcePolicy: { ...origin.sourcePolicy, digest: artifact },
      }),
    ).toThrow();
    expect(() =>
      CurrentEmployeeChatOriginSchema.parse({
        ...origin,
        birthSource: { ...origin.birthSource, configChecksum: artifact },
      }),
    ).toThrow('CHECKSUM_MISMATCH');
  });
  it('allows all three reviewed source variants on later Runs without changing the birth tuple/source', () => {
    const birth = chat(packaged(DSH_MISSING_FROZEN_GENERATION)),
      original = structuredClone(birth.origin);
    for (const source of [
      definitionOnly(),
      packaged(),
      packaged(DSH_MISSING_FROZEN_GENERATION),
    ]) {
      const input = run(source, birth),
        binding = freezeEmployeeRunExecutionBinding(input);
      expect(binding.source.employeeVersionId).toBe(source.employeeVersionId);
      expect(binding.execution.artifactId).toBe(original.artifactId);
      expect(binding.originDigest).toBe(nativeRootDigest(original));
      expect(binding.sourcePolicy.family).toBe(original.sourcePolicy.family);
      expect(
        assertEmployeeRunExecutionBinding(jsonbOrder(binding), input),
      ).toEqual(binding);
    }
    expect(birth.origin).toEqual(original);
  });
  it('binds actual Run scope and snapshot but keeps policy/execution reusable across Runs', () => {
    const input = run(),
      first = freezeEmployeeRunExecutionBinding(input);
    const second = freezeEmployeeRunExecutionBinding({
      ...input,
      scope: { ...input.scope, runId: randomUUID() },
    });
    expect(first.digest).not.toBe(second.digest);
    expect(first.sourcePolicy).toEqual(second.sourcePolicy);
    expect(first.execution).toEqual(second.execution);
    expect(first.source).toEqual(second.source);
    expect(() =>
      assertEmployeeRunExecutionBinding(first, {
        ...input,
        scope: second.scope,
      }),
    ).toThrow('BINDING_MISMATCH');
  });
  it('preserves an independently frozen model selection without rewriting the original source model', () => {
    const input = run(packaged(DSH_MISSING_FROZEN_GENERATION));
    const original = freezeEmployeeRunExecutionBinding(input);
    const snapshot = EmployeeExecutionSnapshotSchema.parse(
      input.executionSnapshot,
    );
    const modelSnapshot = SessionModelSnapshotSchema.parse({
      schemaVersion: 1,
      sessionId: input.scope.sessionId,
      employeeId: snapshot.employee.id,
      policyRevision: 2,
      connectionId: randomUUID(),
      modelCatalogEntryId: randomUUID(),
      harness: 'dsh',
      provider: 'openai-compatible',
      authMode: 'api_key',
      model: 'synthetic-selected-model',
      reasoningEffort: 'low',
      credentialReference: 'deployment:synthetic-selection',
      baseUrl: 'https://example.test/model',
      fallbackPolicy: 'disabled',
      fallbackTargets: [],
      frozenAt: timestamp,
    });
    const updated = {
      ...input,
      executionSnapshot: {
        ...snapshot,
        runtimePolicy: {
          ...snapshot.runtimePolicy,
          provider: modelSnapshot.provider,
          model: modelSnapshot.model,
          reasoningEffort: modelSnapshot.reasoningEffort,
          credentialReference: modelSnapshot.credentialReference,
          baseUrl: modelSnapshot.baseUrl,
        },
        modelSnapshot,
      },
    };
    const frozen = freezeEmployeeRunExecutionBinding(updated);
    expect(frozen.source).toEqual(original.source);
    expect(frozen.execution).toEqual(original.execution);
    expect(frozen.executionSnapshotDigest).not.toBe(
      original.executionSnapshotDigest,
    );
    expect(assertEmployeeRunExecutionBinding(frozen, updated)).toEqual(frozen);
    expect(packageOf(input.source).runtimeManifest.model).toBe('synthetic');
    expect(() => assertEmployeeRunExecutionBinding(original, updated)).toThrow(
      'BINDING_MISMATCH',
    );
  });
  it('preserves narrowed grants and server-frozen intrinsic tools and personal skill pins', () => {
    const input = run();
    const original = freezeEmployeeRunExecutionBinding(input);
    const snapshot = EmployeeExecutionSnapshotSchema.parse(
      input.executionSnapshot,
    );
    const grantedCapabilities = [
      'model:invoke',
      'storage:read',
      'storage:write',
    ] as const;
    const instanceId = randomUUID();
    const personalIndex = {
      schemaVersion: 1,
      instanceId,
      skills: [
        {
          organizationId: input.scope.organizationId,
          ownerId: input.scope.ownerId,
          instanceId,
          installationId: randomUUID(),
          versionId: randomUUID(),
          bindingId: randomUUID(),
          bindingEpoch: 1,
          definitionChecksum: nativeRootDigest({ synthetic: 'personal-skill' }),
        },
      ],
    };
    const toolNames = withEmployeeCustomizationTools(
      snapshot.capabilitySnapshot.bindings.toolNames,
      grantedCapabilities,
      'custom',
    );
    expect(toolNames).toContain('workspace.employee.method.inspect');
    const updated = {
      ...input,
      executionSnapshot: {
        ...snapshot,
        personalSkills: {
          ...personalIndex,
          checksum: nativeRootDigest(personalIndex),
        },
        capabilitySnapshot: {
          ...snapshot.capabilitySnapshot,
          grantedCapabilities: [...grantedCapabilities],
          bindings: { ...snapshot.capabilitySnapshot.bindings, toolNames },
        },
      },
    };
    const frozen = freezeEmployeeRunExecutionBinding(updated);
    expect(frozen.source).toEqual(original.source);
    expect(frozen.sourcePolicy).toEqual(original.sourcePolicy);
    expect(frozen.executionSnapshotDigest).not.toBe(
      original.executionSnapshotDigest,
    );
    expect(assertEmployeeRunExecutionBinding(frozen, updated)).toEqual(frozen);
    expect(() => assertEmployeeRunExecutionBinding(original, updated)).toThrow(
      'BINDING_MISMATCH',
    );
  });
  it.each(['organizationId', 'workspaceId', 'ownerId', 'sessionId'] as const)(
    'rejects foreign %s before returning a binding',
    (key) => {
      const input = run();
      expect(() =>
        freezeEmployeeRunExecutionBinding({
          ...input,
          scope: { ...input.scope, [key]: randomUUID() },
        }),
      ).toThrow('SCOPE_MISMATCH');
    },
  );
  it.each(['source', 'tuple', 'policy', 'snapshot', 'scope'] as const)(
    'rejects tampered %s even after recomputing the outer digest',
    (key) => {
      const input = run(),
        binding = freezeEmployeeRunExecutionBinding(input);
      if (key === 'source') binding.source.employeeVersionId = randomUUID();
      if (key === 'tuple')
        binding.execution.artifactId = `sha256:${'b'.repeat(64)}`;
      if (key === 'policy') binding.sourcePolicy.digest = artifact;
      if (key === 'snapshot') binding.executionSnapshotDigest = artifact;
      if (key === 'scope') binding.scope.runId = randomUUID();
      const { digest: unused, ...payload } = binding;
      void unused;
      binding.digest = nativeRootDigest(payload);
      expect(() => assertEmployeeRunExecutionBinding(binding, input)).toThrow();
    },
  );
  it('refuses missing bindings and NULL/v1 origins rather than inventing current ownership', () => {
    const input = run();
    expect(() => assertEmployeeRunExecutionBinding(null, input)).toThrow();
    expect(() =>
      freezeEmployeeRunExecutionBinding({ ...input, origin: null }),
    ).toThrow();
    expect(() =>
      freezeEmployeeRunExecutionBinding({
        ...input,
        origin: { ...(input.origin as object), schemaVersion: 1 },
      }),
    ).toThrow();
    expect(() => EmployeeRunExecutionBindingSchema.parse({})).toThrow();
  });
  it('rejects a changed frozen definition, foreign actor, or augmented grants', () => {
    const input = run();
    const original = EmployeeExecutionSnapshotSchema.parse(
      input.executionSnapshot,
    );
    expect(() =>
      freezeEmployeeRunExecutionBinding({
        ...input,
        executionSnapshot: {
          ...original,
          employee: { ...original.employee, definitionChecksum: artifact },
        },
      }),
    ).toThrow('SNAPSHOT_SOURCE_MISMATCH');
    expect(() =>
      freezeEmployeeRunExecutionBinding({
        ...input,
        executionSnapshot: {
          ...original,
          tenantContext: { ...original.tenantContext, actorId: randomUUID() },
        },
      }),
    ).toThrow('SCOPE_MISMATCH');
    const source = definitionOnly();
    manifestOf(source).securityPolicy.deniedCapabilities = ['secret:use'];
    source.configChecksum = employeeManifestChecksum(manifestOf(source));
    const denied = run(source),
      snap = EmployeeExecutionSnapshotSchema.parse(denied.executionSnapshot);
    expect(() =>
      freezeEmployeeRunExecutionBinding({
        ...denied,
        executionSnapshot: {
          ...snap,
          capabilitySnapshot: {
            ...snap.capabilitySnapshot,
            grantedCapabilities: ['secret:use'],
          },
        },
      }),
    ).toThrow('CAPABILITIES_MISMATCH');
  });
  it('does not silently retarget a persisted origin when deployment approval changes', () => {
    const input = run(),
      binding = freezeEmployeeRunExecutionBinding(input);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', `sha256:${'b'.repeat(64)}`);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', `sha256:${'b'.repeat(64)}`);
    expect(
      assertEmployeeRunExecutionBinding(binding, input).execution.artifactId,
    ).toBe(artifact);
  });
});
