import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import {
  runtimePackageChecksum,
  validatePlatformEmployeeTestExecutionSnapshot,
} from '../platform-employees/runtime-package.ts';
import {
  CurrentEmployeeExecutionTupleSchema,
  nativeRootDigest,
  newNativeGeneration,
  readApprovedCurrentEmployeeExecution,
  validateCurrentDeclarativeRuntimePackage,
} from './current-execution-binding.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const same = (a: unknown, b: unknown) =>
  nativeRootDigest(a) === nativeRootDigest(b);
function need(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
export const platformTestSourceFamily =
  'allrice_declarative_platform_test_v1' as const;
export const PlatformTestPurposeSchema = z.enum([
  'platform_preview',
  'method_candidate',
  'experience_validation',
]);
export type PlatformTestPurpose = z.infer<typeof PlatformTestPurposeSchema>;
const ownerScope = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
  })
  .strict();
const testScope = ownerScope.extend({ testId: UuidSchema }).strict();
export type PlatformTestExecutionScope = z.infer<typeof testScope>;

export const PlatformTestExecutionSourceSchema = z
  .object({
    kind: z.literal('platform_test_snapshot'),
    platformEmployeeId: UuidSchema,
    platformRevisionId: UuidSchema,
    purpose: PlatformTestPurposeSchema,
    definitionSchema: z.literal(1),
    definitionChecksum: digest,
    definitionDigest: digest,
    runtimeProfileDigest: digest,
    nativeSkillsDigest: digest,
    capabilitySnapshotDigest: digest,
    packageSchema: z.union([z.literal(1), z.literal(2)]),
    packageChecksum: digest,
    declaredGeneration: z.literal(newNativeGeneration),
  })
  .strict();
export type PlatformTestExecutionSource = z.infer<
  typeof PlatformTestExecutionSourceSchema
>;

const variant = z.enum([
  'current_platform_package_v1',
  'current_platform_package_v2',
]);
type Variant = z.infer<typeof variant>;
function variantFor(source: PlatformTestExecutionSource): Variant {
  return source.packageSchema === 1
    ? 'current_platform_package_v1'
    : 'current_platform_package_v2';
}
function policyDigest(value: Variant) {
  return nativeRootDigest({
    family: platformTestSourceFamily,
    variant: value,
    definitionSchema: 1,
    packageSchema: value.endsWith('_v1') ? 1 : 2,
    declaredGeneration: newNativeGeneration,
    executionGeneration: newNativeGeneration,
    profileId: 'restricted',
    validation:
      'original-platform-snapshot-known-tools-reviewed-frozen-bundles-v1',
  });
}
export const PlatformTestExecutionPolicySchema = z
  .object({
    family: z.literal(platformTestSourceFamily),
    variant,
    digest,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.digest !== policyDigest(policy.variant))
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_PLATFORM_TEST_POLICY_INVALID',
      });
  });
export type PlatformTestExecutionPolicy = z.infer<
  typeof PlatformTestExecutionPolicySchema
>;
function policyFor(
  source: PlatformTestExecutionSource,
): PlatformTestExecutionPolicy {
  const selected = variantFor(source);
  return {
    family: platformTestSourceFamily,
    variant: selected,
    digest: policyDigest(selected),
  };
}

/** Original platform revision/test bytes only. Actual model snapshots, method
 * tools and personal Skill overlays stay in their existing authority bindings.
 * The trusted issuer supplies the real revision's definition checksum; this is
 * not a tenant configChecksum and is not the runtime-package checksum. */
