import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeDefinitionSchema,
  DSH_MISSING_FROZEN_GENERATION,
} from '@allrice/contracts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
} from '../platform-employees/runtime-package.ts';
import {
  newEmployeeNativeRootOrigin,
  newCurrentEmployeeChatOrigin,
  newCurrentInternalNativeRootOrigin,
  retryNativeRootOrigin,
  assertNativeRootOrigin,
  nativeRootDigest,
  NativeRootOriginSchema,
  NativeRootOriginV1Schema,
} from './native-root-origin.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from '../employees/employee-config.ts';
const artifact = 'sha256:' + 'a'.repeat(64);
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
      vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
function packaged() {
  const definition = PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'origin-test',
    name: 'Origin test',
    description: 'Synthetic only',
    appearance: { avatarType: 'initials', avatarValue: 'O' },
    identity: {
      role: 'Tester',
      mission: 'Test',
      workStyle: 'Deterministic',
      behaviorRules: [],
      safetyBoundaries: [],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Synthetic only',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'synthetic',
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
      toolNames: [],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: [],
    },
  });
  return buildEmployeeRuntimePackage({ revision: 1, definition, skills: [] });
}
// MET-221: a new birth records this release's primary as provenance. The
// retired new-root ID is neither read nor required.
it('new candidate package records the release primary, not the retired new-root ID', () => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
  expect(() =>
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID()),
  ).toThrow();
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
  const id = randomUUID(),
    p = packaged(),
    origin = newEmployeeNativeRootOrigin('chat', id, p, randomUUID())!;
  expect(origin).toMatchObject({
    contextId: id,
    rootSeed: id,
    artifactId: artifact,
    frozenIdentity: { kind: 'employee_package', checksum: p.checksum },
  });
});
it('new business identity with an old frozen package remains legacy even after candidate approval', () => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  const p = packaged();
  p.runtimeManifest.distributionGeneration = DSH_MISSING_FROZEN_GENERATION;
  const { checksum, ...value } = p;
  void checksum;
  p.checksum = runtimePackageChecksum(value);
  expect(newEmployeeNativeRootOrigin('chat', randomUUID(), p)).toBeNull();
});
it('internal recipe authority freezes exact recipe, business seed and profile', () => {
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
  expect(() =>
    newCurrentInternalNativeRootOrigin('platform_technical', randomUUID(), {
      v: 1,
    }),
  ).toThrow();
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
  const id = randomUUID(),
    recipe = { v: 1, instructions: 'fixed' },
    origin = newCurrentInternalNativeRootOrigin(
      'experience_consolidation',
      id,
      recipe,
    );
  expect(origin.rootSeed).toBe('experience-' + id);
  expect(
    assertNativeRootOrigin(origin, 'experience_consolidation', id, {
      kind: 'internal_recipe',
      checksum: nativeRootDigest(recipe),
    }),
  ).toEqual(origin);
  expect(() =>
    assertNativeRootOrigin(origin, 'experience_consolidation', id, {
      kind: 'internal_recipe',
      checksum: nativeRootDigest({ v: 2 }),
    }),
  ).toThrow();
});
it('explicit retry inherits original engine/artifact including NULL, never the new deployment choice', () => {
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
  const source = newEmployeeNativeRootOrigin(
    'platform_employee_test',
    randomUUID(),
    packaged(),
  )!;
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
  const id = randomUUID(),
    retry = retryNativeRootOrigin(source, id)!;
  expect(retry).toEqual({ ...source, contextId: id, rootSeed: id });
  expect(retryNativeRootOrigin(null, id)).toBeNull();
  expect(() =>
    assertNativeRootOrigin(
      { ...retry, profileId: 'technical' },
      'platform_employee_test',
      id,
      retry.frozenIdentity,
    ),
  ).toThrow();
  expect(() =>
    assertNativeRootOrigin(
      retry,
      'platform_employee_test',
      randomUUID(),
      retry.frozenIdentity,
    ),
  ).toThrow();
});

