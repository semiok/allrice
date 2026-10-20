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
  newInternalNativeRootOrigin,
  retryNativeRootOrigin,
  assertNativeRootOrigin,
  nativeRootDigest,
} from './native-root-origin.ts';
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
it('new candidate package requires independent exact deployment approval', () => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
  expect(() =>
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID()),
  ).toThrow();
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
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
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', undefined);
  expect(
    newInternalNativeRootOrigin('platform_technical', randomUUID(), { v: 1 }),
  ).toBeNull();
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  const id = randomUUID(),
    recipe = { v: 1, instructions: 'fixed' },
    origin = newInternalNativeRootOrigin(
      'experience_consolidation',
      id,
      recipe,
    )!;
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
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  const source = newEmployeeNativeRootOrigin(
    'platform_employee_test',
    randomUUID(),
    packaged(),
  )!;
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
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
it.each(readerConfigurationCases)(
  'blocks a different new birth for reader input %s = %j',
  (key, value) => {
    vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', '');
    vi.stubEnv(key, value);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
    expect(() =>
      newEmployeeNativeRootOrigin(
        'chat',
        randomUUID(),
        packaged(),
        randomUUID(),
      ),
    ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
    expect(() =>
      newInternalNativeRootOrigin('platform_technical', randomUUID(), { v: 1 }),
    ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
  },
);
it('does not treat an entirely empty second group as unconfigured', () => {
  vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH', '');
  for (const key of [
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_PATH',
    'ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256',
    'ALLRICE_DSH_ORIGIN_READER_2_STORAGE_ROOT',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
  expect(() =>
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID()),
  ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
  expect(() =>
    newInternalNativeRootOrigin('platform_technical', randomUUID(), { v: 1 }),
  ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
});
it('requires an exact primary even when only an empty second reader hash is present', () => {
  vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256', '');
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
  expect(() =>
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID()),
  ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
  expect(() =>
    newInternalNativeRootOrigin('platform_technical', randomUUID(), { v: 1 }),
  ).toThrow('DSH_NATIVE_ORIGIN_READER_NEW_BIRTH_MISMATCH');
});
it('preserves legacy-empty birth behavior without any second or unknown reader key', () => {
  for (const key of [
    'ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH',
    'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
    'ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
  expect(
    newEmployeeNativeRootOrigin('chat', randomUUID(), packaged(), randomUUID())
      ?.artifactId,
  ).toBe(artifact);
  expect(
    newInternalNativeRootOrigin('platform_technical', randomUUID(), { v: 1 })
      ?.artifactId,
  ).toBe(artifact);
});
it('keeps birth identity on the independently selected primary rather than any reader metadata', () => {
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact);
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
  expect(newInternalNativeRootOrigin('platform_technical', id, recipe)).toEqual(
    {
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
    },
  );
});