export type PlatformTestExecutionSourceInput = {
  platformEmployeeId: string;
  platformRevisionId: string;
  purpose: PlatformTestPurpose;
  definitionChecksum: string;
  definition: unknown;
  runtimeProfile: unknown;
  nativeSkills: unknown;
  packageChecksum: string | null;
};
export function validatePlatformTestExecutionSource(
  input: PlatformTestExecutionSourceInput,
) {
  const definitionChecksum = digest.parse(input.definitionChecksum);
  const platformEmployeeId = UuidSchema.parse(input.platformEmployeeId);
  const platformRevisionId = UuidSchema.parse(input.platformRevisionId);
  const purpose = PlatformTestPurposeSchema.parse(input.purpose);
  const frozen = validatePlatformEmployeeTestExecutionSnapshot(input);
  const { runtimeProfile, definition, nativeSkills } = frozen;
  // The parser restores the publisher's schema field order after JSONB. Do not
  // replace the publisher's checksum algorithm with a new canonical hash.
  need(
    runtimePackageChecksum(definition) === definitionChecksum,
    'CURRENT_PLATFORM_TEST_DEFINITION_CHECKSUM_MISMATCH',
  );
  const pkg = runtimeProfile.runtimePackage;
  need(pkg, 'CURRENT_PLATFORM_TEST_PACKAGE_REQUIRED');
  need(
    runtimeProfile.distributionGeneration ===
      pkg.runtimeManifest.distributionGeneration,
    'CURRENT_PLATFORM_TEST_GENERATION_MISMATCH',
  );
  need(
    same(
      [...runtimeProfile.connectorRefs].sort(),
      [...definition.capabilities.connectorRefs].sort(),
    ),
    'CURRENT_PLATFORM_TEST_CONNECTOR_DECLARATION_MISMATCH',
  );
  const skills = validateCurrentDeclarativeRuntimePackage({
    runtimePackage: pkg,
    expectedChecksum: digest.parse(input.packageChecksum),
    declaration: {
      provider: runtimeProfile.provider,
      model: runtimeProfile.model,
      toolNames: runtimeProfile.toolNames,
      deniedCapabilities: runtimeProfile.securityPolicy.deniedCapabilities,
    },
  });
  need(
    same(skills, nativeSkills),
    'CURRENT_PLATFORM_TEST_NATIVE_SKILLS_MISMATCH',
  );
  // Keep the compiler's declared Skill set intact. A checksum-consistent
  // package must not introduce a Skill absent from its original definition.
  const declaredSkillIds = definition.capabilities.nativeSkillIds;
  need(
    new Set(declaredSkillIds).size === declaredSkillIds.length &&
      same(
        [...declaredSkillIds].sort(),
        skills.map((skill) => skill.id).sort(),
      ),
    'CURRENT_PLATFORM_TEST_SKILL_DECLARATION_MISMATCH',
  );
  const declaredTools = new Set(runtimeProfile.toolNames);
  need(
    skills.every((skill) =>
      skill.requiredToolRefs.every((name) => declaredTools.has(name)),
    ),
    'CURRENT_PLATFORM_TEST_SKILL_TOOL_DECLARATION_MISMATCH',
  );
  const source = PlatformTestExecutionSourceSchema.parse({
    kind: 'platform_test_snapshot',
    platformEmployeeId,
    platformRevisionId,
    purpose,
    definitionSchema: 1,
    definitionChecksum,
    definitionDigest: nativeRootDigest(input.definition),
    runtimeProfileDigest: nativeRootDigest(input.runtimeProfile),
    nativeSkillsDigest: nativeRootDigest(input.nativeSkills),
    capabilitySnapshotDigest: nativeRootDigest({
      capabilities: definition.capabilities,
      securityPolicy: definition.securityPolicy,
      approvedPluginIds: runtimeProfile.approvedPluginIds,
      skills,
    }),
    packageSchema: pkg.schemaVersion,
    packageChecksum: pkg.checksum,
    declaredGeneration: pkg.runtimeManifest.distributionGeneration,
  });
  const frozenSnapshotDigest = nativeRootDigest({
    definition: input.definition,
    definitionChecksum,
    runtimeProfile: input.runtimeProfile,
    nativeSkills: input.nativeSkills,
    packageChecksum: input.packageChecksum,
  });
  return { source, sourcePolicy: policyFor(source), frozenSnapshotDigest };
}

export const CurrentPlatformTestOriginSchema = z
  .object({
    schemaVersion: z.literal(2),
    contextKind: z.literal('platform_employee_test'),
    contextId: UuidSchema,
    rootSeed: UuidSchema,
    distributionGeneration: z.literal(newNativeGeneration),
    profileId: z.literal('restricted'),
    artifactId: digest,
    scope: ownerScope,
    birthSource: PlatformTestExecutionSourceSchema,
    sourcePolicy: PlatformTestExecutionPolicySchema,
  })
  .strict()
  .superRefine((origin, context) => {
    if (
      origin.rootSeed !== origin.contextId ||
      !same(origin.sourcePolicy, policyFor(origin.birthSource))
    )
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_PLATFORM_TEST_ORIGIN_INVALID',
      });
  });
export type CurrentPlatformTestOrigin = z.infer<
  typeof CurrentPlatformTestOriginSchema