const readerConfigurationCases = [
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', 'synthetic-present-reader-input'],
  [
    'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
    'synthetic-present-reader-input',
  ],
  ['ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT', 'synthetic-present-reader-input'],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', '  '],
  ['ALLRICE_DSH_ORIGIN_READER_3_APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_8_APPROVAL_PATH', ''],
  [
    'ALLRICE_DSH_ORIGIN_READER_8_STORAGE_ROOT',
    'synthetic-present-reader-input',
  ],
  ['ALLRICE_DSH_ORIGIN_READER_9_APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_2_ALLOW_EXISTING_WRITER', ''],
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH_2', ''],
  ['ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256_2', '  '],
  [
    'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT_2',
    'synthetic-present-reader-input',
  ],
  ['ALLRICE_DSH_ORIGIN_READER_2APPROVAL_PATH', ''],
  ['ALLRICE_DSH_ORIGIN_READER_02_APPROVAL_PATH', ''],
  [
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
    'synthetic-present-reader-input',
  ],
] as const;
// MET-221 retired origin readers: the Worker refuses to start with a non-empty
// reader setting, and a birth neither reads nor is blocked by any of them.
it('ignores retired origin-reader settings at birth and records the release primary', () => {
  const primary = 'sha256:' + 'b'.repeat(64);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', primary);
  for (const [key, value] of readerConfigurationCases) {
    vi.stubEnv(key, value);
    expect(
      newEmployeeNativeRootOrigin(
        'chat',
        randomUUID(),
        packaged(),
        randomUUID(),
      )?.artifactId,
    ).toBe(primary);
    expect(
      newCurrentInternalNativeRootOrigin('platform_technical', randomUUID(), {
        v: 1,
      }).artifactId,
    ).toBe(primary);
  }
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
  expect(() =>
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID()),
  ).toThrow();
});
it('keeps birth identity on the independently selected primary rather than any reader metadata', () => {
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
  // This pure birth guard never reads or approves policy files. Their separate
  // strict-loader tests remain responsible for file/group validity.
  vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', '/reviewed/first.json');
  vi.stubEnv(
    'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
    'sha256:' + 'b'.repeat(64),
  );
  vi.stubEnv(
    'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT',
    '/reviewed/first-storage',
  );
  vi.stubEnv(
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
    '/reviewed/second.json',
  );
  vi.stubEnv(
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256',
    'sha256:' + 'c'.repeat(64),
  );
  vi.stubEnv(
    'ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT',
    '/reviewed/second-storage',
  );
  const id = randomUUID(),
    recipe = { v: 1 };
  expect(
    newCurrentInternalNativeRootOrigin('platform_technical', id, recipe),
  ).toEqual({
    schemaVersion: 1,
    contextKind: 'platform_technical',
    contextId: id,
    rootSeed: id,
    distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
    profileId: 'technical',
    artifactId: artifact,
    frozenIdentity: {
      kind: 'internal_recipe',
      checksum: nativeRootDigest(recipe),
    },
  });
});

it('preserves the canonical v1 checksum after sharing the digest implementation', () => {
  expect(nativeRootDigest({ v: 1 })).toBe(
    'sha256:afbf9d0f3560b0fd7795e81c42a0a79ee6b6fc67e064f77826aee642cad28d91',
  );
  expect(nativeRootDigest({ z: [{ b: 2, a: 1 }, 3], a: { y: 2, x: 1 } })).toBe(
    'sha256:31d31e2c0df5312f5d7aa953f212921b2f11dbb87b27b2aa2e1cf324d0e5dd36',
  );
  expect(
    nativeRootDigest({ z: [3, { a: 1, b: 2 }], a: { x: 1, y: 2 } }),
  ).not.toBe(
    'sha256:31d31e2c0df5312f5d7aa953f212921b2f11dbb87b27b2aa2e1cf324d0e5dd36',
  );
});

it('recognizes current v2 birth explicitly while keeping every legacy API v1-only', () => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact);
  const manifest = employeeManifest({
    key: 'current-origin-test',
    name: 'Current origin',
    description: 'Synthetic only',
    toolNames: [],
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'synthetic',
      reasoningEffort: 'high',
      timeoutMs: 300_000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic',
      baseUrl: null,
    },
  });
  const id = randomUUID();
  const current = newCurrentEmployeeChatOrigin({
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: id,
    source: {
      employeeVersionId: randomUUID(),
      configChecksum: employeeManifestChecksum(manifest),
      manifest,
    },
  });
  expect(NativeRootOriginSchema.parse(current)).toEqual(current);
  expect(current).not.toHaveProperty('frozenIdentity');
  expect(() => NativeRootOriginV1Schema.parse(current)).toThrow();
  expect(() =>
    assertNativeRootOrigin(current, 'chat', id, {
      kind: 'employee_package',
      checksum: artifact,
      sourceId: randomUUID(),
    }),
  ).toThrow();
  expect(() => retryNativeRootOrigin(current, randomUUID())).toThrow();
  expect(() =>
    NativeRootOriginSchema.parse({
      ...current,
      contextKind: 'platform_technical',
    }),
  ).toThrow();
  expect(() =>
    NativeRootOriginSchema.parse({ ...current, schemaVersion: 1 }),
  ).toThrow();
  expect(newEmployeeNativeRootOrigin('chat', id, null)).toBeNull();
  expect(
    assertNativeRootOrigin(null, 'chat', id, {
      kind: 'employee_package',
      checksum: artifact,
      sourceId: randomUUID(),
    }),
  ).toBeNull();

  const legacy = newEmployeeNativeRootOrigin(
    'chat',
    id,
    packaged(),
    randomUUID(),
  )!;
  expect(NativeRootOriginSchema.parse(legacy)).toEqual(legacy);
  expect(NativeRootOriginV1Schema.parse(legacy)).toEqual(legacy);
  expect(() =>
    NativeRootOriginSchema.parse({
      ...legacy,
      birthSource: current.birthSource,
    }),
  ).toThrow();
});
