import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
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