>;
export type CurrentPlatformTestOriginInput = {
  scope: PlatformTestExecutionScope;
  source: PlatformTestExecutionSourceInput;
};
/** First INSERT only. No historical NULL/v1 upgrade and no fake Run identity. */
export function newCurrentPlatformTestOrigin(
  input: CurrentPlatformTestOriginInput,
): CurrentPlatformTestOrigin {
  const { testId, ...scope } = testScope.parse(input.scope);
  const { source, sourcePolicy } = validatePlatformTestExecutionSource(
    input.source,
  );
  const execution = readApprovedCurrentEmployeeExecution();
  return CurrentPlatformTestOriginSchema.parse({
    schemaVersion: 2,
    contextKind: 'platform_employee_test',
    contextId: testId,
    rootSeed: testId,
    scope,
    distributionGeneration: execution.generation,
    artifactId: execution.artifactId,
    profileId: execution.profileId,
    birthSource: source,
    sourcePolicy,
  });
}
/** Original identity readback only: later NEW_ROOT changes must not rebind an
 * existing test. Current lease/role/candidate authority is checked by SQL. */
export function assertCurrentPlatformTestOrigin(
  value: unknown,
  input: CurrentPlatformTestOriginInput,
): CurrentPlatformTestOrigin {
  return checkedOrigin(
    value,
    input.scope,
    validatePlatformTestExecutionSource(input.source),
  );
}
function checkedOrigin(
  value: unknown,
  expectedScope: PlatformTestExecutionScope,
  facts: ReturnType<typeof validatePlatformTestExecutionSource>,
): CurrentPlatformTestOrigin {
  const origin = CurrentPlatformTestOriginSchema.parse(value);
  const { testId, ...scope } = testScope.parse(expectedScope);
  const { source, sourcePolicy } = facts;
  need(
    origin.contextId === testId &&
      same(origin.scope, scope) &&
      same(origin.birthSource, source) &&
      same(origin.sourcePolicy, sourcePolicy),
    'CURRENT_PLATFORM_TEST_ORIGIN_SOURCE_MISMATCH',
  );
  return origin;
}

export const PlatformTestExecutionBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('current_platform_test_execution'),
    scope: testScope,
    originDigest: digest,
    source: PlatformTestExecutionSourceSchema,
    execution: CurrentEmployeeExecutionTupleSchema,
    sourcePolicy: PlatformTestExecutionPolicySchema,
    frozenSnapshotDigest: digest,
    digest,
  })
  .strict()
  .superRefine((binding, context) => {
    const { digest: expected, ...payload } = binding;
    if (
      nativeRootDigest(payload) !== expected ||
      !same(binding.sourcePolicy, policyFor(binding.source))
    )
      context.addIssue({
        code: 'custom',
        message: 'CURRENT_PLATFORM_TEST_EXECUTION_BINDING_INVALID',
      });
  });
export type PlatformTestExecutionBinding = z.infer<
  typeof PlatformTestExecutionBindingSchema
>;
export type PlatformTestExecutionBindingInput =
  CurrentPlatformTestOriginInput & { origin: unknown };
/** Durable test birth binding, not a Run/lease admission. SQL later joins the
 * actual Run execution_spec and Job; do not add their mutable IDs here. */
export function freezePlatformTestExecutionBinding(
  input: PlatformTestExecutionBindingInput,
): PlatformTestExecutionBinding {
  const scope = testScope.parse(input.scope);
  const facts = validatePlatformTestExecutionSource(input.source);
  const origin = checkedOrigin(input.origin, scope, facts);
  const { source, sourcePolicy, frozenSnapshotDigest } = facts;
  const payload = {
    schemaVersion: 1 as const,
    kind: 'current_platform_test_execution' as const,
    scope,
    originDigest: nativeRootDigest(origin),
    source,
    sourcePolicy,
    execution: {
      artifactId: origin.artifactId,
      generation: origin.distributionGeneration,
      profileId: origin.profileId,
    },
    frozenSnapshotDigest,
  };
  return PlatformTestExecutionBindingSchema.parse({
    ...payload,
    digest: nativeRootDigest(payload),
  });
}
/** No defaults/fallbacks. Caller must supply the persisted original origin and
 * snapshot in the exact authorized scope, never current draft/assignment. */
export function assertPlatformTestExecutionBinding(
  value: unknown,
  input: PlatformTestExecutionBindingInput,
): PlatformTestExecutionBinding {
  const binding = PlatformTestExecutionBindingSchema.parse(value);
  const expected = freezePlatformTestExecutionBinding(input);
  need(
    same(binding, expected),
    'CURRENT_PLATFORM_TEST_EXECUTION_BINDING_MISMATCH',
  );
  return binding;
}
